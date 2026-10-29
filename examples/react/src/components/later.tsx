"use client";
import { useState } from "react";

export const hydrate = { Later: "visible", OnClick: "interaction" } as const;

export function Later() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="later" onClick={() => setCount(count + 1)}>
      later {count}
    </button>
  );
}

export function OnClick() {
  const [count, setCount] = useState(0);
  return (
    <button data-testid="on-click" onClick={() => setCount(count + 1)}>
      on click {count}
    </button>
  );
}
