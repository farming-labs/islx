// @vitest-environment jsdom
import { act, createElement as h, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The reviver's loads. Each test loads islx anew (see `load`), so a load is the test's own: an
// earlier test's load does not count, nor hide one.
const reviver = { loads: 0 };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Stamp({ at, label }: { at: Date | string; label: string }) {
  const [clicks, setClicks] = useState(0);
  const text = at instanceof Date ? at.toISOString() : at;
  return h(
    "button",
    { "data-stamp": "", onClick: () => setClicks(clicks + 1) },
    `${label} ${text} ${clicks}`,
  );
}

/** islx as a page loads it, from a registry of its own. */
async function load() {
  vi.resetModules();
  vi.doMock("../src/react/revive", async (importOriginal) => {
    reviver.loads++;
    return importOriginal();
  });
  const [{ createIsland }, client, { renderToStream }] = await Promise.all([
    import("@farm.js/islx/react"),
    import("@farm.js/islx/react/client"),
    import("@farm.js/islx/react/server"),
  ]);
  const StampIsland = createIsland(Stamp, "/src/stamp.tsx", "Stamp");
  const page = async (props: { at: Date | string; label: string }) => {
    const element: ReactNode = h("div", { id: "page" }, h(StampIsland, props));
    const stream = await renderToStream(element);
    await stream.allReady;
    return new Response(stream).text();
  };
  const runtime = client.createHydrationRuntime({
    load: async () => ({ Stamp }),
    schedule: client.scheduleHydration,
  });
  return { page, runtime };
}

const stamp = () => document.querySelector<HTMLButtonElement>("[data-stamp]")!;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the reviver", () => {
  it("does not load for a page whose islands take plain props", async () => {
    const before = reviver.loads;
    const { page, runtime } = await load();
    document.body.innerHTML = await page({ at: "plain", label: "a" });
    await act(async () => runtime.hydrate(document));
    expect(runtime.rootCount()).toBe(1);
    await act(async () => stamp().click());
    expect(stamp().textContent).toBe("a plain 1");
    expect(reviver.loads).toBe(before);
  });

  it("loads for props that need reviving, before their island hydrates", async () => {
    const before = reviver.loads;
    const { page, runtime } = await load();
    document.body.innerHTML = await page({ at: new Date(0), label: "b" });
    await act(async () => runtime.hydrate(document));
    expect(reviver.loads).toBe(before + 1);
    expect(runtime.rootCount()).toBe(1);
    await act(async () => stamp().click());
    expect(stamp().textContent).toBe("b 1970-01-01T00:00:00.000Z 1");
  });

  it("revives the props an island takes over a refresh, when it loads with them", async () => {
    const before = reviver.loads;
    const { page, runtime } = await load();
    document.body.innerHTML = await page({ at: "plain", label: "c" });
    await act(async () => runtime.hydrate(document));
    await act(async () => stamp().click());
    expect(reviver.loads).toBe(before);
    const next = document.createElement("div");
    next.innerHTML = await page({ at: new Date(0), label: "c" });
    const current = document.querySelector("#page")!;
    await act(async () => {
      expect(runtime.carryOver(current, next)).toBe(1);
      current.replaceWith(next.firstElementChild!);
    });
    // The live island kept its state, and takes its new props once the reviver has loaded.
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(stamp().textContent).toBe("c 1970-01-01T00:00:00.000Z 1");
    });
    expect(reviver.loads).toBe(before + 1);
    expect(runtime.rootCount()).toBe(1);
  });
});
