// @vitest-environment jsdom
import React, { act, createContext, use, useContext, useId, useState, type ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getValueStore } from "@farm.js/islx/client";
import { createIsland } from "@farm.js/islx/react";
import {
  createHydrationRuntime,
  createServerHtml,
  createServerTreeElement,
  createServerTreeLayout,
  withinClientRoot,
} from "@farm.js/islx/react/client";
import { parseHeldValues } from "@farm.js/islx/server";
import { Outlet, renderServerTree } from "@farm.js/islx/react/server";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- client modules ("use client"), wrapped the way the compiler wraps them on the server ------

const Panel = createContext<{ open: boolean; toggle(): void } | null>(null);
function PanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Panel.Provider value={{ open, toggle: () => setOpen((value) => !value) }}>
      {children}
    </Panel.Provider>
  );
}
function usePanel() {
  const panel = useContext(Panel);
  if (!panel) throw new Error("usePanel must be used within PanelProvider");
  return panel;
}
function HeaderButton() {
  const panel = usePanel();
  return (
    <button id="header" onClick={panel.toggle}>
      {panel.open ? "open" : "closed"}
    </button>
  );
}

function PageButtonSource({ label }: { label: string }) {
  const panel = usePanel();
  const id = useId();
  return (
    <button id="page" data-uid={id} onClick={panel.toggle}>
      {label}:{panel.open ? "open" : "closed"}
    </button>
  );
}
function CardSource({ title, children }: { title: string; children: ReactNode }) {
  const [count, setCount] = useState(0);
  return (
    <section>
      <h2>{title}</h2>
      <button id="card" onClick={() => setCount((value) => value + 1)}>
        {count}
      </button>
      {children}
    </section>
  );
}
function StarsSource({ stars }: { stars: Promise<number> }) {
  return <output id="stars">{use(stars)}</output>;
}
function CallbackSource({ onPick }: { onPick: () => void }) {
  return (
    <button id="callback" onClick={onPick}>
      pick
    </button>
  );
}
function CounterSource() {
  const [count, setCount] = useState(0);
  return (
    <button id="island" onClick={() => setCount((value) => value + 1)}>
      {count}
    </button>
  );
}

const modules: Record<string, Record<string, unknown>> = {
  "/src/page-button.tsx": { PageButton: PageButtonSource },
  "/src/card.tsx": { Card: CardSource },
  "/src/stars.tsx": { Stars: StarsSource },
  "/src/callback.tsx": { Callback: CallbackSource },
  "/src/counter.tsx": { Counter: CounterSource },
  "/src/panel.tsx": { PanelProvider, HeaderButton },
};
const PanelProviderIsland = createIsland(PanelProvider, "/src/panel.tsx", "PanelProvider", "load");
const HeaderButtonIsland = createIsland(HeaderButton, "/src/panel.tsx", "HeaderButton", "load");
const PageButton = createIsland(PageButtonSource, "/src/page-button.tsx", "PageButton", "load");
const Card = createIsland(CardSource, "/src/card.tsx", "Card", "load");
const Stars = createIsland(StarsSource, "/src/stars.tsx", "Stars", "load");
const Callback = createIsland(CallbackSource, "/src/callback.tsx", "Callback", "load");
const Counter = createIsland(CounterSource, "/src/counter.tsx", "Counter", "load");

// --- server components --------------------------------------------------------------------------

function Layout({ children }: { children: ReactNode }) {
  return (
    <PanelProvider>
      <header>
        <HeaderButton />
      </header>
      {children}
    </PanelProvider>
  );
}

async function Highlight() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return <strong>42</strong>;
}

function Frame({ children }: { children: ReactNode }) {
  return <main className="frame">{children}</main>;
}

async function HomePage() {
  const heading = await Promise.resolve("Hello");
  return (
    <Frame>
      <h1>{heading}</h1>
      <PageButton label="page" />
      <Card title="card">
        <p>
          server child <Highlight />
        </p>
      </Card>
      <ul>
        {["a", "b"].map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Frame>
  );
}

// --- harness ------------------------------------------------------------------------------------

const load = async (reference: string) => {
  const module = modules[reference];
  if (!module) throw new Error(`missing test module ${reference}`);
  return module;
};

function createClientRuntime() {
  const runtime = createHydrationRuntime({
    load,
    schedule: async ({ hydrate }) => hydrate(),
  });
  return { runtime, ServerHtml: createServerHtml(runtime) };
}

function routeTree(page: ReactNode) {
  return withinClientRoot(
    <Layout>
      <div id="page-root">{page}</div>
    </Layout>,
  );
}

async function renderPage(element: ReactNode) {
  const page = await renderServerTree(element, {});
  const stream = await renderToReadableStream(routeTree(page));
  await stream.allReady;
  return new Response(stream).text();
}

async function hydratePage(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  const { runtime, ServerHtml } = createClientRuntime();
  const page = await createServerTreeElement(container.querySelector("#page-root")!, {
    load,
    ServerHtml,
  });
  expect(page).not.toBeNull();
  const errors: unknown[] = [];
  let root!: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(container, routeTree(page), {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  mountedRoots.push(root);
  return { container, errors, root, runtime, ServerHtml };
}

const mountedRoots: Array<ReturnType<typeof hydrateRoot>> = [];

const click = (container: Element, selector: string) =>
  act(async () => (container.querySelector(selector) as HTMLButtonElement).click());

describe("server tree pages", () => {
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("hydrates an async page's client components inside the layout's React tree", async () => {
    const html = await renderPage(<HomePage />);
    expect(html).not.toContain("f-island");
    expect(html).toContain("<strong>42</strong>");

    const serverUid = /data-uid="([^"]+)"/.exec(html)?.[1];
    const { container, errors } = await hydratePage(html);
    expect(errors).toEqual([]);
    expect(container.querySelector("#page")!.getAttribute("data-uid")).toBe(serverUid);

    // One provider instance: the layout's header and the page's button share its state.
    await click(container, "#header");
    expect(container.querySelector("#page")!.textContent).toBe("page:open");
    await click(container, "#page");
    expect(container.querySelector("#header")!.textContent).toBe("closed");

    // Server JSX passed as children reaches the client component and stays server output.
    await click(container, "#card");
    expect(container.querySelector("#card")!.textContent).toBe("1");
    expect(container.querySelector("section p")!.innerHTML).toBe(
      "server child <strong>42</strong>",
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("passes resolved promises to client components without suspending hydration", async () => {
    async function Page() {
      return <Stars stars={Promise.resolve(7)} />;
    }
    const { container, errors } = await hydratePage(await renderPage(<Page />));
    expect(errors).toEqual([]);
    expect(container.querySelector("#stars")!.textContent).toBe("7");
  });

  it("streams Suspense content after its fallback and hydrates it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function Slow() {
      await gate;
      return <PageButton label="slow" />;
    }
    async function Page() {
      return (
        <React.Suspense fallback={<p id="fallback">loading</p>}>
          <Slow />
        </React.Suspense>
      );
    }

    const page = await renderServerTree(<Page />, {});
    const stream = await renderToReadableStream(routeTree(page));
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('id="fallback"');
    expect(first).not.toContain("slow:");
    release();
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toContain("slow<!-- -->:<!-- -->closed");
    expect(rest).toContain('type="f/chunk"');

    // A completed render, as the browser has it once the stream ends.
    const { container, errors } = await hydratePage(await renderPage(<Page />));
    expect(errors).toEqual([]);
    await click(container, "#header");
    expect(container.querySelector("#page")!.textContent).toBe("slow:open");
  });

  it("keeps a server component that calls hooks as server HTML whose client components are islands", async () => {
    function UsesHooks() {
      const id = useId();
      return (
        <div data-id={id}>
          <Counter />
        </div>
      );
    }
    async function Page() {
      return (
        <>
          <UsesHooks />
          <PageButton label="tree" />
        </>
      );
    }
    const html = await renderPage(<Page />);
    expect(html).toContain("<f-html");
    expect(html).toContain('<f-island src="/src/counter.tsx"');

    const { container, errors, runtime } = await hydratePage(html);
    expect(errors).toEqual([]);
    await vi.waitFor(() => expect(runtime.rootCount()).toBe(1));
    await click(container, "#island");
    expect(container.querySelector("#island")!.textContent).toBe("1");
    await click(container, "#header");
    expect(container.querySelector("#page")!.textContent).toBe("tree:open");
  });

  it("keeps a client component whose props do not serialize as server HTML", async () => {
    async function Page() {
      return (
        <>
          <Callback onPick={() => {}} />
          <PageButton label="tree" />
        </>
      );
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await renderPage(<Page />);
    expect(html).toMatch(/<f-html[^>]*><button id="callback"/);
    const { container, errors } = await hydratePage(html);
    expect(errors).toEqual([]);
    await click(container, "#header");
    expect(container.querySelector("#page")!.textContent).toBe("tree:open");
  });

  it("wraps the nearest element outside a table when a cell cannot be represented", async () => {
    function Cell() {
      useState(0);
      return <td>cell</td>;
    }
    async function Page() {
      return (
        <section>
          <table>
            <tbody>
              <tr>
                <Cell />
              </tr>
            </tbody>
          </table>
          <PageButton label="tree" />
        </section>
      );
    }
    const html = await renderPage(<Page />);
    expect(html).toContain("<section><f-html");
    expect(html).toMatch(/<f-html[^>]*><table>/);
    const { container, errors } = await hydratePage(html);
    expect(errors).toEqual([]);
    expect(container.querySelector("td")!.textContent).toBe("cell");
  });

  it("propagates errors thrown by the page", async () => {
    const control = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NOT_FOUND" });
    async function Missing(): Promise<ReactNode> {
      throw control;
    }
    async function Page() {
      return (
        <Frame>
          <Missing />
        </Frame>
      );
    }
    await expect(renderServerTree(<Page />, {})).rejects.toBe(control);
  });

  it("rebuilds a page from navigation HTML and re-renders it on a module update", async () => {
    const html = await renderPage(<HomePage />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const { runtime, ServerHtml } = createClientRuntime();
    const page = await createServerTreeElement(container.querySelector("#page-root")!.innerHTML, {
      load,
      ServerHtml,
      key: "/",
    });
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, routeTree(page));
    });
    mountedRoots.push(root);
    expect(container.querySelector("#page")!.textContent).toBe("page:closed");

    function NextPageButton({ label }: { label: string }) {
      return <button id="page">{label}:updated</button>;
    }
    await act(async () => {
      expect(runtime.update("/src/page-button.tsx", { PageButton: NextPageButton })).toBe(1);
    });
    expect(container.querySelector("#page")!.textContent).toBe("page:updated");
  });

  it("returns null for a page without a server tree", async () => {
    const { ServerHtml } = createClientRuntime();
    expect(await createServerTreeElement("<p>static</p>", { load, ServerHtml })).toBe(null);
  });

  describe("with values sent once", () => {
    const items = Array.from({ length: 120 }, (_, index) => ({
      id: `item-${index}`,
      label: `Catalog entry ${index} with a description long enough to matter`,
    }));
    function CatalogSource({ items }: { items: Array<{ id: string; label: string }> }) {
      const panel = usePanel();
      return <p id="catalog">{`${items.length} items, ${panel.open ? "open" : "closed"}`}</p>;
    }
    modules["/src/catalog.tsx"] = { Catalog: CatalogSource };
    const Catalog = createIsland(CatalogSource, "/src/catalog.tsx", "Catalog", "load");
    async function ShopPage() {
      await Promise.resolve();
      return (
        <main>
          <h1>Shop</h1>
          <Catalog items={items} />
        </main>
      );
    }
    const valueKeys = (html: string) =>
      [...html.matchAll(/<script type="f\/value" name="([0-9a-z]{14})"/g)].map(
        (match) => match[1]!,
      );
    async function renderValuesPage(headers: Record<string, string> = {}) {
      const request = new Request("http://localhost/shop", { headers });
      const page = await renderServerTree(<ShopPage />, { held: parseHeldValues(request) });
      const stream = await renderToReadableStream(routeTree(page));
      await stream.allReady;
      return await new Response(stream).text();
    }

    afterEach(() => {
      getValueStore().clear();
    });

    it("sends a large prop once, before the payload, and hydrates with it", async () => {
      const html = await renderValuesPage();
      const payload = /<script type="f\/tree">([^<]*)<\/script>/.exec(html)![1]!;
      expect(payload).toContain('"$":"r"');
      expect(payload).not.toContain("Catalog entry 7 with");
      expect(valueKeys(html).length).toBeGreaterThan(0);
      expect(html.lastIndexOf('type="f/value"')).toBeLessThan(html.indexOf('type="f/tree"'));

      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.append(container);
      const { ServerHtml } = createClientRuntime();
      const page = await createServerTreeElement(container.querySelector("#page-root")!, {
        load,
        ServerHtml,
        values: getValueStore(),
      });
      const errors: unknown[] = [];
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(container, routeTree(page), {
          onRecoverableError: (error) => errors.push(error),
        });
      });
      mountedRoots.push(root);
      expect(errors).toEqual([]);
      expect(container.querySelector("#catalog")!.textContent).toBe("120 items, closed");
      // The page's client component reads the layout's context.
      await click(container, "#header");
      expect(container.querySelector("#catalog")!.textContent).toBe("120 items, open");
    });

    it("rebuilds navigation HTML that leaves out the values the browser holds", async () => {
      const first = await renderValuesPage();
      const keys = valueKeys(first);
      const store = getValueStore();
      store.ingest(Object.assign(document.createElement("div"), { innerHTML: first }));

      const navigation = await renderValuesPage({ "F-Values": keys.join(",") });
      expect(valueKeys(navigation)).toEqual([]);
      expect(navigation.length).toBeLessThan(first.length - 5000);

      const page = await createServerTreeElement(
        Object.assign(document.createElement("div"), { innerHTML: navigation }).querySelector(
          "#page-root",
        )!,
        { load, ServerHtml: createClientRuntime().ServerHtml, values: store },
      );
      const container = document.createElement("div");
      document.body.append(container);
      const { createRoot } = await import("react-dom/client");
      const root = createRoot(container);
      await act(async () => root.render(routeTree(page)));
      mountedRoots.push(root as unknown as ReturnType<typeof hydrateRoot>);
      expect(container.querySelector("#catalog")!.textContent).toBe("120 items, closed");
    });
  });

  describe("payload-only navigations", () => {
    async function renderRoute(element: ReactNode, payloadOnly: boolean) {
      const page = await renderServerTree(element, {
        payloadOnly,
      });
      const stream = await renderToReadableStream(routeTree(page));
      await stream.allReady;
      return new Response(stream).text();
    }
    async function rebuild(html: string) {
      const source = Object.assign(document.createElement("div"), { innerHTML: html });
      const page = await createServerTreeElement(source.querySelector("#page-root")!, {
        load,
        ServerHtml: createClientRuntime().ServerHtml,
      });
      expect(page).not.toBeNull();
      const container = document.createElement("div");
      document.body.append(container);
      const { createRoot } = await import("react-dom/client");
      const root = createRoot(container);
      await act(async () => root.render(routeTree(page)));
      mountedRoots.push(root as unknown as ReturnType<typeof hydrateRoot>);
      return container;
    }

    it("sends the payload without the page's HTML, and the browser rebuilds the same page", async () => {
      const full = await renderRoute(<HomePage />, false);
      const payloadOnly = await renderRoute(<HomePage />, true);
      expect(full).toContain("<h1>Hello</h1>");
      expect(payloadOnly).not.toContain("<h1>Hello</h1>");
      expect(payloadOnly).not.toContain('id="card"');
      expect(payloadOnly).toContain('type="f/tree" partial');

      const fromFull = await rebuild(full);
      const fromPayload = await rebuild(payloadOnly);
      // The same page, but for useId, which counts per root.
      const page = (container: Element) =>
        container.querySelector("#page-root")!.innerHTML.replace(/data-uid="[^"]+"/g, "");
      expect(page(fromPayload)).toBe(page(fromFull));
      // Client components still read the layout's context.
      await click(fromPayload, "#header");
      expect(fromPayload.querySelector("#page")!.textContent).toBe("page:open");
    });

    it("waits for Suspense chunks and sends their payloads", async () => {
      async function Slow() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return <PageButton label="slow" />;
      }
      async function Page() {
        return (
          <React.Suspense fallback={<p id="fallback">loading</p>}>
            <Slow />
          </React.Suspense>
        );
      }
      const payloadOnly = await renderRoute(<Page />, true);
      expect(payloadOnly).toContain('type="f/chunk"');
      // The fallback travels in the payload, not as HTML.
      expect(payloadOnly).not.toContain('<p id="fallback">');
      const container = await rebuild(payloadOnly);
      expect(container.querySelector("#page")!.textContent).toBe("slow:closed");
    });

    it("renders the page whole when a chunk fails, so its error boundary applies", async () => {
      async function Broken(): Promise<never> {
        throw new Error("chunk failed");
      }
      async function Page() {
        return (
          <React.Suspense fallback={<p>loading</p>}>
            <Broken />
          </React.Suspense>
        );
      }
      vi.spyOn(console, "error").mockImplementation(() => {});
      const page = await renderServerTree(<Page />, {
        payloadOnly: true,
      });
      const stream = await renderToReadableStream(routeTree(page), { onError: () => {} });
      await stream.allReady;
      const html = await new Response(stream).text();
      expect(html).not.toContain('type="f/tree" partial');
    });
  });
});

describe("server tree layouts", () => {
  afterEach(() => {
    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  // A server layout around a client provider: its module stays on the server.
  async function SlowNote() {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return <small id="note">LAYOUT_SERVER_VALUE</small>;
  }
  function ServerLayout({ children }: { children: ReactNode }) {
    return (
      <PanelProviderIsland>
        <header>
          <HeaderButtonIsland />
          <React.Suspense fallback={<i>…</i>}>
            <SlowNote />
          </React.Suspense>
        </header>
        {children}
      </PanelProviderIsland>
    );
  }
  async function SlowPage() {
    return (
      <React.Suspense fallback={<i>…</i>}>
        <Highlight />
        <PageButton label="page" />
      </React.Suspense>
    );
  }
  const pageRoot = (page: ReactNode) => <div id="page-root">{page}</div>;

  async function renderRoute(
    layoutElement: ReactNode = (
      <ServerLayout>
        <Outlet />
      </ServerLayout>
    ),
  ) {
    const page = await renderServerTree(<SlowPage />, {});
    const layout = await renderServerTree(layoutElement, {
      outlets: { children: pageRoot(page) },
      scope: "/",
    });
    const stream = await renderToReadableStream(withinClientRoot(layout));
    await stream.allReady;
    return new Response(stream).text();
  }

  async function hydrateRoute(html: string) {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const { ServerHtml } = createClientRuntime();
    const layout = await createServerTreeLayout(container, "/", { load, ServerHtml });
    const page = await createServerTreeElement(container.querySelector("#page-root")!, {
      load,
      ServerHtml,
    });
    expect(layout).not.toBeNull();
    const errors: unknown[] = [];
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(
        container,
        withinClientRoot(layout!.render({ children: pageRoot(page) })),
        {
          onRecoverableError: (error) => errors.push(error),
        },
      );
    });
    mountedRoots.push(root);
    return { container, errors, layout: layout!, root };
  }

  it("rebuilds the layout from its tree, so the page reads the provider's context", async () => {
    const html = await renderRoute();
    expect(html).toContain('<script type="f/tree" name="/">');
    // Both trees streamed a chunk numbered 0; the layout's is named by its scope.
    expect(html).toContain('type="f/chunk" name="/:0"');
    expect(html).toContain('type="f/chunk" name="0"');

    const { container, errors, layout } = await hydrateRoute(html);
    expect(errors).toEqual([]);
    expect(container.querySelector("#note")!.textContent).toBe("LAYOUT_SERVER_VALUE");
    await click(container, "#header");
    expect(container.querySelector("#page")!.textContent).toBe("page:open");
    await click(container, "#page");
    expect(container.querySelector("#header")!.textContent).toBe("closed");
    layout.dispose();
  });

  it("keeps the provider's state when the page at its outlet changes", async () => {
    const { container, layout, root } = await hydrateRoute(await renderRoute());
    await click(container, "#header");
    expect(container.querySelector("#header")!.textContent).toBe("open");
    await act(async () => {
      root.render(
        withinClientRoot(layout.render({ children: pageRoot(<p id="next">next page</p>) })),
      );
    });
    expect(container.querySelector("#next")).not.toBeNull();
    expect(container.querySelector("#header")!.textContent).toBe("open");
    layout.dispose();
  });

  it("puts the payload after the layout when it renders no outlet", async () => {
    const html = await renderRoute(<ServerLayout>{null}</ServerLayout>);
    expect(html).toMatch(/<\/header><script type="f\/tree" name="\/">/);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const { ServerHtml } = createClientRuntime();
    const layout = (await createServerTreeLayout(container, "/", { load, ServerHtml }))!;
    const errors: unknown[] = [];
    await act(async () => {
      mountedRoots.push(
        hydrateRoot(container, withinClientRoot(layout.render({})), {
          onRecoverableError: (error) => errors.push(error),
        }),
      );
    });
    expect(errors).toEqual([]);
    await click(container, "#header");
    expect(container.querySelector("#header")!.textContent).toBe("open");
    layout.dispose();
  });

  it("re-renders through onUpdate when one of its client modules changes", async () => {
    const container = document.createElement("div");
    container.innerHTML = await renderRoute();
    const { ServerHtml } = createClientRuntime();
    const onUpdate = vi.fn();
    const layout = (await createServerTreeLayout(container, "/", { load, ServerHtml, onUpdate }))!;
    const { updateServerTrees } = await import("@farm.js/islx/react/client");
    expect(updateServerTrees("/src/panel.tsx", modules["/src/panel.tsx"]!)).toBeGreaterThan(0);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    layout.dispose();
    expect(updateServerTrees("/src/panel.tsx", modules["/src/panel.tsx"]!)).toBe(0);
  });

  it("hydrates navigation HTML that leaves out the layout's values the browser holds", async () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: `nav-${index}`,
      label: `Entry ${index}`,
    }));
    function NavListSource({ items }: { items: Array<{ id: string }> }) {
      const panel = usePanel();
      return <p id="nav-list">{`${items.length} ${panel.open ? "open" : "closed"}`}</p>;
    }
    modules["/src/nav-list.tsx"] = { NavList: NavListSource };
    const NavList = createIsland(NavListSource, "/src/nav-list.tsx", "NavList", "load");
    function ValuesLayout({ children }: { children: ReactNode }) {
      return (
        <PanelProviderIsland>
          <header>
            <HeaderButtonIsland />
            <NavList items={items} />
          </header>
          <main>{children}</main>
        </PanelProviderIsland>
      );
    }
    const render = async (held: ReadonlySet<string> | null) => {
      const layout = await renderServerTree(
        <ValuesLayout>
          <Outlet />
        </ValuesLayout>,
        {
          outlets: { children: pageRoot(<p>page</p>) },
          scope: "/",
          held,
        },
      );
      const stream = await renderToReadableStream(withinClientRoot(layout));
      await stream.allReady;
      return new Response(stream).text();
    };
    const hydrate = async (html: string) => {
      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.append(container);
      const { ServerHtml } = createClientRuntime();
      const layout = (await createServerTreeLayout(container, "/", {
        load,
        ServerHtml,
        values: getValueStore(),
      }))!;
      const errors: unknown[] = [];
      let root!: ReturnType<typeof hydrateRoot>;
      await act(async () => {
        root = hydrateRoot(
          container,
          withinClientRoot(layout.render({ children: pageRoot(<p>page</p>) })),
          { onRecoverableError: (error) => errors.push(error) },
        );
      });
      const text = container.querySelector("#nav-list")!.textContent;
      act(() => root.unmount());
      layout.dispose();
      return { text, errors };
    };

    const first = await render(null);
    const keys = [...first.matchAll(/<script type="f\/value" name="([0-9a-z]{14})"/g)].map(
      (m) => m[1]!,
    );
    expect(keys.length).toBeGreaterThan(0);
    expect((await hydrate(first)).errors).toEqual([]);

    // A navigation names the values it holds; the server leaves them out.
    const next = await render(new Set(keys));
    expect(next).not.toContain('type="f/value"');
    const { text, errors } = await hydrate(next);
    expect(errors).toEqual([]);
    expect(text).toBe("40 closed");
    getValueStore().clear();
  });

  it("returns null when the document has no tree for the layout", async () => {
    const container = document.createElement("div");
    container.innerHTML = await renderRoute();
    const { ServerHtml } = createClientRuntime();
    expect(await createServerTreeLayout(container, "/docs", { load, ServerHtml })).toBeNull();
  });
});
