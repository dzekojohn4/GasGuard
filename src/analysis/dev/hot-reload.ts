/**
 * Hot Reload for Rule Development (#266).
 *
 * Wires the existing `ScanWatcher` (file-system event source) to the existing
 * `DynamicRuleLoader` (rule cache + dynamic import), giving plugin authors a
 * tight edit-save-rerun loop without restarting the analysis process.
 *
 * On a watched plugin file change:
 *   1. Resolve which rule id(s) the file belongs to (from `RuleSource` map).
 *   2. Invalidate every cached version of those rules.
 *   3. Optionally re-load the rule immediately so the next analysis run hits
 *      a warm cache.
 *   4. Emit a `ruleReloaded` event so the running engine can pick up the new
 *      definition.
 *
 * Unwatched on shutdown so `Ctrl+C` exits cleanly.
 */

import { EventEmitter } from 'events';
import path from 'path';

import { ScanWatcher } from '../watch/watcher';
import { DynamicRuleLoader } from '../loader/dynamic-loader';
import type { RuleConfiguration } from '../../config/config.types';

/**
 * Maps a source file path → rule configuration. The hot-reloader uses this to
 * translate a file-change event into the rule id(s) it should invalidate.
 *
 * Callers populate this map either explicitly (manual registration) or by
 * scanning plugin manifests at startup.
 */
export type RuleSource = Map<string, RuleConfiguration>;

export interface HotReloadOptions {
  /** Absolute path to the directory containing plugin source files. */
  pluginsDir: string;
  /** Initial mapping from plugin file path → rule config. */
  ruleSources?: RuleSource;
  /** Debounce multi-write storms (e.g. atomic save). Default: 150ms. */
  debounceMs?: number;
  /** Eagerly re-load the rule after invalidation so the next call is warm. Default: true. */
  eagerReload?: boolean;
  /** Predicate to skip files. Default: ignore `node_modules`, dotfiles, and `dist/`. */
  ignored?: (filePath: string) => boolean;
}

export interface RuleReloadedEvent {
  ruleId: string;
  filePath: string;
  durationMs: number;
}

export interface RuleSourceMissingEvent {
  filePath: string;
}

function defaultIgnored(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  return (
    segments.includes('node_modules') ||
    segments.includes('dist') ||
    segments.some((s) => s.startsWith('.'))
  );
}

/**
 * Watches a plugin directory and refreshes the rule cache when files change.
 *
 * Events emitted:
 *   - `ruleReloaded` ({@link RuleReloadedEvent})
 *   - `ruleSourceMissing` ({@link RuleSourceMissingEvent}) — file changed but no
 *     rule config registered for it; usually a missed `register()` call.
 *   - `error` (Error)
 */
export class RuleHotReloader extends EventEmitter {
  private readonly watcher: ScanWatcher;
  private readonly loader: DynamicRuleLoader;
  private readonly sources: RuleSource;
  private readonly options: Required<Omit<HotReloadOptions, 'ruleSources'>>;
  private active = false;

  constructor(loader: DynamicRuleLoader, options: HotReloadOptions) {
    super();
    this.loader = loader;
    this.sources = options.ruleSources ?? new Map();
    this.options = {
      pluginsDir: options.pluginsDir,
      debounceMs: options.debounceMs ?? 150,
      eagerReload: options.eagerReload ?? true,
      ignored: options.ignored ?? defaultIgnored,
    };
    this.watcher = new ScanWatcher(options.pluginsDir, {
      debounceMs: this.options.debounceMs,
      ignored: this.options.ignored,
    });
  }

  /** Register (or replace) the rule config a given plugin file produces. */
  register(filePath: string, config: RuleConfiguration): void {
    this.sources.set(path.resolve(filePath), config);
  }

  /** Drop a registered file from the source map. Returns true if it was present. */
  unregister(filePath: string): boolean {
    return this.sources.delete(path.resolve(filePath));
  }

  /** Number of files currently mapped to a rule config. */
  size(): number {
    return this.sources.size;
  }

  /** Begin watching. Idempotent. */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.watcher.watch((filePath) => this.handleChange(filePath).catch((err) => this.emit('error', err)));
  }

  /** Stop watching and release file descriptors. Idempotent. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.watcher.stop();
  }

  private async handleChange(filePath: string): Promise<void> {
    const resolved = path.resolve(filePath);
    const config = this.sources.get(resolved);
    if (!config) {
      const event: RuleSourceMissingEvent = { filePath: resolved };
      this.emit('ruleSourceMissing', event);
      return;
    }

    const start = Date.now();
    // Drop every cached version of this rule — a code change might
    // semantically affect any version, and re-loading the active one alone is
    // cheap.
    this.loader.invalidateRulesById(config.id);

    if (this.options.eagerReload) {
      const reloaded = await this.loader.loadRule(config);
      if (reloaded === null) {
        this.emit('error', new Error(`Hot reload failed for rule ${config.id}`));
        return;
      }
    }

    const event: RuleReloadedEvent = {
      ruleId: config.id,
      filePath: resolved,
      durationMs: Date.now() - start,
    };
    this.emit('ruleReloaded', event);
  }
}
