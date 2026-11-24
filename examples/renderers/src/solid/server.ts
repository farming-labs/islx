import { createComponent, generateHydrationScript, renderToString } from "solid-js/web";
import type { ServerRenderer } from "../counter";
import { Counter } from "./Counter";

export const solid: ServerRenderer = {
  export: "Counter",
  // Solid's page bootstrap: once per document, before any island.
  head: generateHydrationScript(),
  // Solid's hydration keys are page-wide: each island renders under its own id.
  render: (props, id) => renderToString(() => createComponent(Counter, props), { renderId: id }),
};
