import {
  createIslandRuntime,
  defineIslandRenderer,
  scheduleHydration,
} from "@farm.js/islx/islands/client";
import { createSSRApp, type Component } from "vue";
import { moduleLoader } from "../counter";

const renderer = defineIslandRenderer({
  hydrate(container, Component, props) {
    const app = createSSRApp(Component as Component, props);
    app.mount(container);
    return { unmount: () => app.unmount() };
  },
});

createIslandRuntime({
  renderer,
  load: moduleLoader({ "/vue/counter": () => import("./Counter.vue") }),
  schedule: scheduleHydration,
}).hydrate();
