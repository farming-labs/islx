import { createSignal } from "solid-js";
import type { CounterProps } from "../counter";

export function Counter(props: CounterProps) {
  const [count, setCount] = createSignal(props.start);
  return (
    <>
      <button type="button" data-testid={props.label} onClick={() => setCount(count() + 1)}>
        {props.label} {count()}
      </button>
      <output data-testid={`${props.label}-props`}>
        {props.since.toISOString()} a={props.tags.get("a")}
      </output>
    </>
  );
}
