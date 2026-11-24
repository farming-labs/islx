import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import type { ServerRenderer } from "../counter";
import Counter from "./Counter.vue";

export const vue: ServerRenderer = {
  export: "default",
  render: (props) => renderToString(createSSRApp(Counter, { ...props })),
};
