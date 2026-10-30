// @vitest-environment jsdom
import { act, useState } from "react";
import { renderToReadableStream } from "react-dom/server";
import { parseSync } from "oxc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PENDING_INTERACTIONS, PREHYDRATION_SCRIPT, getValueStore } from "@farmjs/islx/client";
import { IslandsProvider, createIsland } from "@farmjs/islx/react";
import { createHydrationRuntime, scheduleHydration } from "@farmjs/islx/react/client";
import "@farmjs/islx/react/server";
import { transformClientModule } from "../src/compiler/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Counter({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  return (
    <button data-label={label} onClick={() => setCount(count + 1)}>
      {label} {count}
    </button>
  );
}
const modules: Record<string, Record<string, unknown>> = { "/counter.tsx": { Counter } };

async function html(element: React.ReactNode) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

// The inline script, as a page runs it once before the browser entry.
new Function(PREHYDRATION_SCRIPT)();
const pending = () => (window as unknown as Record<string, unknown[]>)[PENDING_INTERACTIONS]!;

afterEach(() => {
  document.body.innerHTML = "";
  pending().length = 0;
  getValueStore().clear();
});

describe("interactions before the browser entry runs", () => {
  it("are held by the inline script and replayed once the island hydrates", async () => {
    for (const strategy of ["load", "interaction"] as const) {
      const Island = createIsland(Counter, "/counter.tsx", "Counter", strategy);
      document.body.innerHTML = await html(<Island label={strategy} />);
      const button = document.querySelector<HTMLButtonElement>(`[data-label=${strategy}]`)!;
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      button.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(pending()).toHaveLength(1);

      const runtime = createHydrationRuntime({
        load: async (src) => modules[src]!,
        schedule: scheduleHydration,
      });
      await act(async () => {
        await runtime.hydrate(document);
      });
      // The replay runs in a task after hydration: wait for it, not for a set time.
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(button.textContent).toBe(`${strategy} 1`);
      });
      expect(pending()).toHaveLength(0);
      runtime.dispose(document.body);
    }
  });

  it("leave clicks outside islands, and on hydrated ones, alone", async () => {
    const Island = createIsland(Counter, "/counter.tsx", "Counter");
    document.body.innerHTML = `<button id="plain">plain</button>${await html(<Island label="x" />)}`;
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    document.querySelector("#plain")!.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    document.querySelector("f-island")!.setAttribute("hydrated", "");
    const hydrated = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    document.querySelector("[data-label=x]")!.dispatchEvent(hydrated);
    expect(hydrated.defaultPrevented).toBe(false);
  });
});

describe("frameworks that render pages themselves", () => {
  it("give islands the render's held values through IslandsProvider", async () => {
    const Tree = createIsland(
      ({ items }: { items: string[] }) => <nav>{items.length}</nav>,
      "/tree.tsx",
      "Tree",
    );
    const items = Array.from({ length: 50 }, (_, index) => `entry number ${index} with some text`);
    const page = (held: Set<string> | null) => (
      <IslandsProvider held={held}>
        <Tree items={items} />
        <Tree items={items} />
      </IslandsProvider>
    );
    const first = await html(page(null));
    // Written once for both islands.
    const keys = [...first.matchAll(/type="f\/value" name="([0-9a-z]{14})"/g)].map(
      (match) => match[1]!,
    );
    expect(keys).toHaveLength(1);
    // A browser that holds it gets none.
    expect(await html(page(new Set(keys)))).not.toContain('type="f/value"');
  });

  it("set when islands hydrate from their own configuration", () => {
    const result = transformClientModule({
      code: '"use client";\nexport const hydrate = "idle";\nexport function Chart() {}\nexport function Legend() {}',
      id: "/app/src/chart.tsx",
      root: "/app",
      parse: (source) => parseSync("chart.tsx", source).program as any,
      reference: (relative) => JSON.stringify(relative),
      strategy: (name) => (name === "Chart" ? "visible" : undefined),
    })!;
    expect(result.islands).toEqual([
      { exportName: "Chart", strategy: "visible" },
      { exportName: "Legend", strategy: "idle" },
    ]);
  });
});

describe("a framework's own request store", () => {
  it("gives islands the render state when no provider does", async () => {
    const { setRenderStateResolver } = await import("@farmjs/islx/react/server");
    const Tree = createIsland(
      ({ items }: { items: string[] }) => <nav>{items.length}</nav>,
      "/t.tsx",
      "T",
    );
    const items = Array.from({ length: 50 }, (_, index) => `entry number ${index} with some text`);
    const sent = new Set<string>();
    let held: Set<string> | null = null;
    setRenderStateResolver(() => ({ held, sent }));
    try {
      const first = await html(
        <>
          <Tree items={items} />
          <Tree items={items} />
        </>,
      );
      const keys = [...first.matchAll(/type="f\/value" name="([0-9a-z]{14})"/g)].map(
        (match) => match[1]!,
      );
      expect(keys).toHaveLength(1);
      sent.clear();
      held = new Set(keys);
      expect(await html(<Tree items={items} />)).not.toContain('type="f/value"');
    } finally {
      setRenderStateResolver(undefined);
    }
  });
});
