// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { VALUES_HEADER, decode } from "@farm.js/islx";
import { createValueStore, getValueStore, valueHeaders } from "@farm.js/islx/client";
import {
  addressValues,
  escapeScriptJson,
  hashValue,
  parseHeldValues,
  selectValuesToSend,
} from "@farm.js/islx/server";

// A docs navigation tree: what a layout passes to its sidebar and its mobile menu.
const tree = Array.from({ length: 6 }, (_, section) => ({
  title: `Section ${section}`,
  items: Array.from({ length: 8 }, (_, item) => ({
    title: `Page ${section}.${item} about caching and rendering`,
    href: `/docs/${section}/${item}`,
  })),
}));

/** The HTML a server writes for addressed props: value scripts, then the props. */
function render(
  addressed: ReturnType<typeof addressValues>,
  held: ReadonlySet<string> | null = null,
) {
  return (
    selectValuesToSend(addressed, held)
      .map(
        ({ key, json }) =>
          `<script type="f/value" name="${key}">${escapeScriptJson(json)}</script>`,
      )
      .join("") + `<script type="f/props">${escapeScriptJson(addressed.json)}</script>`
  );
}

function read(html: string) {
  const store = createValueStore();
  const root = Object.assign(document.createElement("div"), { innerHTML: html });
  store.ingest(root);
  const props = JSON.parse(root.querySelector('script[type="f/props"]')!.textContent!);
  return { store, value: decode(store.resolve(props)) };
}

describe("values sent once", () => {
  it("hashes JSON to a stable 14-character key", () => {
    expect(hashValue('{"a":1}')).toMatch(/^[0-9a-z]{14}$/);
    expect(hashValue('{"a":1}')).toBe(hashValue('{"a":1}'));
    expect(hashValue('{"a":1}')).not.toBe(hashValue('{"a":2}'));
  });

  it("addresses large values and leaves small ones inline", () => {
    const addressed = addressValues({ tree, label: "Docs" });
    expect(addressed.json).toMatch(/^\{"tree":\{"\$":"r","v":"[0-9a-z]{14}"\},"label":"Docs"\}$/);
    expect(addressed.roots).toHaveLength(1);
    const { value } = read(render(addressed));
    expect(value).toEqual({ tree, label: "Docs" });
  });

  it("shares a value between islands and leaves out what the browser holds", () => {
    const sidebar = addressValues({ tree, label: "Sidebar" });
    const menu = addressValues({ tree, label: "Menu" });
    expect(sidebar.roots).toEqual(menu.roots);
    const held = new Set(sidebar.values.keys());
    expect(selectValuesToSend(menu, held)).toEqual([]);
    expect(selectValuesToSend(menu, null).length).toBeGreaterThan(0);
  });

  it("shares the unchanged parts of a value that changed in one place", () => {
    const before = addressValues({ tree });
    const changed = structuredClone(tree);
    changed[5]!.items[7]!.title = "Renamed";
    const after = addressValues({ tree: changed });
    const send = selectValuesToSend(after, new Set(before.values.keys()));
    // The changed section and the tree around it travel; the other five sections do not.
    expect(send.length).toBeLessThan(after.values.size);
    expect(send.length).toBeGreaterThan(0);
  });

  it("addresses typed values: a Map of dates shares like any value", () => {
    const stock = new Map(
      Array.from({ length: 40 }, (_, index) => [
        `sku-${index}`,
        new Date(Date.UTC(2026, 0, index + 1)),
      ]),
    );
    const addressed = addressValues({ stock, tags: new Set(["a"]), id: 1n });
    expect(addressed.roots.length).toBeGreaterThan(0);
    const { value } = read(render(addressed)) as { value: any };
    expect(value.stock).toBeInstanceOf(Map);
    expect(value.stock.get("sku-3")).toEqual(new Date(Date.UTC(2026, 0, 4)));
    expect(value.tags).toEqual(new Set(["a"]));
    expect(value.id).toBe(1n);
  });

  it("wraps app data that looks like a tag", () => {
    const lookalike = { $: "r", v: "04jiw29097x8ki" };
    const { value } = read(
      render(addressValues({ lookalike, big: { $: "D", text: "x".repeat(600) } })),
    );
    expect(value).toEqual({ lookalike, big: { $: "D", text: "x".repeat(600) } });
  });

  it("encodes actions and slots through the adapter's hook", () => {
    const action = async () => {};
    const addressed = addressValues(
      { onSave: action },
      { encodeSpecial: (value) => (value === action ? { $: "a", v: "abc" } : undefined) },
    );
    expect(addressed.json).toBe('{"onSave":{"$":"a","v":"abc"}}');
    expect(() => addressValues({ onSave: action })).toThrow("functions are not serializable");
  });

  it("escapes script-breaking characters", () => {
    const { value } = read(render(addressValues({ html: "</script><script>alert(1)</script> " })));
    expect(value).toEqual({ html: "</script><script>alert(1)</script> " });
  });
});

describe("held values", () => {
  it("parses only well-formed keys, at most 128", () => {
    const keys = Array.from({ length: 200 }, (_, index) => hashValue(String(index)));
    const held = parseHeldValues(["bad key", "__proto__", ...keys].join(","));
    expect(held.size).toBe(128);
    expect(held.has("__proto__")).toBe(false);
    const request = new Request("https://app.test/", { headers: { [VALUES_HEADER]: keys[0]! } });
    expect([...parseHeldValues(request)]).toEqual([keys[0]]);
    expect(parseHeldValues(null).size).toBe(0);
  });

  it("names what the browser holds, most recently used last", () => {
    const store = getValueStore();
    expect(valueHeaders()).toEqual({});
    const addressed = addressValues({ tree });
    store.ingest(Object.assign(document.createElement("div"), { innerHTML: render(addressed) }));
    const header = valueHeaders()[VALUES_HEADER]!;
    expect(header.split(",")).toEqual(expect.arrayContaining(addressed.roots));
    store.clear();
    expect(valueHeaders()).toEqual({});
  });

  it("refuses a value that refers to itself", () => {
    const store = createValueStore();
    const key = hashValue("x");
    store.ingest(
      Object.assign(document.createElement("div"), {
        innerHTML: `<script type="f/value" name="${key}">{"$":"r","v":"${key}"}</script>`,
      }),
    );
    expect(() => store.resolve({ $: "r", v: key })).toThrow("refers to itself");
  });
});
