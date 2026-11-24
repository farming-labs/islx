import { Fragment, h } from "preact";
import { useState } from "preact/hooks";
import type { CounterProps } from "../counter";

export function Counter({ label, start, since, tags }: CounterProps) {
  const [count, setCount] = useState(start);
  return h(
    Fragment,
    null,
    h(
      "button",
      { type: "button", "data-testid": label, onClick: () => setCount(count + 1) },
      `${label} ${count}`,
    ),
    h("output", { "data-testid": `${label}-props` }, `${since.toISOString()} a=${tags.get("a")}`),
  );
}
