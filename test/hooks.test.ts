// @vitest-environment jsdom
import { parseSync } from "oxc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineClientHooks, hookEventName, setClientHooks } from "@farmjs/islx/client";
import { emit } from "../src/client/hooks";
import {
  configureActionKeys,
  defineServerHooks,
  generateActionKey,
  handleAction,
  registerServerReference,
  setServerHooks,
} from "@farmjs/islx/server";
import { serializeHooks } from "@farmjs/islx/vite";

const parse = (file: string, code: string) => {
  const result = parseSync(file, code);
  return Object.assign(result.program, { errors: result.errors }) as any;
};

afterEach(() => {
  setClientHooks(undefined);
  setServerHooks(undefined);
});

describe("hooks written in the config", () => {
  it("copy methods and arrow functions as source", async () => {
    const code = serializeHooks(
      {
        navigated({ url }: { url: URL }) {
          console.log(url);
        },
        hydrate: (event: { duration: number }) => console.log(event.duration),
        async action(_info: unknown, run: () => Promise<unknown>) {
          return run();
        },
      },
      "client",
      parse,
    );
    const module = await import(
      /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`
    );
    expect(Object.keys(module.default)).toEqual(["navigated", "hydrate", "action"]);
    expect(await module.default.action({}, async () => 7)).toBe(7);
  });

  it("refuse callbacks that use what only exists where they were written", () => {
    const analytics = { page: (_: string) => {} };
    expect(() =>
      serializeHooks(
        { navigated: ({ url }: { url: URL }) => analytics.page(url.href) },
        "client",
        parse,
      ),
    ).toThrow(/hooks\.client uses `analytics`, which does not exist where the hook runs/);
    // Made with Function: the test runner would otherwise rewrite the import() in it.
    const importing = new Function('return async () => (await import("node:path")).join("a")')();
    expect(() => serializeHooks({ navigated: importing }, "client", parse)).toThrow(
      "uses `import()`",
    );
    expect(() => serializeHooks({ navigated: "nope" as unknown }, "client", parse)).toThrow(
      "must be a function",
    );
    // Browser globals are fine in the browser, not on the server.
    expect(() =>
      serializeHooks({ navigated: () => window.scrollTo(0, 0) }, "client", parse),
    ).not.toThrow();
    expect(() => serializeHooks({ action: () => window.scrollTo(0, 0) }, "server", parse)).toThrow(
      "`window`",
    );
  });
});

describe("client hooks", () => {
  it("run, and fire DOM events named with f:", () => {
    const seen: string[] = [];
    setClientHooks(
      defineClientHooks({ navigated: ({ url }) => seen.push(`hook ${url.pathname}`) }),
    );
    document.addEventListener(
      "f:navigated",
      (event) => seen.push(`dom ${(event as CustomEvent).detail.url.pathname}`),
      { once: true },
    );
    expect(emit("navigated", { url: new URL("https://app.test/a"), duration: 1 })).toBe(true);
    expect(seen).toEqual(["hook /a", "dom /a"]);
    expect(hookEventName("navigateError")).toBe("f:navigate-error");
    expect(hookEventName("islandError")).toBe("f:island-error");
  });

  it("let navigate be cancelled, from the hook or the DOM event, and survive a throwing hook", () => {
    const detail = {
      url: new URL("https://app.test/b"),
      from: new URL("https://app.test/a"),
      kind: "link" as const,
    };
    setClientHooks({ navigate: (event) => event.preventDefault() });
    expect(emit("navigate", detail)).toBe(false);
    setClientHooks(undefined);
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener("f:navigate", stop);
    expect(emit("navigate", detail)).toBe(false);
    document.removeEventListener("f:navigate", stop);
    // Other events cannot be cancelled.
    setClientHooks({ navigated: (event) => event.preventDefault() });
    expect(emit("navigated", { url: detail.url, duration: 1 })).toBe(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setClientHooks({
      navigate: () => {
        throw new Error("broken hook");
      },
    });
    expect(emit("navigate", detail)).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("server hooks", () => {
  const call = (id: string) =>
    handleAction(
      new Request("https://app.test/x", {
        method: "POST",
        headers: { "F-Action": id, origin: "https://app.test", "content-type": "text/plain" },
        body: JSON.stringify({ a: [] }),
      }),
    );

  it("wrap every action, with its name and module", async () => {
    configureActionKeys({ key: generateActionKey() });
    registerServerReference(async () => "saved", "hooked-save", "save (src/actions.ts)");
    const seen: unknown[] = [];
    setServerHooks(
      defineServerHooks({
        async action({ name, module, request }, run) {
          seen.push([name, module, request.url]);
          return `wrapped ${await run()}`;
        },
      }),
    );
    expect(await (await call("hooked-save"))!.json()).toEqual({ result: "wrapped saved" });
    expect(seen).toEqual([["save", "src/actions.ts", "https://app.test/x"]]);
  });

  it("refuse through actionError, and report through error", async () => {
    class Unauthorized extends Error {}
    registerServerReference(async () => "secret", "guarded", "read (src/actions.ts)");
    registerServerReference(
      async () => {
        throw new Error("boom");
      },
      "exploding",
      "explode (src/actions.ts)",
    );
    const reported: unknown[] = [];
    setServerHooks({
      async action({ name }, run) {
        if (name === "read") throw new Unauthorized();
        return run();
      },
      actionError: (error) => (error instanceof Unauthorized ? { status: 401 } : undefined),
      error: (error, { name }) => reported.push([name, (error as Error).message]),
    });
    expect((await call("guarded"))!.status).toBe(401);
    expect((await call("exploding"))!.status).toBe(500);
    expect(reported).toEqual([["explode", "boom"]]);
  });
});
