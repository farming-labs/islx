// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerReference } from "@farm.js/islx/client";
import {
  bindInlineAction,
  configureActionKeys,
  generateActionKey,
  handleAction,
  registerInlineAction,
  registerServerReference,
} from "@farm.js/islx/server";

type Fn = (...args: unknown[]) => Promise<unknown>;

const errors: unknown[] = [];

function serve() {
  // The action client runs in a browser, where the page has a location.
  vi.stubGlobal("location", new URL("http://localhost/page"));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) =>
    handleAction(
      new Request(url, {
        ...init,
        headers: { ...(init.headers as object), origin: new URL(url).origin },
      }),
      { onError: (error) => errors.push(error) },
    ),
  );
}

beforeAll(() => {
  configureActionKeys({ key: generateActionKey() });
  registerServerReference(async (...args: unknown[]) => args.join(" "), "bound-join");
  registerServerReference(async (fn: Fn, ...args: unknown[]) => fn(...args), "bound-run");
  registerServerReference(async (fn: Fn) => fn.bind(null, "server"), "bound-rebind");
  // An inline action that captured `prefix`: the browser only holds it sealed.
  registerInlineAction(
    async ([prefix]: unknown[], ...args: unknown[]) => [prefix, ...args].join(" "),
    "bound-inline",
    1,
  );
  registerServerReference(
    async () => bindInlineAction("bound-inline", () => ["captured"], ["prefix"]),
    "bound-make-inline",
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  errors.length = 0;
});

describe("an action bound in the browser", () => {
  it("can be sent to another action, which runs it with the bound arguments first, as React Server Components do", async () => {
    serve();
    const join = createServerReference("bound-join").bind(null, "a", { b: new Date(0) });
    const run = createServerReference("bound-run");
    expect(await run(join, "c")).toBe("a [object Object] c");
  });

  it("keeps the captured values of an inline action, with the browser's arguments after them", async () => {
    serve();
    const inline = (await createServerReference("bound-make-inline")()) as Fn;
    const run = createServerReference("bound-run");
    expect(await run(inline.bind(null, "browser"), "call")).toBe("captured browser call");
  });

  it("can be bound again on the server and sent back", async () => {
    serve();
    const inline = (await createServerReference("bound-make-inline")()) as Fn;
    const rebind = createServerReference("bound-rebind");
    const join = createServerReference("bound-join");
    const rebound = (await rebind(inline.bind(null, "browser"))) as Fn;
    expect(await rebound("call")).toBe("captured browser server call");
    const plain = (await rebind(join.bind(null, "browser"))) as Fn;
    expect(await plain("call")).toBe("browser server call");
  });

  it("cannot stand in for an inline action's captured values", async () => {
    serve();
    // A forged reference: the inline action's id without its sealed values, the browser's
    // arguments where its captured variables go.
    const body = JSON.stringify({ a: [{ $: "a", v: "bound-inline", c: ["forged"] }, "call"] });
    const response = await fetch("http://localhost/page", {
      method: "POST",
      headers: { "F-Action": "bound-run", "content-type": "text/plain;charset=UTF-8" },
      body,
    });
    expect(response.status).toBe(500);
    expect(String(errors[0])).toContain("was sent without its captured values");
  });

  it("refuses arguments that hold the action itself", async () => {
    serve();
    const holder: Record<string, unknown> = {};
    const join = createServerReference("bound-join").bind(null, holder);
    holder.join = join;
    await expect(createServerReference("bound-run")(join)).rejects.toThrow(
      "an action bound in the browser to a value that holds it cannot be sent",
    );
  });
});
