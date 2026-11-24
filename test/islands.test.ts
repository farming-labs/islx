// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createIslandRuntime,
  defineIslandRenderer,
  scheduleHydration,
  type IslandRenderer,
} from "@farm.js/islx/islands/client";
import {
  renderIslandMarkup,
  resolveIslandMarkup,
  type IslandMarkupParts,
} from "@farm.js/islx/islands/server";
import { createValueStore } from "@farm.js/islx/client";

/**
 * A renderer with no virtual DOM and no React: a component writes a string on the server and, in
 * the browser, attaches its behavior to the markup it wrote.
 */
interface TinyComponent<P> {
  render(props: P): string;
  attach(root: Element, props: P): () => void;
}

const tiny = defineIslandRenderer({
  hydrate(container, component, props) {
    const detach = (component as TinyComponent<Record<string, unknown>>).attach(container, props);
    return { unmount: detach };
  },
});

interface CounterProps {
  start: number;
  since: Date;
  tags: Map<string, number>;
}

const Counter: TinyComponent<CounterProps> = {
  render: ({ start }) => `<button type="button">${start}</button>`,
  attach(root, { start }) {
    const button = root.querySelector("button")!;
    let count = start;
    const onClick = () => {
      count += 1;
      button.textContent = String(count);
    };
    button.addEventListener("click", onClick);
    return () => button.removeEventListener("click", onClick);
  },
};

const counterProps: CounterProps = {
  start: 2,
  since: new Date("2026-11-23T10:00:00.000Z"),
  tags: new Map([["a", 1]]),
};

function serverPage(markup: string): void {
  document.body.innerHTML = `<main>${markup}</main>`;
}

function runtimeFor(
  modules: Record<string, Record<string, unknown>>,
  renderer: IslandRenderer = tiny,
  report = vi.fn(),
) {
  return createIslandRuntime({
    renderer,
    load: async (src) => modules[src]!,
    schedule: scheduleHydration,
    values: createValueStore(),
    report,
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("renderIslandMarkup", () => {
  it("wraps the renderer's HTML in an island with its props script", () => {
    const markup = renderIslandMarkup({
      src: "/src/counter.ts",
      export: "Counter",
      strategy: "visible",
      id: "i0",
      props: counterProps as unknown as Record<string, unknown>,
      html: Counter.render(counterProps),
    });

    expect(markup).toBe(
      '<f-island src="/src/counter.ts" export="Counter" props="i0" strategy="visible" style="display:contents">' +
        '<button type="button">2</button></f-island>' +
        '<script type="f/props" for="i0">' +
        '{"start":2,"since":{"$":"D","v":"2026-11-23T10:00:00.000Z"},"tags":{"$":"M","v":[["a",1]]}}' +
        "</script>",
    );
  });

  it("keeps a closing script tag in a prop from ending the props script", () => {
    const markup = renderIslandMarkup({
      src: "/src/note.ts",
      id: "i0",
      props: { text: '</script><script>alert("x")</script>' },
      html: "",
    });

    expect(markup).not.toContain("</script><script>");
    expect(markup.match(/<\/script>/g)).toHaveLength(1);
  });

  it("sends a large value once for every island in the response", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: index, name: `row ${index}` }));
    const sent = new Set<string>();
    const first = renderIslandMarkup({ src: "/a.ts", id: "i0", props: { rows }, html: "", sent });
    const second = renderIslandMarkup({ src: "/b.ts", id: "i1", props: { rows }, html: "", sent });

    expect(first.match(/<script type="f\/value"/g)).toHaveLength(1);
    expect(second).not.toContain('type="f/value"');
    expect(second).toContain('{"$":"r"');
    expect(sent.size).toBe(1);
  });

  it("refuses a function prop and names the island", () => {
    expect(() =>
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        id: "i0",
        props: { onChange: function onChange() {} },
        html: "",
      }),
    ).toThrow(
      "Counter (/src/counter.ts) cannot get its props in the browser: functions are not serializable (onChange)",
    );
  });
});

describe("resolveIslandMarkup", () => {
  it("returns the parts renderIslandMarkup writes, with attributes left for the renderer to escape", () => {
    const input = {
      src: '/src/a&b".ts',
      export: "Counter",
      strategy: "idle" as const,
      id: "i0",
      props: { text: "</script>", since: counterProps.since },
    };
    const parts = resolveIslandMarkup(input);

    expect(parts.values).toEqual([]);
    expect(parts.element).toEqual({
      tag: "f-island",
      attributes: {
        src: '/src/a&b".ts',
        export: "Counter",
        props: "i0",
        strategy: "idle",
        style: "display:contents",
      },
    });
    expect(parts.script.attributes).toEqual({ type: "f/props", for: "i0" });
    expect(parts.script.text).not.toContain("</script>");
    expect(JSON.parse(parts.script.text)).toEqual({
      text: "</script>",
      since: { $: "D", v: "2026-11-23T10:00:00.000Z" },
    });
    expect(renderIslandMarkup({ ...input, html: "<b>x</b>" })).toBe(
      '<f-island src="/src/a&amp;b&quot;.ts" export="Counter" props="i0" strategy="idle" style="display:contents">' +
        `<b>x</b></f-island><script type="f/props" for="i0">${parts.script.text}</script>`,
    );
  });

  it("returns a shared value's script once per response", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: index, name: `row ${index}` }));
    const sent = new Set<string>();
    const first = resolveIslandMarkup({ src: "/a.ts", id: "i0", props: { rows }, sent });
    const second = resolveIslandMarkup({ src: "/b.ts", id: "i1", props: { rows }, sent });

    expect(first.values).toHaveLength(1);
    expect(first.values[0]!.attributes).toEqual({ type: "f/value", name: [...sent][0] });
    expect(second.values).toEqual([]);
    expect(second.script.text).toContain('{"$":"r"');
  });

  it("refuses a function prop and names the island, as renderIslandMarkup does", () => {
    expect(() =>
      resolveIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        id: "i0",
        props: { onChange: function onChange() {} },
      }),
    ).toThrow(
      "Counter (/src/counter.ts) cannot get its props in the browser: functions are not serializable (onChange)",
    );
  });
});

describe("createIslandRuntime", () => {
  it("hydrates an island with a renderer that is not React, keeping the server's DOM", async () => {
    serverPage(
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        id: "i0",
        props: counterProps as unknown as Record<string, unknown>,
        html: Counter.render(counterProps),
      }),
    );
    const serverButton = document.querySelector("button")!;
    let received: Record<string, unknown> | undefined;
    const hydrated = vi.fn();
    document.addEventListener("f:hydrate", hydrated);

    await runtimeFor(
      { "/src/counter.ts": { Counter } },
      defineIslandRenderer({
        hydrate(container, component, props) {
          received = props;
          return tiny.hydrate(container, component, props);
        },
      }),
    ).hydrate();

    expect(document.querySelector("button")).toBe(serverButton);
    serverButton.click();
    expect(serverButton.textContent).toBe("3");
    expect(received!.since).toEqual(counterProps.since);
    expect(received!.tags).toEqual(counterProps.tags);
    expect(document.querySelector("f-island")!.hasAttribute("hydrated")).toBe(true);
    expect(hydrated).toHaveBeenCalledTimes(1);
    document.removeEventListener("f:hydrate", hydrated);
  });

  it("hydrates an island a renderer built as elements from resolveIslandMarkup's parts", async () => {
    const parts: IslandMarkupParts = resolveIslandMarkup({
      src: "/src/counter.ts",
      export: "Counter",
      id: "i0",
      props: counterProps as unknown as Record<string, unknown>,
    });
    // What an element-building renderer does with the parts: set the attributes as they are, and
    // write the script text raw.
    const build = (tag: string, attributes: Record<string, string>, html: string) => {
      const element = document.createElement(tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      element.innerHTML = html;
      return element;
    };
    const main = document.createElement("main");
    main.append(
      ...parts.values.map((value) => build("script", value.attributes, value.text)),
      build(parts.element.tag, parts.element.attributes, Counter.render(counterProps)),
      build("script", parts.script.attributes, parts.script.text),
    );
    document.body.append(main);
    const serverButton = document.querySelector("button")!;
    let received: Record<string, unknown> | undefined;

    await runtimeFor(
      { "/src/counter.ts": { Counter } },
      defineIslandRenderer({
        hydrate(container, component, props) {
          received = props;
          return tiny.hydrate(container, component, props);
        },
      }),
    ).hydrate();

    expect(document.querySelector("button")).toBe(serverButton);
    serverButton.click();
    expect(serverButton.textContent).toBe("3");
    expect(received!.since).toEqual(counterProps.since);
    expect(received!.tags).toEqual(counterProps.tags);
  });

  it("tells the renderer which island it hydrates, so page-wide keys can be namespaced", async () => {
    serverPage(
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        strategy: "idle",
        id: "i7",
        props: counterProps as unknown as Record<string, unknown>,
        html: Counter.render(counterProps),
      }),
    );
    const islands: unknown[] = [];

    await runtimeFor(
      { "/src/counter.ts": { Counter } },
      defineIslandRenderer({
        hydrate(container, component, props, island) {
          islands.push(island);
          return tiny.hydrate(container, component, props);
        },
      }),
    ).hydrate();

    expect(islands).toEqual([
      { id: "i7", src: "/src/counter.ts", export: "Counter", strategy: "idle" },
    ]);
  });

  it("resolves a value another island's markup sent", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: index, name: `row ${index}` }));
    const List: TinyComponent<{ rows: typeof rows }> = {
      render: ({ rows }) => `<ul>${rows.map((row) => `<li>${row.name}</li>`).join("")}</ul>`,
      attach: () => () => {},
    };
    const sent = new Set<string>();
    serverPage(
      renderIslandMarkup({
        src: "/l.ts",
        id: "i0",
        props: { rows },
        html: List.render({ rows }),
        sent,
      }) +
        renderIslandMarkup({
          src: "/l.ts",
          id: "i1",
          props: { rows },
          html: List.render({ rows }),
          sent,
        }),
    );
    const received: unknown[] = [];

    await runtimeFor(
      { "/l.ts": { default: List } },
      defineIslandRenderer({
        hydrate(container, component, props) {
          received.push(props.rows);
          return tiny.hydrate(container, component, props);
        },
      }),
    ).hydrate();

    expect(received).toEqual([rows, rows]);
  });

  it("replays a click made before an interaction island hydrated", async () => {
    serverPage(
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        strategy: "interaction",
        id: "i0",
        props: counterProps as unknown as Record<string, unknown>,
        html: Counter.render(counterProps),
      }),
    );
    const button = document.querySelector("button")!;
    const runtime = runtimeFor({ "/src/counter.ts": { Counter } });
    const hydration = runtime.hydrate();
    // The held click never reaches the button; the first click it sees is the replay.
    const replayed = new Promise((resolve) =>
      button.addEventListener("click", resolve, { once: true }),
    );

    expect(button.textContent).toBe("2");
    button.click();
    await hydration;
    await replayed;

    expect(button.textContent).toBe("3");
  });

  it("restores the server HTML when the renderer throws", async () => {
    serverPage(
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        id: "i0",
        props: counterProps as unknown as Record<string, unknown>,
        html: Counter.render(counterProps),
      }),
    );
    const report = vi.fn();
    const failure = new Error("mismatch");

    await runtimeFor(
      { "/src/counter.ts": { Counter } },
      defineIslandRenderer({
        hydrate(container) {
          container.innerHTML = "<p>half rendered</p>";
          throw failure;
        },
      }),
      report,
    ).hydrate();

    expect(document.querySelector("f-island")!.innerHTML).toBe('<button type="button">2</button>');
    expect(document.querySelector("f-island")!.hasAttribute("hydrated")).toBe(false);
    expect(report).toHaveBeenCalledWith(
      "Could not hydrate Counter (/src/counter.ts). Its server HTML was restored.",
      failure,
    );
  });

  it("reports a module without the island's export and keeps its HTML", async () => {
    serverPage(
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Missing",
        id: "i0",
        props: {},
        html: "<p>static</p>",
      }),
    );
    const report = vi.fn();

    await runtimeFor({ "/src/counter.ts": { Counter } }, tiny, report).hydrate();

    expect(document.querySelector("f-island")!.innerHTML).toBe("<p>static</p>");
    expect(report.mock.calls[0]![1]).toEqual(new Error("/src/counter.ts has no export Missing"));
  });

  it("unmounts its islands on dispose", async () => {
    serverPage(
      renderIslandMarkup({
        src: "/src/counter.ts",
        export: "Counter",
        id: "i0",
        props: counterProps as unknown as Record<string, unknown>,
        html: Counter.render(counterProps),
      }),
    );
    const runtime = runtimeFor({ "/src/counter.ts": { Counter } });
    await runtime.hydrate();
    const button = document.querySelector("button")!;

    runtime.dispose();
    button.click();

    expect(button.textContent).toBe("2");
  });
});
