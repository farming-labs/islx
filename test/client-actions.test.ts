// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServerReference,
  decodeActionReference,
  setActionNavigator,
} from "@farm.js/islx/client";

type Sent = { headers: Record<string, string>; body: BodyInit };

function mockFetch(respond: (sent: Sent, index: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const entry = { headers: init.headers as Record<string, string>, body: init.body! };
      sent.push(entry);
      return respond(entry, sent.length - 1);
    }),
  );
  return sent;
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  setActionNavigator({});
});

describe("client references", () => {
  it("send typed arguments with the sealed values, and decode the result", async () => {
    const sent = mockFetch(() =>
      json({ result: { at: { $: "D", v: "2026-01-01T00:00:00.000Z" } } }),
    );
    const save = createServerReference("save-id", "sealed-token");
    const result = (await save(new Date("2026-02-02T00:00:00.000Z"), 5n)) as { at: Date };
    expect(result.at).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(sent[0]!.headers["F-Action"]).toBe("save-id");
    expect(JSON.parse(sent[0]!.body as string)).toEqual({
      a: [
        { $: "D", v: "2026-02-02T00:00:00.000Z" },
        { $: "B", v: "5" },
      ],
      b: "sealed-token",
    });
  });

  it("send a form's fields as a form, with the sealed values in one field", async () => {
    const sent = mockFetch(() => json({ result: null }));
    const form = new FormData();
    form.append("title", "Buy milk");
    await createServerReference("form-id", "tok")(form);
    const body = sent[0]!.body as FormData;
    expect(body.get("title")).toBe("Buy milk");
    expect(body.get("$F_BOUND")).toBe("tok");
    // The caller's form is left as it was.
    expect(form.has("$F_BOUND")).toBe(false);
  });

  it("run calls one at a time, in order, even when one fails", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockFetch(async (sent, index) => {
      const [name] = JSON.parse(sent.body as string).a;
      order.push(`start ${name}`);
      if (index === 0) await gate;
      order.push(`end ${name}`);
      return index === 1 ? new Response("no", { status: 500 }) : json({ result: name });
    });
    const action = createServerReference("queued");
    const first = action("a");
    const second = action("b");
    const third = action("c");
    await Promise.resolve();
    expect(order).toEqual(["start a"]);
    release();
    expect(await first).toBe("a");
    await expect(second).rejects.toThrow("500");
    expect(await third).toBe("c");
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  it("refresh the page after an action, and navigate on a redirect", async () => {
    const refresh = vi.fn();
    const navigate = vi.fn();
    setActionNavigator({ refresh, navigate });
    mockFetch((_sent, index) => (index === 0 ? json({ result: 1 }) : json({ redirect: "/done" })));
    const action = createServerReference("nav");
    expect(await action()).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await action()).toBeUndefined();
    expect(navigate).toHaveBeenCalledWith("/done");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reload the page for an action this deploy does not know", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, href: "https://app.test/", reload });
    mockFetch(() => new Response("Stale", { status: 404, headers: { "F-Action-Stale": "1" } }));
    const pending = createServerReference("old")();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });

  it("prepend arguments bound in the browser", async () => {
    const sent = mockFetch(() => json({ result: null }));
    await createServerReference("bound").bind(null, 1, 2)(3);
    expect(JSON.parse(sent[0]!.body as string).a).toEqual([1, 2, 3]);
  });

  it("keep one function per action, so props keep their identity", () => {
    expect(createServerReference("same")).toBe(createServerReference("same"));
    expect(createServerReference("same", "t")).not.toBe(createServerReference("same"));
    expect(decodeActionReference({ $: "a", v: "same" })).toBe(createServerReference("same"));
    expect(decodeActionReference({ $: "s", v: "x" })).toBeUndefined();
  });

  it("send an action back as an argument", async () => {
    const sent = mockFetch(() => json({ result: null }));
    await createServerReference("outer")(createServerReference("inner", "tok"));
    expect(JSON.parse(sent[0]!.body as string).a).toEqual([{ $: "a", v: "inner", b: "tok" }]);
  });
});

describe("arguments with form data and files", () => {
  it("send them as multipart fields named in the JSON", async () => {
    const sent = mockFetch(() => json({ result: null }));
    const form = new FormData();
    form.append("by", "2");
    const file = new Blob(["hello"], { type: "text/plain" });
    await createServerReference("vote", "tok")({ votes: 1 }, form, file);
    const body = sent[0]!.body as FormData;
    expect(JSON.parse(body.get("$F_CALL") as string)).toEqual({
      a: [{ votes: 1 }, { $: "F", v: 0 }, { $: "K", v: 1 }],
      b: "tok",
    });
    expect(body.get("$F_0_by")).toBe("2");
    expect(body.get("$F_1")).toBeInstanceOf(Blob);
  });
});

describe("server-component forms", () => {
  it("submit as a call once JavaScript runs, without the runtime's fields", async () => {
    const { enhanceForms } = await import("@farm.js/islx/client");
    const sent = mockFetch(() => json({ result: null }));
    enhanceForms();
    document.body.innerHTML = `<form action="" method="POST">
      <input type="hidden" name="$F_REF_R_1_"><input type="hidden" name="$F_R_1_:A" value="add">
      <input type="hidden" name="$F_R_1_:B" value="tok"><input name="title" value="milk"><button>Add</button></form>`;
    const form = document.querySelector("form")!;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.headers["F-Action"]).toBe("add");
    const body = sent[0]!.body as FormData;
    expect([...body.keys()]).toEqual(["title", "$F_BOUND"]);
    expect(body.get("$F_BOUND")).toBe("tok");
  });

  it("leave forms that post no action to the browser", async () => {
    const { enhanceForms } = await import("@farm.js/islx/client");
    enhanceForms();
    document.body.innerHTML = `<form action="/search"><input name="q"></form>`;
    const event = new Event("submit", { bubbles: true, cancelable: true });
    document.querySelector("form")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
