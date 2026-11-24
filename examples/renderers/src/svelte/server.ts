import { render } from "svelte/server";
import type { ServerRenderer } from "../counter";
import Counter from "./Counter.svelte";

export const svelte: ServerRenderer = {
  export: "default",
  render: (props) => render(Counter, { props }).body,
};
