import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Adapter, AdapterDescription, AdapterModule } from '../adapter/types.js';
import type { TargetConfig } from '../schema/target.js';
import { errorMessage, MutationWorkflowError } from '../util/errors.js';
import type { Logger } from '../util/logger.js';

export type AdapterLoader = () => Promise<AdapterModule | { default: AdapterModule }>;

/**
 * Resolves and caches adapters per target. Built-in kinds are registered by the CLI package;
 * anything else is treated as a package name resolved from the project root, so third-party
 * adapters are just dependencies of the project under test.
 */
export class AdapterRegistry {
  private readonly loaders = new Map<string, AdapterLoader>();
  private readonly instances = new Map<string, Promise<Adapter>>();

  constructor(private readonly options: { rootDir: string; logger: Logger }) {}

  register(name: string, loader: AdapterLoader): this {
    this.loaders.set(name, loader);
    return this;
  }

  has(name: string): boolean {
    return this.loaders.has(name);
  }

  forTarget(target: TargetConfig): Promise<Adapter> {
    const existing = this.instances.get(target.id);
    if (existing) return existing;
    const created = this.create(target);
    this.instances.set(target.id, created);
    created.catch(() => this.instances.delete(target.id));
    return created;
  }

  /** Vocabularies of the registered adapters that export a target-free `describe`. */
  async describeRegistered(): Promise<AdapterDescription[]> {
    const descriptions: AdapterDescription[] = [];
    for (const [name, loader] of this.loaders) {
      try {
        const loaded = await loader();
        const module = 'createAdapter' in loaded ? loaded : loaded.default;
        const description = module.describe?.();
        if (description) descriptions.push(description);
        else this.options.logger.debug(`Adapter "${name}" has no target-free describe()`);
      } catch (error) {
        this.options.logger.warn(`Could not load adapter "${name}": ${errorMessage(error)}`);
      }
    }
    return descriptions;
  }

  async disposeAll(): Promise<void> {
    const pending = [...this.instances.values()];
    this.instances.clear();
    await Promise.all(
      pending.map((promise) =>
        promise.then(
          (adapter) => adapter.dispose(),
          () => undefined,
        ),
      ),
    );
  }

  private async create(target: TargetConfig): Promise<Adapter> {
    const name = target.adapter ?? target.kind;
    const loader = this.loaders.get(name) ?? (() => this.importPackage(name));
    let loaded: AdapterModule | { default: AdapterModule };
    try {
      loaded = await loader();
    } catch (error) {
      throw new MutationWorkflowError(
        'ADAPTER_NOT_FOUND',
        `Could not load adapter "${name}" for target "${target.id}": ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const module = 'createAdapter' in loaded ? loaded : loaded.default;
    if (typeof module?.createAdapter !== 'function') {
      throw new MutationWorkflowError(
        'ADAPTER_NOT_FOUND',
        `Adapter "${name}" does not export createAdapter`,
      );
    }
    return module.createAdapter({
      target,
      rootDir: this.options.rootDir,
      logger: this.options.logger.child(`adapter:${target.id}`),
    });
  }

  private async importPackage(name: string): Promise<AdapterModule | { default: AdapterModule }> {
    try {
      // Works for flat node_modules layouts (npm, yarn) and hoisted pnpm installs.
      return (await import(name)) as AdapterModule | { default: AdapterModule };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    // Resolve from the project under test, where third-party adapters are installed.
    const require = createRequire(`${this.options.rootDir}/`);
    const resolved = require.resolve(name);
    return (await import(pathToFileURL(resolved).href)) as
      | AdapterModule
      | { default: AdapterModule };
  }
}
