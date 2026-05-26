/**
 * Dynamic Rule Loader & Cache
 * 
 * Loads rules on demand and caches them to improve performance
 */

import { RuleConfiguration } from '../../config/config.types';

export interface RuleModule {
  id: string;
  version: string;
  execute: (context: any) => Promise<any>;
}

export class RuleCache {
  private cache: Map<string, RuleModule> = new Map();

  get(id: string, version: string): RuleModule | undefined {
    return this.cache.get(`${id}@${version}`);
  }

  set(id: string, version: string, module: RuleModule): void {
    this.cache.set(`${id}@${version}`, module);
  }

  /** Drop a single (id, version) entry. Returns true if it was cached. */
  delete(id: string, version: string): boolean {
    return this.cache.delete(`${id}@${version}`);
  }

  /** Drop every entry that matches the given rule id, ignoring version. */
  deleteById(id: string): number {
    let removed = 0;
    const prefix = `${id}@`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.cache.clear();
  }
}

export class DynamicRuleLoader {
  private cache: RuleCache = new RuleCache();

  /**
   * Load a rule on demand
   */
  async loadRule(config: RuleConfiguration): Promise<RuleModule | null> {
    const cached = this.cache.get(config.id, config.version);
    if (cached) {
      return cached;
    }

    try {
      console.log(`Dynamically loading rule: ${config.id}@${config.version}`);
      
      // In a real implementation, this would involve dynamic import()
      // For now, we simulate the loading process
      const module: RuleModule = {
        id: config.id,
        version: config.version,
        execute: async (context: any) => {
          console.log(`Executing rule ${config.id}`);
          return { success: true };
        }
      };

      this.cache.set(config.id, config.version, module);
      return module;
    } catch (error) {
      console.error(`Failed to load rule ${config.id}:`, error);
      return null;
    }
  }

  /**
   * Preload a set of rules
   */
  async preloadRules(configs: RuleConfiguration[]): Promise<void> {
    await Promise.all(configs.map(config => this.loadRule(config)));
  }

  /**
   * Drop a specific (id, version) from the cache so the next `loadRule` call
   * re-imports it. Returns true if the entry was present.
   */
  invalidateRule(id: string, version: string): boolean {
    return this.cache.delete(id, version);
  }

  /** Drop every cached version of `id`. Used when a plugin file changes on disk. */
  invalidateRulesById(id: string): number {
    return this.cache.deleteById(id);
  }

  /**
   * Force a fresh load of the given rule by invalidating any cached entry
   * first. Convenience wrapper used by the hot-reload pipeline.
   */
  async reloadRule(config: RuleConfiguration): Promise<RuleModule | null> {
    this.cache.delete(config.id, config.version);
    return this.loadRule(config);
  }
}
