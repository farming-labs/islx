// Hot updates reach mounted server trees. Shared through globalThis, so a tree and the island
// runtime see one registry even when the bundler gives them separate copies of this module. Kept
// apart from the trees (`./tree`), so the island runtime updates them without loading them.

/** @internal Re-renders a mounted tree's uses of `src`; true when it rendered again. */
export type TreeUpdateListener = (src: string, module: Record<string, unknown>) => boolean;

const TREE_UPDATES = Symbol.for("islx.react.tree-updates");

/** @internal */
export function treeListeners(): Set<TreeUpdateListener> {
  const scope = globalThis as typeof globalThis &
    Record<symbol, Set<TreeUpdateListener> | undefined>;
  return (scope[TREE_UPDATES] ??= new Set());
}

/** Re-renders mounted server trees that render a hot-updated client module. */
export function updateServerTrees(src: string, module: Record<string, unknown>): number {
  let updated = 0;
  for (const listener of treeListeners()) if (listener(src, module)) updated++;
  return updated;
}
