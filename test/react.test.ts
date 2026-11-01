// @vitest-environment jsdom
import {
  Suspense,
  act,
  createElement as h,
  use,
  useActionState,
  useState,
  type ReactNode,
} from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIsland } from "@farm.js/islx/react";
import {
  createHydrationRuntime,
  endStreamedContent,
  scheduleHydration,
} from "@farm.js/islx/react/client";
import { renderToStream } from "@farm.js/islx/react/server";
import { getValueStore } from "@farm.js/islx/client";
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

const modules: Record<string, Record<string, unknown>> = {
  "/src/counter.tsx": { Counter },
  "/src/waits.tsx": { Waits },
  "/src/quote.tsx": { Quote },
  "/src/keeps.tsx": { Keeps },
  "/src/shows.tsx": { Shows },
  "/src/panel.tsx": { Panel },
  "/src/outer.tsx": { Outer },
};
const CounterIsland = createIsland(Counter, "/src/counter.tsx", "Counter");
const ShowsIsland = createIsland(Shows, "/src/shows.tsx", "Shows");
const PanelIsland = createIsland(Panel, "/src/panel.tsx", "Panel");
const OuterIsland = createIsland(Outer, "/src/outer.tsx", "Outer");
const WaitsIsland = createIsland(Waits, "/src/waits.tsx", "Waits");
const QuoteIsland = createIsland(Quote, "/src/quote.tsx", "Quote");
const KeepsIsland = createIsland(Keeps, "/src/keeps.tsx", "Keeps");

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
      /<script type="f\/props" for="[^"]+">\{"start":2,"label":"a"\}<\/script>/,
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

  it("render without hydrating when props cannot travel, and say why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const markup = await html(
      h(ShowsIsland, { at: new Date(0), tags: [], id: 1, onPick: () => {} }),
    );
    expect(markup).not.toContain("<f-island");
    expect(warn.mock.calls[0]![0]).toContain("functions are not serializable");
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
