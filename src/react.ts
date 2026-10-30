/**
 * @farmjs/islx/react: islands for React. `createIsland` is what the compiler wraps client
 * components with; rendering lives in `@farmjs/islx/react/server`, hydration in
 * `@farmjs/islx/react/client`.
 */
export {
  IslandsProvider,
  createIsland,
  isolateIslands,
  withinClientRoot,
  type IslandRenderState,
} from "./react/island";
export type { IslandStrategy } from "./client/schedule";
/** Server trees, shared by the framework's server and browser code (server code needs `react/server` imported). */
export { renderServerTree, type ServerTreeRenderOptions } from "./react/tree";
