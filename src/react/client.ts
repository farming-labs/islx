/** @farmjs/islx/react/client: hydrating a page's React islands. */
export { createHydrationRuntime, type HydrationOptions, type HydrationRuntime } from "./hydrate";
export {
  HYDRATED_ATTRIBUTE,
  ISLAND_STRATEGIES,
  isIslandStrategy,
  scheduleHydration,
  type IslandStrategy,
  type ScheduleOptions,
} from "../client/schedule";
export { refreshDocument } from "./document";
