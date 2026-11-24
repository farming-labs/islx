import {
  createIslandRuntime,
  defineIslandRenderer,
  scheduleHydration,
} from "@farm.js/islx/islands/client";
import { h, hydrate, render, type ComponentType } from "preact";
import { moduleLoader } from "../counter";

const renderer = defineIslandRenderer({
  hydrate(container, Component, props) {
    hydrate(h(Component as ComponentType, props), container);
    return { unmount: () => render(null, container) };
  },
});

createIslandRuntime({
  renderer,
  load: moduleLoader({ "/preact/counter": () => import("./counter") }),
  schedule: scheduleHydration,
}).hydrate();
