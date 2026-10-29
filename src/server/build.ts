/**
 * What a bundler plugin knows about the build, for the server runtime: the browser entry that
 * hydrates islands, and the key a build seals action values with when the environment sets none.
 * Set from the plugin's runtime module, which every module with islands or actions imports.
 */
export interface BuildDefaults {
  /** The URL of the browser entry `renderToStream` adds to pages. */
  entry?: string;
  /** A key made for this build: every instance of one build shares it. */
  key?: string;
  /**
   * The browser files each client module needs (its chunk first, then the chunks it imports), by
   * the module's path from the root: an island preloads them, so they load alongside the entry.
   */
  modules?: Record<string, string[]>;
}

const BUILD_KEY = Symbol.for("islx.build");

export function setBuildDefaults(defaults: BuildDefaults): void {
  (globalThis as typeof globalThis & Record<symbol, BuildDefaults>)[BUILD_KEY] = defaults;
}

export function getBuildDefaults(): BuildDefaults {
  return (
    (globalThis as typeof globalThis & Record<symbol, BuildDefaults | undefined>)[BUILD_KEY] ?? {}
  );
}
