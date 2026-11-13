// @vitest-environment node
// Node's Blob and FormData read their bytes; jsdom's cannot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerReference } from "@farm.js/islx/client";
import {
  bindInlineAction,
  configureActionKeys,
  generateActionKey,
  handleAction,
  registerInlineAction,
  registerServerReference,
} from "@farm.js/islx/server";

function serve(options: Parameters<typeof handleAction>[1] = {}) {
  // The action client runs in a browser, where the page has a location.
  vi.stubGlobal("location", new URL("http://localhost/page"));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    handleAction(
      new Request(url, {
        ...init,
        headers: { ...(init.headers as object), origin: new URL(url).origin },
      }),
      options,
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an action's result", () => {
  it("send global symbols, errors, iterators, blobs and form data, as React Server Components do", async () => {
    const make = async () => {
      const form = new FormData();
      form.append("name", "kinfe");
      form.append("file", new Blob(["bytes"], { type: "text/plain" }));
      return {
        symbol: Symbol.for("islx.test"),
        error: new Error("database password is hunter2"),
        items: (function* () {
          yield 1;
          yield "two";
        })(),
        blob: new Blob(["hello"], { type: "text/plain" }),
        form,
        later: Promise.resolve(new Blob(["later"])),
      };
    };
    registerServerReference(make, "flight-types");
    serve();
    const result = (await createServerReference("flight-types")()) as {
      symbol: symbol;
      error: Error;
      items: Iterator<unknown>;
      blob: Blob;
      form: FormData;
      later: Promise<Blob>;
    };
    expect(result.symbol).toBe(Symbol.for("islx.test"));
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).not.toContain("hunter2");
    expect([...(result.items as unknown as Iterable<unknown>)]).toEqual([1, "two"]);
    expect(result.blob.type).toBe("text/plain");
    expect(await result.blob.text()).toBe("hello");
    expect(result.form.get("name")).toBe("kinfe");
    expect(await (result.form.get("file") as Blob).text()).toBe("bytes");
    expect(await (await result.later).text()).toBe("later");
  });

  it("send an inline action with captured values, sealed before the result is encoded", async () => {
    configureActionKeys({ key: generateActionKey() });
    registerInlineAction(
      async ([prefix]: unknown[], name: unknown) => `${prefix} ${name}`,
      "flight-greet",
      1,
    );
    const greet = (prefix: string) => bindInlineAction("flight-greet", () => [prefix], ["prefix"]);
    const make = async () => ({
      greet: greet("hello"),
      later: Promise.resolve(greet("later")),
      all: (function* () {
        yield greet("each");
      })(),
    });
    registerServerReference(make, "flight-inline");
    serve();
    const result = (await createServerReference("flight-inline")()) as {
      greet: (name: string) => Promise<string>;
      later: Promise<(name: string) => Promise<string>>;
      all: Iterable<(name: string) => Promise<string>>;
    };
    expect(await result.greet("kinfe")).toBe("hello kinfe");
    expect(await (await result.later)("kinfe")).toBe("later kinfe");
    expect(await [...result.all][0]!("kinfe")).toBe("each kinfe");
  });
});
