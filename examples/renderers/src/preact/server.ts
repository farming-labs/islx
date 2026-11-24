import { h } from "preact";
import { renderToString } from "preact-render-to-string";
import type { ServerRenderer } from "../counter";
import { Counter } from "./counter";

export const preact: ServerRenderer = {
  export: "Counter",
  render: (props) => renderToString(h(Counter, props)),
};
