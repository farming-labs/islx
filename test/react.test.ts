// @vitest-environment jsdom
import {
  Suspense,
  act,
  cloneElement,
  isValidElement,
  createContext,
  useContext,
  createElement as h,
  use,
  useActionState,
  useEffect,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIsland, useFormStatus } from "@farm.js/islx/react";
import {
  createHydrationRuntime,
  endStreamedContent,
  scheduleHydration,
} from "@farm.js/islx/react/client";
import { renderToStream } from "@farm.js/islx/react/server";
import { createTemporaryReferences } from "../src/server/temporary";
import { enhanceForms, getValueStore } from "@farm.js/islx/client";
import {
  configureActionKeys,
  generateActionKey,
  handleAction,
  registerInlineAction,
  registerServerReference,
  bindInlineAction,
} from "@farm.js/islx/server";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeAll(() => configureActionKeys({ key: generateActionKey() }));
/** console.error calls, except React's warning that server and client render in one process. */
function spyErrors() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  return () =>
    spy.mock.calls.filter(([message]) => !String(message).includes("multiple renderers"));
}

afterEach(() => {
  document.body.innerHTML = "";
  getValueStore().clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function html(element: ReactNode, options: Parameters<typeof renderToStream>[1] = {}) {
  const stream = await renderToStream(element, options);
  await stream.allReady;
  return new Response(stream).text();
}

// --- Client components, as the browser build has them, and their server islands ---------------

function Counter({ start, label }: { start: number; label: string }) {
  const [count, setCount] = useState(start);
  return h(
    "button",
    { "data-counter": label, onClick: () => setCount(count + 1) },
    `${label} ${count}`,
  );
}
function Shows(props: Record<string, any>) {
  return h("output", null, `${props.at.toISOString()} ${[...props.tags].join(",")} ${props.id}`);
}
function Panel({ title, children }: { title: string; children?: ReactNode }) {
  const [open, setOpen] = useState(true);
  return h(
    "section",
    null,
    h("button", { "data-toggle": "", onClick: () => setOpen(!open) }, title),
    open ? children : null,
  );
}
function Inner() {
  return h("i", null, "inner");
}
const InnerIsland = createIsland(Inner, "/src/inner.tsx", "Inner");
function Outer() {
  return h("div", null, h(InnerIsland));
}

// Suspends while the server renders, until `gate` opens; the browser has the text already.
let gate: Promise<void> = Promise.resolve();
let serverRendering = false;
function Late() {
  if (serverRendering) use(gate);
  return h("q", null, "streamed");
}
function Waits() {
  const [likes, setLikes] = useState(0);
  return h(
    "div",
    null,
    h(Suspense, { fallback: h("i", null, "loading") }, h(Late)),
    h("button", { "data-like": "", onClick: () => setLikes(likes + 1) }, `likes ${likes}`),
  );
}

function QuoteText({ quote }: { quote: Promise<{ text: string }> }) {
  return h("q", null, use(quote).text);
}
function Quote({ quote }: { quote: Promise<{ text: string }> }) {
  const [likes, setLikes] = useState(0);
  return h(
    "div",
    null,
    h(Suspense, { fallback: h("i", null, "loading") }, h(QuoteText, { quote })),
    h("button", { "data-like": "", onClick: () => setLikes(likes + 1) }, `likes ${likes}`),
  );
}
const received: Array<Promise<unknown>> = [];
function Keeps({ value }: { value: Promise<unknown> }) {
  received.push(value);
  return h("span", null, "kept");
}

function Field({ label }: { label: string }) {
  const id = useId();
  const [held, setHeld] = useState("");
  useEffect(() => setHeld(id), [id]);
  return h(
    "p",
    null,
    h("label", { htmlFor: id }, label),
    h("input", { id }),
    h("output", { "data-held": label }, held),
  );
}
function Tabs({ panels }: { panels: ReactNode[] }) {
  const [active, setActive] = useState(0);
  return h(
    "div",
    null,
    h("button", { "data-next": "", onClick: () => setActive(active + 1) }, "next"),
    h("div", { "data-panel": "" }, panels[active]),
  );
}

const Theme = createContext({ theme: "none", toggle: () => {} });
function ThemeProvider({ children }: { children?: ReactNode }) {
  const [theme, setTheme] = useState("light");
  return h(
    Theme.Provider,
    { value: { theme, toggle: () => setTheme(theme === "light" ? "dark" : "light") } },
    h(
      "button",
      { "data-theme-toggle": "", onClick: () => setTheme(theme === "light" ? "dark" : "light") },
      "toggle",
    ),
    children,
  );
}
function ThemeLabel() {
  return h("output", { "data-theme": "" }, useContext(Theme).theme);
}
async function ServerSection({ children }: { children?: ReactNode }) {
  await Promise.resolve();
  return h("article", null, h("p", null, "server text"), children);
}

// Clones its server child, as \`asChild\` components (Radix's Slot) do: the props land on the child.
function Trigger({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return cloneElement(children as ReactElement<Record<string, unknown>>, {
    className: "trigger",
    "data-state": open ? "open" : "closed",
    onClick: () => setOpen((value) => !value),
  });
}

const modules: Record<string, Record<string, unknown>> = {
  "/src/trigger.tsx": { Trigger },
  "/src/counter.tsx": { Counter },
  "/src/waits.tsx": { Waits },
  "/src/quote.tsx": { Quote },
  "/src/keeps.tsx": { Keeps },
  "/src/shows.tsx": { Shows },
  "/src/panel.tsx": { Panel },
  "/src/outer.tsx": { Outer },
  "/src/field.tsx": { Field },
  "/src/tabs.tsx": { Tabs },
  "/src/theme.tsx": { ThemeProvider, ThemeLabel },
};
const CounterIsland = createIsland(Counter, "/src/counter.tsx", "Counter");
const TriggerIsland = createIsland(Trigger, "/src/trigger.tsx", "Trigger");
const ShowsIsland = createIsland(Shows, "/src/shows.tsx", "Shows");
function Cycle({ node, map, set, again }: Record<string, any>) {
  const [clicks, setClicks] = useState(0);
  const checks = [
    node.self === node,
    node.children[0].parent === node,
    map.get("me") === map,
    [...set][0][0] === set,
    again.self === again && again.big.length === 600,
  ];
  return h(
    "button",
    { "data-cycle": "", onClick: () => setClicks(clicks + 1) },
    `${node.name} ${checks.join(" ")} ${clicks}`,
  );
}
modules["/src/cycle.tsx"] = { Cycle };
const CycleIsland = createIsland(Cycle, "/src/cycle.tsx", "Cycle");
const PanelIsland = createIsland(Panel, "/src/panel.tsx", "Panel");
const OuterIsland = createIsland(Outer, "/src/outer.tsx", "Outer");
const WaitsIsland = createIsland(Waits, "/src/waits.tsx", "Waits");
const QuoteIsland = createIsland(Quote, "/src/quote.tsx", "Quote");
const KeepsIsland = createIsland(Keeps, "/src/keeps.tsx", "Keeps");
const FieldIsland = createIsland(Field, "/src/field.tsx", "Field");
// A browser build that keeps the wrapper: the export the runtime hydrates is the island itself.
const wrappedModules: Record<string, Record<string, unknown>> = {
  "/src/field.tsx": { Field: FieldIsland },
};
const TabsIsland = createIsland(Tabs, "/src/tabs.tsx", "Tabs");
const ThemeProviderIsland = createIsland(ThemeProvider, "/src/theme.tsx", "ThemeProvider");
const ThemeLabelIsland = createIsland(ThemeLabel, "/src/theme.tsx", "ThemeLabel");

function runtime(extra: Partial<Parameters<typeof createHydrationRuntime>[0]> = {}) {
  return createHydrationRuntime({
    load: async (src) => modules[src]!,
    schedule: scheduleHydration,
    ...extra,
  });
}

async function mount(
  markup: string,
  extra: Partial<Parameters<typeof createHydrationRuntime>[0]> = {},
) {
  document.body.innerHTML = markup;
  const islands = runtime(extra);
  await act(async () => islands.hydrate(document));
  return islands;
}

describe("islands", () => {
  it("render as server HTML with their props after them, and hydrate", async () => {
    const markup = await html(
      h("main", null, h("h1", null, "Server"), h(CounterIsland, { start: 2, label: "a" })),
    );
    expect(markup).toContain('<f-island src="/src/counter.tsx" export="Counter" props="');
    expect(markup).toContain('strategy="load"');
    expect(markup).toMatch(
      /<script type="f\/props" for="[^"]+" ids="[^"]+">\{"start":2,"label":"a"\}<\/script>/,
    );
    const islands = await mount(markup);
    expect(islands.rootCount()).toBe(1);
    expect(document.querySelector("f-island")!.hasAttribute("hydrated")).toBe(true);
    const button = document.querySelector<HTMLButtonElement>("[data-counter=a]")!;
    await act(async () => button.click());
    expect(button.textContent).toBe("a 3");
  });

  it("receive the types the server passed", async () => {
    const markup = await html(
      h(ShowsIsland, {
        at: new Date("2026-10-29T00:00:00.000Z"),
        tags: new Set(["x", "y"]),
        id: 9007199254740993n,
      }),
    );
    const errors = spyErrors();
    await mount(markup);
    expect(errors()).toEqual([]);
    expect(document.querySelector("output")!.textContent).toBe(
      "2026-10-29T00:00:00.000Z x,y 9007199254740993",
    );
  });

  it("keep server output passed as children, which stays server HTML", async () => {
    const markup = await html(
      h(PanelIsland, { title: "More" }, h("p", { "data-server": "" }, "rendered on the server")),
    );
    expect(markup).toContain('<f-slot name="');
    await mount(markup);
    expect(document.querySelector("[data-server]")!.textContent).toBe("rendered on the server");
    await act(async () => document.querySelector<HTMLButtonElement>("[data-toggle]")!.click());
    expect(document.querySelector("[data-server]")).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>("[data-toggle]")!.click());
    expect(document.querySelector("[data-server]")!.textContent).toBe("rendered on the server");
  });

  it("give the server child the props a client component clones onto it", async () => {
    const errors = spyErrors();
    const markup = await html(
      h(TriggerIsland, null, h("button", { type: "button", className: "own" }, "Open")),
    );
    expect(markup).toContain(
      '<button type="button" class="trigger own" data-state="closed">Open</button>',
    );
    await mount(markup);
    const button = document.querySelector("button")!;
    expect(document.querySelector("f-slot")!.hasAttribute("class")).toBe(false);
    await act(async () => button.click());
    expect(document.querySelector("button")).toBe(button);
    expect(button.getAttribute("data-state")).toBe("open");
    expect(button.className).toBe("trigger own");
    expect(button.textContent).toBe("Open");
    expect(errors()).toEqual([]);
  });

  it("send a shared value once, and not at all to a browser that holds it", async () => {
    const tree = Array.from({ length: 40 }, (_, index) => ({
      title: `Page ${index} about rendering`,
      href: `/docs/${index}`,
    }));
    const page = h("div", null, h(ShowsTree, { tree }), h(ShowsTreeIsland, { tree }));
    const markup = await html(page);
    expect(markup.match(/type="f\/value"/g)?.length).toBe(1);
    await mount(markup);
    const held = getValueStore().heldHeader()!;
    const again = await html(page, {
      request: new Request("https://app.test/", { headers: { "F-Values": held } }),
    });
    expect(again).not.toContain('type="f/value"');
  });

  it("share one decoded value between the islands that received it", async () => {
    const tree = Array.from({ length: 40 }, (_, index) => ({
      title: `Page ${index} about rendering`,
      href: `/docs/${index}`,
      updated: new Date(Date.UTC(2026, 9, index + 1)),
    }));
    const seen: unknown[] = [];
    modules["/src/seen.tsx"] = {
      SeenTree({ tree }: { tree: unknown }) {
        seen.push(tree);
        return h("nav", null, "tree");
      },
    };
    const markup = await html(
      h("div", null, h(SeenTreeIsland, { tree }), h(SeenTreeIsland, { tree })),
    );
    expect(markup.match(/type="f\/value"/g)?.length).toBe(1);
    await mount(markup);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toBe(seen.at(-2));
    const decoded = seen.at(-1) as typeof tree;
    expect(decoded[3]!.updated).toBeInstanceOf(Date);
    expect(decoded[3]!.updated.toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });

  it("keep a '__proto__' key in tagged props and values as data", async () => {
    let received: Record<string, unknown> | undefined;
    modules["/src/seen.tsx"] = {
      SeenTree(props: Record<string, unknown>) {
        received = props;
        return h("nav", null, "tree");
      },
    };
    const data = '{"__proto__":{"admin":true},"at":{"$":"D","v":"2026-10-29T00:00:00.000Z"}}';
    await mount(
      `<script type="f/value" name="0value0proto0k">${data}</script>` +
        '<f-island src="/src/seen.tsx" export="SeenTree" props="p1" strategy="load"><nav>tree</nav></f-island>' +
        `<script type="f/props" for="p1">{"inline":${data},"shared":{"$":"r","v":"0value0proto0k"}}</script>`,
    );
    for (const key of ["inline", "shared"]) {
      const value = received![key] as Record<string, unknown>;
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect((value as { admin?: unknown }).admin).toBeUndefined();
      expect(Object.keys(value)).toEqual(["__proto__", "at"]);
      expect(value.at).toBeInstanceOf(Date);
    }
  });

  it("render a client component inside an island as part of it, not as another island", async () => {
    const markup = await html(h(OuterIsland));
    expect(markup.match(/<f-island/g)?.length).toBe(1);
  });

  it("restore the server HTML when an island fails", async () => {
    function Broken(): ReactNode {
      throw new Error("client only failure");
    }
    modules["/src/broken.tsx"] = { Broken };
    const BrokenIsland = createIsland(
      () => h("p", null, "server version"),
      "/src/broken.tsx",
      "Broken",
    );
    const markup = await html(BrokenIsland ? h(BrokenIsland) : null);
    const report = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(markup, { report });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(report).toHaveBeenCalled();
    expect(document.querySelector("f-island")!.innerHTML).toBe("<p>server version</p>");
  });

  it("hold a click until a deferred island hydrates, then replay it", async () => {
    const LazyCounter = createIsland(Counter, "/src/counter.tsx", "Counter", "interaction");
    const markup = await html(h(LazyCounter, { start: 0, label: "lazy" }));
    expect(markup).toContain('strategy="interaction"');
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    const islands = await mount(markup, { load: async (src) => (await loaded, modules[src]!) });
    expect(islands.rootCount()).toBe(0);
    const button = document.querySelector<HTMLButtonElement>("[data-counter=lazy]")!;
    button.click();
    await act(async () => {
      release();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(islands.rootCount()).toBe(1);
      expect(document.querySelector("[data-counter=lazy]")!.textContent).toBe("lazy 1");
    });
  });

  it("replay every click made while a deferred island loads, in order", async () => {
    const LazyCounter = createIsland(Counter, "/src/counter.tsx", "Counter", "interaction");
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    const islands = await mount(await html(h(LazyCounter, { start: 0, label: "twice" })), {
      load: async (src) => (await loaded, modules[src]!),
    });
    const button = document.querySelector<HTMLButtonElement>("[data-counter=twice]")!;
    button.click();
    button.click();
    await act(async () => {
      release();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(islands.rootCount()).toBe(1);
      expect(document.querySelector("[data-counter=twice]")!.textContent).toBe("twice 2");
    });
  });

  it("keep an island's state when the page renders again", async () => {
    const islands = await mount(
      await html(h("div", { id: "page" }, h(CounterIsland, { start: 0, label: "kept" }))),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-counter=kept]")!.click(),
    );
    const next = document.createElement("div");
    next.innerHTML = await html(
      h("div", { id: "page" }, h(CounterIsland, { start: 0, label: "kept" })),
    );
    const current = document.querySelector("#page")!;
    await act(async () => {
      expect(islands.carryOver(current, next)).toBe(1);
      current.replaceWith(next.firstElementChild!);
    });
    expect(document.querySelector("[data-counter=kept]")!.textContent).toBe("kept 1");
  });

  it("keep an island's state across a refresh when its props hold client components", async () => {
    const errors = spyErrors();
    function Framed({ panel, title }: { panel: ReactNode; title: string }) {
      const [clicks, setClicks] = useState(0);
      return h(
        "div",
        null,
        h(
          "button",
          { "data-framed": "", onClick: () => setClicks(clicks + 1) },
          `${title} ${clicks}`,
        ),
        panel,
      );
    }
    modules["/src/framed.tsx"] = { Framed };
    const FramedIsland = createIsland(Framed, "/src/framed.tsx", "Framed");
    const page = (title: string) =>
      h(
        "div",
        { id: "page" },
        h(FramedIsland, { title, panel: h(CounterIsland, { start: 0, label: "inner" }) }),
      );
    const islands = await mount(await html(page("first")));
    await act(async () => document.querySelector<HTMLButtonElement>("[data-framed]")!.click());
    expect(document.querySelector("[data-framed]")!.textContent).toBe("first 1");
    const next = document.createElement("div");
    next.innerHTML = await html(page("second"));
    const current = document.querySelector("#page")!;
    await act(async () => {
      expect(islands.carryOver(current, next)).toBe(1);
      current.replaceWith(next.firstElementChild!);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector("[data-framed]")!.textContent).toBe("second 1");
    });
    const inner = document.querySelector<HTMLButtonElement>('[data-counter="inner"]')!;
    await act(async () => inner.click());
    expect(document.querySelector('[data-counter="inner"]')!.textContent).toBe("inner 1");
    expect(errors()).toEqual([]);
  });

  it("wait for a streamed island's props, which arrive after it, instead of failing", async () => {
    const markup = await html(h(CounterIsland, { start: 0, label: "late" }));
    const props = markup.match(/<script type="f\/props"[^>]*>.*?<\/script>/)![0];
    document.body.innerHTML = markup.replace(props, "");
    // The stream has written the island and not yet its props.
    const readyState = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    const report = vi.fn();
    let loads = 0;
    const islands = runtime({
      report,
      load: async (src) => (loads++, modules[src]!),
    });
    try {
      await act(async () => {
        await islands.hydrate(document);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(report).not.toHaveBeenCalled();
      expect(islands.rootCount()).toBe(0);

      await act(async () => {
        document.querySelector("f-island")!.insertAdjacentHTML("afterend", props);
      });
      await vi.waitFor(async () => {
        await act(async () => {});
        expect(islands.rootCount()).toBe(1);
      });
      readyState.mockReturnValue("complete");
      await act(async () => {
        document.dispatchEvent(new Event("DOMContentLoaded"));
      });
      await act(async () =>
        document.querySelector<HTMLButtonElement>("[data-counter=late]")!.click(),
      );
      expect(document.querySelector("[data-counter=late]")!.textContent).toBe("late 1");
      expect(report).not.toHaveBeenCalled();
      expect(loads).toBe(1);
    } finally {
      readyState.mockRestore();
    }
  });

  it("hydrate an island React reveals after the document is parsed", async () => {
    // React batches reveals, so staged Suspense content can still wait once parsing has ended.
    document.body.innerHTML = `<main><!--$?--><template id="B:0"></template>loading<!--/$--></main><div hidden id="S:0">${await html(h(CounterIsland, { start: 0, label: "revealed" }))}</div>`;
    const report = vi.fn();
    const islands = runtime({ report });
    await act(async () => {
      await islands.hydrate(document);
    });
    expect(islands.rootCount()).toBe(0);

    await act(async () => {
      const staged = document.getElementById("S:0")!;
      const main = document.querySelector("main")!;
      main.replaceChildren(...staged.childNodes);
      staged.remove();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(islands.rootCount()).toBe(1);
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-counter=revealed]")!.click(),
    );
    expect(document.querySelector("[data-counter=revealed]")!.textContent).toBe("revealed 1");
    expect(report).not.toHaveBeenCalled();
  });

  it("keep each island's state with its item when a list loses one, as React keys do", async () => {
    const list = (labels: string[]) =>
      h(
        "div",
        { id: "page" },
        labels.map((label) => h(CounterIsland, { key: label, start: 0, label })),
      );
    const islands = await mount(await html(list(["a", "b", "c"])));
    await act(async () => {
      for (const label of ["a", "b", "c"]) {
        document.querySelector<HTMLButtonElement>(`[data-counter=${label}]`)!.click();
      }
    });
    await act(async () => document.querySelector<HTMLButtonElement>("[data-counter=b]")!.click());
    const next = document.createElement("div");
    next.innerHTML = await html(list(["b", "c"]));
    const current = document.querySelector("#page")!;
    await act(async () => {
      expect(islands.carryOver(current, next)).toBe(2);
      current.replaceWith(next.firstElementChild!);
    });
    expect(document.querySelector("[data-counter=b]")!.textContent).toBe("b 2");
    expect(document.querySelector("[data-counter=c]")!.textContent).toBe("c 1");
  });

  it("keep an island with server children with its item when the list above it shrinks", async () => {
    const list = (titles: string[]) =>
      h(
        "div",
        { id: "page" },
        titles.map((title) =>
          h(PanelIsland, { key: title, title }, h("p", { "data-body": title }, `${title} body`)),
        ),
      );
    const islands = await mount(await html(list(["a", "b", "c"])));
    const toggle = (title: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("[data-toggle]")].find(
        (button) => button.textContent === title,
      )!;
    await act(async () => toggle("b").click());
    expect(document.querySelector("[data-body=b]")).toBeNull();
    const next = document.createElement("div");
    next.innerHTML = await html(list(["b", "c"]));
    const current = document.querySelector("#page")!;
    await act(async () => {
      expect(islands.carryOver(current, next)).toBe(2);
      current.replaceWith(next.firstElementChild!);
    });
    expect(document.querySelector("[data-body=b]")).toBeNull();
    expect(document.querySelector("[data-body=c]")!.textContent).toBe("c body");
  });

  it("refuse to render an island whose props cannot be sent, as React Server Components do", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onPick = () => {};
    await expect(
      html(h(ShowsIsland, { at: new Date(0), tags: [], id: 1, onPick })),
    ).rejects.toThrow(/Shows \(\/src\/shows\.tsx\).*functions are not serializable \(onPick\)/);
    class Point {
      x = 1;
    }
    await expect(
      html(h(ShowsIsland, { at: new Date(0), tags: [], id: new Point() })),
    ).rejects.toThrow("Shows (/src/shows.tsx)");
    // A value the browser sent to an action goes back as a value only, never into an island.
    const sent = createTemporaryReferences().decode(0);
    await expect(
      html(h(ShowsIsland, { at: new Date(0), tags: [], id: sent as never })),
    ).rejects.toThrow(/Shows \(\/src\/shows\.tsx\).*not passed to a client component's props/);
  });

  it("render the elements a promise prop resolves to, and hydrate them, as React Server Components do", async () => {
    const errors = spyErrors();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    function Later({ content }: { content: Promise<ReactNode> }) {
      const [clicks, setClicks] = useState(0);
      return h(
        "div",
        null,
        h("button", { "data-later": "", onClick: () => setClicks(clicks + 1) }, `later ${clicks}`),
        h("section", { "data-content": "" }, use(content)),
      );
    }
    modules["/src/later.tsx"] = { Later };
    const LaterIsland = createIsland(Later, "/src/later.tsx", "Later");
    const content = tick().then(() =>
      h("strong", null, "arrived ", h(CounterIsland, { start: 4, label: "inner" })),
    );
    const markup = await html(
      h(Suspense, { fallback: h("p", null, "waiting") }, h(LaterIsland, { content })),
    );
    expect(markup).toContain("arrived");
    await mount(markup);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-later]")!.click());
    expect(document.querySelector("[data-later]")!.textContent).toBe("later 1");
    expect(document.querySelector("[data-content] strong")!.textContent).toBe("arrived inner 4");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-counter="inner"]')!.click(),
    );
    expect(document.querySelector('[data-counter="inner"]')!.textContent).toBe("inner 5");
    expect(errors()).toEqual([]);
  });

  it("settle a promise prop to the object holding it, as React Server Components do", async () => {
    const errors = spyErrors();
    type Holder = { name: string; self?: Promise<Holder>; list: Holder[] };
    function Owner({ holder }: { holder: Holder }) {
      const settled = use(holder.self!);
      return h(
        "p",
        { "data-owner": "" },
        `${settled.name} ${String(settled === holder)} ${String(settled.list[0] === holder)}`,
      );
    }
    modules["/src/owner.tsx"] = { Owner };
    const OwnerIsland = createIsland(Owner, "/src/owner.tsx", "Owner");
    const holder: Holder = { name: "holder", list: [] };
    holder.self = Promise.resolve(holder);
    holder.list.push(holder);
    const markup = await html(
      h(Suspense, { fallback: h("p", null, "waiting") }, h(OwnerIsland, { holder })),
    );
    // Sent once, and the server render reads the same object.
    expect(markup.match(/type="f\/promise"/g)).toHaveLength(1);
    expect(markup).toContain("holder true true");
    await mount(markup);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-owner]")!.textContent).toBe("holder true true"),
    );
    expect(errors()).toEqual([]);
  });

  it("let a stream prop's chunks refer to the object holding the stream", async () => {
    const errors = spyErrors();
    type Feed = { name: string; chunks?: ReadableStream<{ feed: Feed; index: number }> };
    const seen = new WeakMap<object, Promise<string>>();
    // Reads every chunk while rendering, on the server and in the browser.
    const readAll = (feed: Feed) => {
      let read = seen.get(feed.chunks!);
      if (!read) {
        read = (async () => {
          const parts: string[] = [];
          const reader = feed.chunks!.getReader();
          for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            parts.push(`${chunk.value.index}:${String(chunk.value.feed === feed)}`);
          }
          return parts.join(" ");
        })();
        seen.set(feed.chunks!, read);
      }
      return read;
    };
    function Reader({ feed }: { feed: Feed }) {
      return h("p", { "data-feed": "" }, use(readAll(feed)));
    }
    modules["/src/reader.tsx"] = { Reader };
    const ReaderIsland = createIsland(Reader, "/src/reader.tsx", "Reader");
    const feed: Feed = { name: "feed" };
    let index = 0;
    feed.chunks = new ReadableStream({
      pull(controller) {
        if (index === 3) return controller.close();
        controller.enqueue({ feed, index: index++ });
      },
    });
    const markup = await html(
      h(Suspense, { fallback: h("p", null, "waiting") }, h(ReaderIsland, { feed })),
    );
    expect(markup).toContain("0:true 1:true 2:true");
    await mount(markup);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-feed]")!.textContent).toBe("0:true 1:true 2:true"),
    );
    expect(errors()).toEqual([]);
  });

  it("render elements inside a map or set prop, with live client components, as React Server Components do", async () => {
    const errors = spyErrors();
    function Panels({ panels, marks }: { panels: Map<string, ReactNode>; marks: Set<ReactNode> }) {
      return h("div", { "data-panels": "" }, panels.get("main"), ...marks);
    }
    modules["/src/panels.tsx"] = { Panels };
    const PanelsIsland = createIsland(Panels, "/src/panels.tsx", "Panels");
    const markup = await html(
      h(PanelsIsland, {
        panels: new Map([["main", h(CounterIsland, { start: 1, label: "panel" })]]),
        marks: new Set([h("i", { key: "m" }, "marked")]),
      }),
    );
    expect(markup).toContain("panel 1");
    await mount(markup);
    expect(document.querySelector('[data-panels] [data-counter="panel"]')!.textContent).toBe(
      "panel 1",
    );
    expect(document.querySelector("[data-panels] i")!.textContent).toBe("marked");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-counter="panel"]')!.click(),
    );
    expect(document.querySelector('[data-counter="panel"]')!.textContent).toBe("panel 2");
    expect(errors()).toEqual([]);
  });

  it("give an island global symbols, errors, iterators, blobs and form data, as React Server Components do", async () => {
    const errors = spyErrors();
    // jsdom's Blob cannot read its bytes; servers and browsers have one that can.
    vi.stubGlobal("Blob", NodeBlob);
    type Props = {
      symbol: symbol;
      error: Error;
      items: Iterable<ReactNode>;
      blob: Blob;
      form: FormData;
    };
    function Kinds({ symbol, error, items, blob, form }: Props) {
      return h(
        "p",
        { "data-kinds": "" },
        String(symbol === Symbol.for("islx.prop")),
        " ",
        String(error instanceof Error && !error.message.includes("hunter2")),
        " ",
        ...items,
        " ",
        `${blob.size} ${String(blob instanceof Blob)}`,
        " ",
        String(form.get("name")),
      );
    }
    modules["/src/kinds.tsx"] = { Kinds };
    const KindsIsland = createIsland(Kinds, "/src/kinds.tsx", "Kinds");
    const form = new FormData();
    form.append("name", "kinfe");
    const markup = await html(
      h(
        Suspense,
        { fallback: null },
        h(KindsIsland, {
          symbol: Symbol.for("islx.prop"),
          error: new Error("database password is hunter2"),
          items: (function* () {
            yield "a";
            yield h("b", { key: "b" }, "b");
          })(),
          blob: new Blob(["blob"]),
          form,
        }),
      ),
    );
    expect(markup).not.toContain("hunter2");
    await mount(markup);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-kinds]")!.textContent).toBe("true true ab 4 true kinfe"),
    );
    expect(errors()).toEqual([]);
  });

  it("give a stream prop's chunks to the server render too, elements included", async () => {
    const errors = spyErrors();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const firsts = new WeakMap<object, Promise<ReactNode>>();
    // Reads the stream's first chunk while rendering, on the server and in the browser.
    const first = (stream: ReadableStream<ReactNode>) => {
      let read = firsts.get(stream);
      if (!read) {
        read = stream
          .getReader()
          .read()
          .then((chunk) => chunk.value);
        firsts.set(stream, read);
      }
      return read;
    };
    function Ticker({ ticks }: { ticks: ReadableStream<ReactNode> }) {
      const [clicks, setClicks] = useState(0);
      return h(
        "div",
        null,
        h(
          "button",
          { "data-ticker": "", onClick: () => setClicks(clicks + 1) },
          `ticker ${clicks}`,
        ),
        h("output", { "data-first": "" }, use(first(ticks))),
      );
    }
    modules["/src/ticker.tsx"] = { Ticker };
    const TickerIsland = createIsland(Ticker, "/src/ticker.tsx", "Ticker");
    const ticks = new ReadableStream<ReactNode>({
      async start(controller) {
        await tick();
        controller.enqueue(h("b", null, "tick ", h(CounterIsland, { start: 1, label: "tick" })));
        controller.close();
      },
    });
    const markup = await html(h(Suspense, { fallback: null }, h(TickerIsland, { ticks })));
    expect(markup).toContain("<b>tick");
    await mount(markup);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-ticker]")!.click());
    expect(document.querySelector("[data-ticker]")!.textContent).toBe("ticker 1");
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-counter="tick"]')!.click(),
    );
    expect(document.querySelector('[data-counter="tick"]')!.textContent).toBe("tick 2");
    expect(errors()).toEqual([]);
  });

  it("send props that refer to themselves, as React Server Components do", async () => {
    type Node = { name: string; self?: Node; children: Array<{ parent: Node }>; big: string };
    const node: Node = { name: "root", children: [], big: "x".repeat(600) };
    node.self = node;
    node.children.push({ parent: node });
    const map = new Map<string, unknown>();
    map.set("me", map);
    const set = new Set<unknown>();
    set.add([set]);
    const markup = await html(h(CycleIsland, { node, map, set, again: node }));
    expect(markup).toContain("<f-island");
    expect(markup).toContain("root true true true true true 0");
    expect(markup).toContain('{"$":"C","v":1}');
    expect(markup).toContain('type="f/value"');
    await mount(markup);
    const button = document.querySelector<HTMLButtonElement>("[data-cycle]")!;
    await act(async () => button.click());
    expect(button.textContent).toBe("root true true true true true 1");
  });
});

function ShowsTreeComponent({ tree }: { tree: Array<{ title: string }> }) {
  return h("nav", null, tree.length);
}
modules["/src/tree.tsx"] = { ShowsTreeComponent };
const ShowsTree = createIsland(ShowsTreeComponent, "/src/tree.tsx", "ShowsTreeComponent");
const ShowsTreeIsland = createIsland(ShowsTreeComponent, "/src/tree.tsx", "ShowsTreeComponent");
const SeenTreeIsland = createIsland(
  (() => h("nav", null, "tree")) as (props: { tree: unknown }) => ReactNode,
  "/src/seen.tsx",
  "SeenTree",
);

describe("ids in islands", () => {
  it("are the ids the server rendered, deep in a page and unique across islands", async () => {
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) => h("li", { key: index }, `row ${index}`));
    const markup = await html(
      h(
        "main",
        null,
        h("ul", null, rows(3)),
        h("section", null, h("h2", null, "First"), h(FieldIsland, { label: "a" })),
        h("ol", null, rows(40), h("li", null, h(FieldIsland, { label: "b" }))),
      ),
    );
    const serverIds = [...markup.matchAll(/<input id="([^"]+)"/g)].map((match) => match[1]);
    expect(serverIds).toHaveLength(2);
    expect(new Set(serverIds).size).toBe(2);
    const errors = spyErrors();
    await mount(markup);
    expect(errors()).toEqual([]);
    const held = [...document.querySelectorAll("[data-held]")].map((node) => node.textContent);
    expect(held).toEqual(serverIds);
  });

  it("match when the browser hydrates the wrapped export", async () => {
    const markup = await html(
      h(
        "main",
        null,
        h("ul", null, h("li", null, "a"), h("li", null, h(FieldIsland, { label: "w" }))),
      ),
    );
    const serverId = /<input id="([^"]+)"/.exec(markup)![1];
    const errors = spyErrors();
    await mount(markup, { load: async (src) => wrappedModules[src]! });
    expect(errors()).toEqual([]);
    expect(document.querySelector("[data-held]")!.textContent).toBe(serverId);
  });
});

describe("element props in islands", () => {
  it("render when the island shows one the server did not place", async () => {
    const markup = await html(
      h(TabsIsland, {
        panels: [h("p", { key: "a" }, "panel a"), h("p", { key: "b" }, "panel b")],
      }),
    );
    expect(markup).toContain("panel a");
    await mount(markup);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-next]")!.click());
    expect(document.querySelector("[data-panel]")!.textContent).toBe("panel b");
  });
});

describe("plain props in islands", () => {
  it("reach the island's server render as the props given, not copies, when nothing in them is split", async () => {
    const tree = Array.from({ length: 300 }, (_, index) => ({
      title: `page ${index}`,
      href: `/docs/p${index}`,
      tags: index % 2 ? ["a"] : [],
    }));
    const seen: unknown[] = [];
    function Nav({ tree: given }: { tree: typeof tree }) {
      seen.push(given);
      return h("nav", null, given.length);
    }
    const NavIsland = createIsland(Nav, "/src/plain-nav.tsx", "Nav");
    const markup = await html(h("div", null, h(NavIsland, { tree }), h(NavIsland, { tree })));
    expect(seen).toEqual([tree, tree]);
    expect(seen.every((given) => given === tree)).toBe(true);
    // Sent once, as one value both islands refer to.
    expect(markup.split("page 299").length - 1).toBe(1);
  });

  it("still split a cycle that holds a promise, even when an object inside the cycle is read first", async () => {
    type Outer = { inner: { back?: Outer }; quote: Promise<string> };
    const outer: Outer = { inner: {}, quote: Promise.resolve("settled") };
    outer.inner.back = outer;
    function Looped({ outer: given }: { outer: Outer }) {
      return h("p", null, `${given.inner.back === given} ${use(given.quote)}`);
    }
    const LoopedIsland = createIsland(Looped, "/src/looped.tsx", "Looped");
    const markup = await html(h(LoopedIsland, { outer }));
    expect(markup).toContain("<p>true settled</p>");
    expect(markup).toMatch(/"quote":\{"\$":"T","v":"[^"]+"\}/);
  });
});

describe("client components in an island's server output", () => {
  it("read the island's context, through server components between them", async () => {
    const markup = await html(
      h(ThemeProviderIsland, null, h(ServerSection, null, h(ThemeLabelIsland))),
    );
    expect(markup).toContain('<f-slot name="');
    expect(markup).toContain('type="f/tree"');
    expect(markup).toContain("server text");
    const errors = spyErrors();
    await mount(markup);
    expect(errors()).toEqual([]);
    expect(document.querySelector("[data-theme]")!.textContent).toBe("light");
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-theme-toggle]")!.click(),
    );
    expect(document.querySelector("[data-theme]")!.textContent).toBe("dark");
    expect(document.querySelector("article p")!.textContent).toBe("server text");
  });

  it("keep their own state next to the island's", async () => {
    const markup = await html(
      h(
        PanelIsland,
        { title: "More" },
        h("p", null, "plain"),
        h(CounterIsland, { start: 0, label: "inside" }),
      ),
    );
    await mount(markup);
    const inside = () => document.querySelector<HTMLButtonElement>("[data-counter=inside]")!;
    await act(async () => inside().click());
    expect(inside().textContent).toBe("inside 1");
  });

  it("leave plain server HTML as HTML, with no tree", async () => {
    const markup = await html(h(PanelIsland, { title: "More" }, h("p", null, "plain")));
    expect(markup).not.toContain('type="f/tree"');
  });
});

describe("promises in islands", () => {
  const later = <T>(value: T, ms = 10) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it("arrive settled when their outcome is on the page, so hydration does not suspend", async () => {
    const markup = await html(h(QuoteIsland, { quote: later({ text: "ship it" }) }));
    expect(markup).toMatch(/\{"quote":\{"\$":"T","v":"[^"]+"\}\}/);
    expect(markup).toMatch(
      /<script type="f\/promise" name="[^"]+">\{"v":\{"text":"ship it"\}\}<\/script>/,
    );
    const errors = spyErrors();
    await mount(markup);
    expect(errors()).toEqual([]);
    expect(document.querySelector("q")!.textContent).toBe("ship it");
    const like = document.querySelector<HTMLButtonElement>("[data-like]")!;
    await act(async () => like.click());
    expect(like.textContent).toBe("likes 1");
  });

  it("settle when their outcome streams in after the island hydrated", async () => {
    const markup = await html(h(QuoteIsland, { quote: later({ text: "late" }) }));
    const outcome = /<script type="f\/promise"[^>]*>.*?<\/script>/.exec(markup)![0];
    const errors = spyErrors();
    await mount(markup.replace(outcome, ""));
    expect(document.querySelector("f-island")!.hasAttribute("hydrated")).toBe(true);
    const like = document.querySelector<HTMLButtonElement>("[data-like]")!;
    await act(async () => like.click());
    expect(like.textContent).toBe("likes 1");
    await act(async () => {
      const staged = document.createElement("div");
      staged.hidden = true;
      staged.innerHTML = outcome;
      document.body.append(staged);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(errors()).toEqual([]);
    expect(document.querySelector("q")!.textContent).toBe("late");
    expect(like.textContent).toBe("likes 1");
  });

  it("send the values their outcome holds", async () => {
    const big = { rows: Array.from({ length: 80 }, (_, row) => ({ row, label: `row ${row}` })) };
    received.length = 0;
    await mount(await html(h(KeepsIsland, { value: later(big) })));
    expect(await received[0]).toEqual(big);
  });

  it("settle on the page for an island kept from a parsed response", async () => {
    received.length = 0;
    const islands = await mount(await html(h("main", null, h(KeepsIsland, { value: later(1) }))));
    const next = await html(h("main", null, h(KeepsIsland, { value: later(2) })));
    const outcome = /<script type="f\/promise"[^>]*>.*?<\/script>/.exec(next)![0];
    const parsed = new DOMParser().parseFromString(next.replace(outcome, ""), "text/html");
    await act(async () => {
      expect(islands.carryOver(document.body, parsed.body)).toBe(1);
    });
    const kept = received.at(-1)!;
    await act(async () => {
      document.body.insertAdjacentHTML("beforeend", outcome);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(await kept).toBe(2);
  });

  it("reject in the browser without the server's reason", async () => {
    const reason = new Error("database password is hunter2");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = await html(
      h(KeepsIsland, { value: Promise.reject(reason).finally(() => undefined) }),
    );
    expect(markup).not.toContain("hunter2");
    expect(markup).toContain('{"e":1}');
    expect(errors.mock.calls.some((call) => call.includes(reason))).toBe(true);
    received.length = 0;
    await mount(markup);
    await expect(received[0]).rejects.toThrow("rejected on the server");
  });
});

describe("streams in islands", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const stream = <T>(chunks: T[], failAt?: number) =>
    new ReadableStream<T>({
      async start(controller) {
        for (const [index, chunk] of chunks.entries()) {
          await tick();
          if (index === failAt) return controller.error(new Error("disk on fire"));
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
  async function* generate<T>(chunks: T[]) {
    for (const chunk of chunks) {
      await tick();
      yield chunk;
    }
    return "end";
  }
  async function readAll(value: unknown): Promise<unknown[]> {
    const chunks: unknown[] = [];
    if (value instanceof ReadableStream) {
      const reader = value.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        chunks.push(read.value);
      }
      return chunks;
    }
    for await (const chunk of value as AsyncIterable<unknown>) chunks.push(chunk);
    return chunks;
  }
  // The props the browser hydrated the island with.
  async function hydratedValue(markup: string) {
    received.length = 0;
    await mount(markup);
    return received[0] as unknown;
  }

  it("arrive as a ReadableStream the browser reads chunk by chunk, as React Server Components send them", async () => {
    const markup = await html(
      h(KeepsIsland, { value: stream(["a", { b: new Date(0) }, new Uint8Array([1, 2])]) as never }),
    );
    expect(markup).toMatch(/\{"value":\{"\$":"W","v":"[^"]+","k":"r"\}\}/);
    const value = await hydratedValue(markup);
    expect(value).toBeInstanceOf(ReadableStream);
    expect(await readAll(value)).toEqual(["a", { b: new Date(0) }, new Uint8Array([1, 2])]);
  });

  it("arrive as an async iterable, or as the iterator a generator is", async () => {
    const iterable = { [Symbol.asyncIterator]: () => generate([1, 2]) };
    const value = await hydratedValue(await html(h(KeepsIsland, { value: iterable as never })));
    expect(value).not.toBeInstanceOf(ReadableStream);
    expect(await readAll(value)).toEqual([1, 2]);
    // An iterable can be read again, from the start.
    expect(await readAll(value)).toEqual([1, 2]);

    const iterator = (await hydratedValue(
      await html(h(KeepsIsland, { value: generate(["x", "y"]) as never })),
    )) as AsyncIterator<string, string>;
    expect(await iterator.next()).toEqual({ value: "x", done: false });
    expect(await iterator.next()).toEqual({ value: "y", done: false });
    expect(await iterator.next()).toEqual({ value: "end", done: true });
  });

  it("deliver the chunks that stream in after the island hydrated", async () => {
    const markup = await html(h(KeepsIsland, { value: stream(["early", "late"]) as never }));
    const outcomes = [...markup.matchAll(/<script type="f\/promise"[^>]*>.*?<\/script>/g)].map(
      (match) => match[0],
    );
    expect(outcomes).toHaveLength(3);
    const value = await hydratedValue(
      outcomes.reduce((page, outcome) => page.replace(outcome, ""), markup),
    );
    const reading = readAll(value);
    await act(async () => {
      for (const outcome of outcomes) {
        document.body.insertAdjacentHTML("beforeend", outcome);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    expect(await reading).toEqual(["early", "late"]);
  });

  it("error in the browser after the chunks before the failure, without the server's reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const markup = await html(h(KeepsIsland, { value: stream(["ok", "never"], 1) as never }));
    expect(markup).not.toContain("disk on fire");
    const reader = ((await hydratedValue(markup)) as ReadableStream<string>).getReader();
    expect(await reader.read()).toEqual({ value: "ok", done: false });
    await expect(reader.read()).rejects.toThrow("rejected on the server");
  });
});

describe("islands in a page that streams after it loaded (a navigation)", () => {
  // The island's shell, with its Suspense boundary still waiting, and the rest of the stream.
  async function shell() {
    let open!: () => void;
    gate = new Promise<void>((resolve) => (open = resolve));
    serverRendering = true;
    const stream = await renderToStream(h("main", null, h(WaitsIsland)));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    open();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value);
    }
    serverRendering = false;
    return { first, rest };
  }

  it("hydrate an island once React reveals its streamed Suspense content", async () => {
    const { first, rest } = await shell();
    expect(first).toContain("<!--$?-->");
    const errors = spyErrors();
    const islands = await mount(first);
    expect(islands.rootCount()).toBe(0);
    await act(async () => {
      // jsdom runs no scripts from innerHTML: reveal the content as React's $RC does.
      const staged = document.createElement("div");
      staged.innerHTML = rest;
      document.body.append(staged);
      const template = document.querySelector("template[id^='B:']")!;
      const content = staged.querySelector("div[hidden][id^='S:']")!;
      const start = template.previousSibling as Comment;
      let node = template.nextSibling;
      while (node && !(node.nodeType === 8 && (node as Comment).data === "/$")) {
        const next = node.nextSibling;
        node.remove();
        node = next;
      }
      template.remove();
      while (content.firstChild) node!.parentNode!.insertBefore(content.firstChild, node);
      staged.remove();
      start.data = "$";
      await islands.hydrate(document);
    });
    expect(errors()).toEqual([]);
    expect(islands.rootCount()).toBe(1);
    const like = document.querySelector<HTMLButtonElement>("[data-like]")!;
    await act(async () => like.click());
    expect(like.textContent).toBe("likes 1");
    expect(document.querySelector("q")!.textContent).toBe("streamed");
  });

  it("hydrate an island whose streamed content never came, rendering it in the browser", async () => {
    const { first } = await shell();
    const islands = await mount(first);
    expect(islands.rootCount()).toBe(0);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      endStreamedContent(document);
      await islands.hydrate(document);
    });
    expect(islands.rootCount()).toBe(1);
    expect(document.querySelector("q")!.textContent).toBe("streamed");
  });
});

describe("actions in islands", () => {
  it("arrive as functions that call the server with their sealed values", async () => {
    const hoisted = vi.fn(async ([team]: [string], name: string) => `${team}:${name}`);
    registerInlineAction(hoisted, "island-invite", 1);
    function Invite({ invite }: { invite: (name: string) => Promise<string> }) {
      const [result, setResult] = useState("");
      return h(
        "button",
        { onClick: async () => setResult(await invite("Ada")) },
        result || "invite",
      );
    }
    modules["/src/invite.tsx"] = { Invite };
    const InviteIsland = createIsland(Invite, "/src/invite.tsx", "Invite");
    const action = bindInlineAction("island-invite", () => ["core"], ["team"]);
    const markup = await html(h(InviteIsland, { invite: action }));
    expect(markup).toMatch(/\{"invite":\{"\$":"a","v":"island-invite","b":"[A-Za-z0-9_-]+"\}\}/);
    // Only sealed: the value never appears as JSON in the page.
    expect(markup).not.toContain('"core"');

    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const response = await handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      );
      return response;
    });
    await mount(markup);
    await act(async () => {
      document.querySelector("button")!.click();
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector("button")!.textContent).toBe("core:Ada");
    });
    expect(hoisted).toHaveBeenCalledWith(["core"], "Ada");
  });

  it("show the elements an action returns, with their client components live", async () => {
    const errors = spyErrors();
    const saved = vi.fn();
    const save = async () => {
      saved();
      return {
        note: h("p", { "data-note": "" }, "saved ", h(CounterIsland, { start: 1, label: "r" })),
      };
    };
    registerServerReference(save, "island-save-element");
    function Saver({ action }: { action: typeof save }) {
      const [note, setNote] = useState<ReactNode>(null);
      return h(
        "div",
        null,
        h(
          "button",
          { "data-save": "", onClick: async () => setNote((await action()).note) },
          "save",
        ),
        note,
      );
    }
    modules["/src/saver.tsx"] = { Saver };
    const SaverIsland = createIsland(Saver, "/src/saver.tsx", "Saver");
    const markup = await html(h(SaverIsland, { action: save }));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      ),
    );
    await mount(markup);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-save]")!.click());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector("[data-note]")?.textContent).toBe("saved r 1");
    });
    expect(saved).toHaveBeenCalledTimes(1);
    const counter = document.querySelector<HTMLButtonElement>("[data-counter=r]")!;
    await act(async () => counter.click());
    expect(counter.textContent).toBe("r 2");
    expect(errors()).toEqual([]);
  });

  it("show server-only elements an action returns, after their async components ran", async () => {
    async function Total() {
      await Promise.resolve();
      return h("strong", null, "3 items");
    }
    const count = async () => [h("em", { key: "a" }, "counted:"), h(Total, { key: "b" })];
    registerServerReference(count, "island-count-element");
    function Counts({ action }: { action: typeof count }) {
      const [shown, setShown] = useState<ReactNode>(null);
      return h(
        "div",
        null,
        h("button", { "data-count": "", onClick: async () => setShown(await action()) }, "count"),
        h("output", null, shown),
      );
    }
    modules["/src/counts.tsx"] = { Counts };
    const CountsIsland = createIsland(Counts, "/src/counts.tsx", "Counts");
    const markup = await html(h(CountsIsland, { action: count }));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      ),
    );
    await mount(markup);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-count]")!.click());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector("output")!.textContent).toBe("counted:3 items");
    });
    expect(document.querySelector("output strong")!.textContent).toBe("3 items");
  });

  it("keep the promises and streams an action returns unresolved, as the renderer walks them", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const mixed = async () => ({
      total: gate.then(() => 3),
      ticks: (async function* () {
        await gate;
        yield 1;
      })(),
    });
    registerServerReference(mixed, "island-mixed-result");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      ),
    );
    const { createServerReference } = await import("@farm.js/islx/client");
    const result = (await createServerReference("island-mixed-result")()) as {
      total: Promise<number>;
      ticks: AsyncIterator<number>;
    };
    expect(result.total).toBeInstanceOf(Promise);
    release();
    expect(await result.total).toBe(3);
    expect(await result.ticks.next()).toEqual({ value: 1, done: false });
  });

  it("keep a result's cycles through promises and to itself while its elements render", async () => {
    type Holder = {
      name: string;
      self?: Holder;
      later?: Promise<Holder>;
      note?: ReactNode;
      chunks?: ReadableStream<{ holder: Holder }>;
    };
    const hold = async () => {
      const holder: Holder = { name: "holder", note: h("em", null, "noted") };
      holder.self = holder;
      holder.later = Promise.resolve(holder);
      let sent = false;
      holder.chunks = new ReadableStream({
        pull(controller) {
          if (sent) return controller.close();
          sent = true;
          controller.enqueue({ holder });
        },
      });
      return holder;
    };
    registerServerReference(hold, "island-hold-cycles");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      ),
    );
    const { createServerReference } = await import("@farm.js/islx/client");
    const holder = (await createServerReference("island-hold-cycles")()) as Holder;
    expect(holder.self).toBe(holder);
    expect(await holder.later).toBe(holder);
    const reader = holder.chunks!.getReader();
    expect((await reader.read()).value!.holder).toBe(holder);
  });

  it("render elements and promises inside a map or set an action returns, as React Server Components do", async () => {
    const make = async () => ({
      byName: new Map<string, unknown>([
        ["now", h("em", null, "in a map")],
        ["later", Promise.resolve(h("b", null, "later"))],
      ]),
      marks: new Set<unknown>([h("i", null, "in a set")]),
    });
    registerServerReference(make, "island-map-set-result");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      ),
    );
    const { createServerReference } = await import("@farm.js/islx/client");
    const result = (await createServerReference("island-map-set-result")()) as {
      byName: Map<string, unknown>;
      marks: Set<unknown>;
    };
    expect([...result.byName.keys()]).toEqual(["now", "later"]);
    expect(isValidElement(result.byName.get("now"))).toBe(true);
    expect(isValidElement(await result.byName.get("later"))).toBe(true);
    expect([...result.marks].map((mark) => isValidElement(mark))).toEqual([true]);
  });

  it("render the elements inside an iterator an action returns", async () => {
    const make = async () => ({
      items: (function* () {
        yield 1;
        yield h("em", null, "two");
      })(),
    });
    registerServerReference(make, "island-iterator-result");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
      ),
    );
    const { createServerReference } = await import("@farm.js/islx/client");
    const result = (await createServerReference("island-iterator-result")()) as {
      items: Iterator<unknown>;
    };
    const items = [...(result.items as unknown as Iterable<unknown>)];
    expect(items[0]).toBe(1);
    expect(isValidElement(items[1])).toBe(true);
  });

  it("render the elements an action returns inside the framework's run, once", async () => {
    const runs = vi.fn();
    const label = async () => h("em", { "data-label": "" }, "labelled");
    registerServerReference(label, "island-label-element");
    function Labeller({ action }: { action: () => Promise<unknown> }) {
      const [shown, setShown] = useState<ReactNode>(null);
      return h(
        "div",
        null,
        h(
          "button",
          {
            "data-label-button": "",
            onClick: async () => setShown(((await action()) as { value: ReactNode }).value),
          },
          "label",
        ),
        h("output", null, shown),
      );
    }
    modules["/src/labeller.tsx"] = { Labeller };
    const LabellerIsland = createIsland(Labeller, "/src/labeller.tsx", "Labeller");
    const markup = await html(h(LabellerIsland, { action: label }));
    // A framework's run that wraps what the action returned, as Farm's does.
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
        {
          run: async <T>(_request: Request, action: () => Promise<T>) => {
            runs();
            return { value: await action() } as T;
          },
        },
      ),
    );
    await mount(markup);
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-label-button]")!.click(),
    );
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector("output [data-label]")?.textContent).toBe("labelled");
    });
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it("render the elements in the promises and streams an action returns, inside the framework's run", async () => {
    const { AsyncLocalStorage } = await import("node:async_hooks");
    const request = new AsyncLocalStorage<string>();
    // A server component that reads the request, as one calling cookies() would.
    async function Greeting({ name }: { name: string }) {
      await Promise.resolve();
      return h("em", null, `${name} for ${request.getStore() ?? "nobody"}`);
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const greet = async () => ({
      later: tick().then(() => h(Greeting, { name: "later" })),
      rows: (async function* () {
        await tick();
        yield h(Greeting, { name: "row" });
      })(),
    });
    registerServerReference(greet, "island-greet-elements");
    function Greeter({ action }: { action: () => Promise<unknown> }) {
      const [shown, setShown] = useState<ReactNode[]>([]);
      return h(
        "div",
        null,
        h(
          "button",
          {
            "data-greet": "",
            onClick: async () => {
              const result = (await action()) as {
                later: Promise<ReactNode>;
                rows: AsyncIterator<ReactNode>;
              };
              const later = await result.later;
              const row = (await result.rows.next()).value;
              setShown([h("p", { key: "later" }, later), h("p", { key: "row" }, row)]);
            },
          },
          "greet",
        ),
        h("output", { "data-greetings": "" }, shown),
      );
    }
    modules["/src/greeter.tsx"] = { Greeter };
    const GreeterIsland = createIsland(Greeter, "/src/greeter.tsx", "Greeter");
    const markup = await html(h(GreeterIsland, { action: greet }));
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
      handleAction(
        new Request(url, {
          ...init,
          headers: { ...(init.headers as object), origin: new URL(url).origin },
        }),
        { run: (_request, action) => request.run("kinfe", action) },
      ),
    );
    await mount(markup);
    await act(async () => document.querySelector<HTMLButtonElement>("[data-greet]")!.click());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(document.querySelector("[data-greetings]")?.textContent).toBe(
        "later for kinferow for kinfe",
      );
    });
  });

  it("report a server form's submit to useFormStatus in an island inside it", async () => {
    const save = async (_form: FormData) => {};
    registerServerReference(save, "island-save");
    function Submit() {
      const { pending } = useFormStatus();
      return h("button", { type: "submit", disabled: pending }, pending ? "saving" : "save");
    }
    modules["/src/submit.tsx"] = { Submit };
    const SubmitIsland = createIsland(Submit, "/src/submit.tsx", "Submit");
    const markup = await html(
      h(
        "form",
        { action: save },
        h("input", { name: "note", defaultValue: "hi" }),
        h(SubmitIsland),
      ),
    );
    expect(markup).toContain(">save</button>");
    // The call stays in flight until released (jsdom's FormData does not reach a Node Request, so
    // the server's side is the browser suite's to cover).
    let release = () => {};
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(String((init.body as FormData).get("note")));
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(null, { status: 204 });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    enhanceForms();
    await mount(markup);
    const button = () => document.querySelector("button")!;
    await act(async () => button().click());
    expect(button().textContent).toBe("saving");
    expect(button().disabled).toBe(true);
    expect(sent).toEqual(["hi"]);
    await act(async () => release());
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(button().textContent).toBe("save");
    });
  });

  it("show useActionState's result after a form post, and hydrate with it", async () => {
    const add = async (previous: { items: string[] }, form: FormData) => ({
      items: [...previous.items, String(form.get("item"))],
    });
    registerServerReference(add, "island-add");
    function List({ action }: { action: typeof add }) {
      const [state, formAction] = useActionState(action, { items: [] as string[] });
      return h(
        "form",
        { action: formAction },
        h(
          "ul",
          null,
          state.items.map((item) => h("li", { key: item }, item)),
        ),
        h("input", { name: "item" }),
      );
    }
    modules["/src/list.tsx"] = { List };
    const ListIsland = createIsland(List, "/src/list.tsx", "List");
    const page = h("div", null, h(ListIsland, { action: add }));
    const first = await html(page);
    // Post the form as a browser without JavaScript would.
    // URL-encoded: jsdom's FormData is not one Node's Request can send.
    const fields = [
      ...first.matchAll(/<input type="hidden" name="([^"]*)"(?: value="([^"]*)")?\/>/g),
    ].map((match) => [match[1]!, match[2] ?? ""]);
    fields.push(["item", "milk"]);
    const data = fields
      .map(([key, value]) => `${encodeURIComponent(key!)}=${encodeURIComponent(value!)}`)
      .join("&");
    let after = "";
    const posted = await handleAction(
      new Request("https://app.test/list", {
        method: "POST",
        headers: {
          origin: "https://app.test",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: data,
      }),
      {
        renderFormState: async (formState) => {
          after = await html(page, { formState });
          return new Response(after);
        },
      },
    );
    expect(posted!.status).toBe(200);
    expect(after).toContain("<li>milk</li>");
    expect(after).toContain('type="f/form-state"');
    const errors = spyErrors();
    await mount(after);
    expect(errors()).toEqual([]);
    expect(document.querySelector("li")!.textContent).toBe("milk");
  });
});

describe("navigation renders", () => {
  it("arrive whole: Suspense content inline, with no streaming scripts", async () => {
    const { Suspense } = await import("react");
    async function Slow() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return h("p", null, "late");
    }
    const page = h("div", null, h(Suspense, { fallback: h("p", null, "wait") }, h(Slow)));
    const navigation = await html(page, {
      request: new Request("https://app.test/", { headers: { "F-Render": "document" } }),
    });
    expect(navigation).toContain("<p>late</p>");
    expect(navigation).not.toContain("wait");
  });
});
