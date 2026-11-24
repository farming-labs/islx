import {
  createIslandRuntime,
  defineIslandRenderer,
  scheduleHydration,
} from "@farm.js/islx/islands/client";
import { hydrate, unmount, type Component } from "svelte";
import { moduleLoader } from "../counter";

const renderer = defineIslandRenderer({
  hydrate(container, Component, props) {
    const instance = hydrate(Component as Component<Record<string, unknown>>, {
      target: container,
      props,
    });
    return { unmount: () => void unmount(instance) };
  },
});

createIslandRuntime({
  renderer,
  load: moduleLoader({ "/svelte/counter": () => import("./Counter.svelte") }),
  schedule: scheduleHydration,
}).hydrate();
