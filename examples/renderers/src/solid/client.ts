import {
  createIslandRuntime,
  defineIslandRenderer,
  scheduleHydration,
} from "@farm.js/islx/islands/client";
import type { Component } from "solid-js";
import { createComponent, hydrate } from "solid-js/web";
import { moduleLoader } from "../counter";

const renderer = defineIslandRenderer({
  hydrate(container, Component, props, island) {
    const dispose = hydrate(
      () => createComponent(Component as Component<Record<string, unknown>>, props),
      container,
      { renderId: island.id },
    );
    return { unmount: dispose };
  },
});

createIslandRuntime({
  renderer,
  load: moduleLoader({ "/solid/counter": () => import("./Counter") }),
  schedule: scheduleHydration,
}).hydrate();
