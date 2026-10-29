"use client";
import { useState, type ReactNode } from "react";

export function Panel({ title, children }: { title: string; children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section>
      <button data-testid="toggle" onClick={() => setOpen(!open)}>
        {title}
      </button>
      {open ? children : null}
    </section>
  );
}
