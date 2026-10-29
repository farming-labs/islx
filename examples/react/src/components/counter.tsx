"use client";
import { useState } from "react";

export function Counter({ start, label }: { start: number; label: string }) {
  const [count, setCount] = useState(start);
  return (
    <button data-testid={label} onClick={() => setCount(count + 1)}>
      {label} {count}
    </button>
  );
}

export function Typed({ at, stock, id }: { at: Date; stock: Map<string, number>; id: bigint }) {
  return (
    <output data-testid="typed">
      {at.toISOString()} {[...stock].map(([key, value]) => `${key}=${value}`).join(",")}{" "}
      {(id + 1n).toString()}
    </output>
  );
}
