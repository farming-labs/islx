import { createElement as h, useActionState } from "react";
import { renderToReadableStream } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  bindInlineAction,
  configureActionKeys,
  generateActionKey,
  getActionReference,
  handleAction,
  registerInlineAction,
  registerServerReference,
  type HandleActionOptions,
} from "@farm.js/islx/server";

const ORIGIN = "https://app.test";

beforeAll(() => configureActionKeys({ key: generateActionKey() }));

async function render(element: unknown, formState?: unknown): Promise<string> {
  const stream = await renderToReadableStream(element as any, { formState: formState as any });
  await stream.allReady;
  return new Response(stream).text();
}

/** The fields a browser would post from the HTML's first form, clicking `button` if named. */
function submit(html: string, fields: Record<string, string> = {}, button?: string): FormData {
  const form = /<form[\s\S]*?<\/form>/.exec(html)![0];
  const data = new FormData();
  for (const match of form.matchAll(
    /<input type="hidden" name="([^"]*)"(?: value="([^"]*)")?\/>/g,
  )) {
    data.append(match[1]!.replace(/&amp;/g, "&"), (match[2] ?? "").replace(/&amp;/g, "&"));
  }
  if (button) data.append(button, "");
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function postForm(data: FormData, headers: Record<string, string> = { origin: ORIGIN }) {
  return new Request(`${ORIGIN}/todos?tab=1`, { method: "POST", headers, body: data });
}

function call(id: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/todos`, {
    method: "POST",
    headers: {
      "F-Action": id,
      origin: ORIGIN,
      "content-type": "text/plain;charset=UTF-8",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("forms without JavaScript", () => {
  it("post an exported action, and redirect back to the page", async () => {
    const save = vi.fn(async (_form: FormData) => {});
    registerServerReference(save, "save-form", "save (test)");
    const html = await render(h("form", { action: save }, h("input", { name: "title" })));
    expect(html).toMatch(/<input type="hidden" name="\$F_REF_[^"]+"\/>/);
    expect(html).toContain('value="save-form"');
    const response = await handleAction(postForm(submit(html, { title: "Buy milk" })));
    expect(response!.status).toBe(303);
    expect(response!.headers.get("location")).toBe("/todos?tab=1");
    const form = save.mock.calls[0]![0];
    // The action sees only the form's own fields.
    expect([...form.keys()]).toEqual(["title"]);
    expect(form.get("title")).toBe("Buy milk");
  });

  it("carry an inline action's captured values, sealed, and refuse them changed", async () => {
    const hoisted = vi.fn(
      async ([user]: [{ id: number }], form: FormData) => `${user.id}:${form.get("name")}`,
    );
    registerInlineAction(hoisted, "rename-inline", 1, "rename (test)");
    const user = { id: 42, email: "kinfe@example.com" };
    const rename = bindInlineAction("rename-inline", () => [user], ["user"]);
    // The values seal while React renders: the form suspends, then renders with them.
    const html = await render(h("form", { action: rename }, h("input", { name: "name" })));
    expect(html).not.toContain("kinfe@example.com");
    const data = submit(html, { name: "Kinfe" });
    expect((await handleAction(postForm(data)))!.status).toBe(303);
    expect(hoisted).toHaveBeenCalledWith([user], expect.any(FormData));

    const changed = submit(html, { name: "Mallory" });
    for (const key of changed.keys()) {
      if (key.endsWith(":B")) {
        const value = changed.get(key) as string;
        changed.set(key, value.slice(0, 20) + (value[20] === "A" ? "B" : "A") + value.slice(21));
      }
    }
    expect((await handleAction(postForm(changed)))!.status).toBe(400);
    expect(hoisted).toHaveBeenCalledTimes(1);
  });

  it("run the clicked button's action, not the form's", async () => {
    const formAction = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    registerServerReference(formAction, "form-level");
    registerServerReference(remove, "button-remove");
    const html = await render(
      h(
        "form",
        { action: formAction },
        h("button", { formAction: remove }, "Delete"),
        h("button", null, "Save"),
      ),
    );
    const buttonName = /<button name="([^"]+)"/.exec(html)![1]!;
    await handleAction(postForm(submit(html, {}, buttonName)));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(formAction).not.toHaveBeenCalled();
    // The plain button submits the form's own action.
    await handleAction(postForm(submit(html)));
    expect(formAction).toHaveBeenCalledTimes(1);
  });

  it("pass arguments added with .bind first, sealed", async () => {
    const remove = vi.fn(async (_id: number, _form: FormData) => {});
    registerServerReference(remove, "remove-bound");
    const html = await render(
      h("form", { action: remove.bind(null, 7) as unknown as (form: FormData) => Promise<void> }),
    );
    expect(html).toContain(":B");
    await handleAction(postForm(submit(html)));
    expect(remove).toHaveBeenCalledWith(7, expect.any(FormData));
  });

  it("show useActionState's result after the post, when the app renders form state", async () => {
    const increment = async (previous: { count: number }, form: FormData) => ({
      count: previous.count + Number(form.get("by")),
    });
    registerServerReference(increment, "increment");
    function Counter() {
      const [state, action] = useActionState(increment, { count: 1 });
      return h(
        "form",
        { action },
        h("output", null, `count ${state.count}`),
        h("input", { name: "by" }),
      );
    }
    const html = await render(h(Counter));
    expect(html).toContain("count 1");
    expect(html).toContain('name="$ACTION_KEY"');

    let rendered = "";
    const options: HandleActionOptions = {
      renderFormState: async (formState) => {
        rendered = await render(h(Counter), formState);
        return new Response(rendered, { headers: { "content-type": "text/html" } });
      },
    };
    const response = await handleAction(postForm(submit(html, { by: "5" })), options);
    expect(response!.status).toBe(200);
    expect(rendered).toContain("count 6");
    // React marks the hook that matched, for hydrateRoot's `formState`.
    expect(rendered).toContain("<!--F!-->");
    // Without renderFormState the form redirects back.
    expect((await handleAction(postForm(submit(html, { by: "5" }))))!.status).toBe(303);
  });

  it("redirect back when the action is unknown, as after a deploy", async () => {
    const data = new FormData();
    data.append("$F_REF_R_9_", "");
    data.append("$F_R_9_:A", "not-registered");
    const response = await handleAction(postForm(data));
    expect(response!.status).toBe(303);
    expect(response!.headers.get("location")).toBe("/todos?tab=1");
  });

  it("refuse cross-site posts, and ignore forms that are not actions", async () => {
    const save = vi.fn(async () => {});
    registerServerReference(save, "csrf-target");
    const html = await render(h("form", { action: save }));
    expect(
      (await handleAction(postForm(submit(html), { origin: "https://evil.test" })))!.status,
    ).toBe(403);
    expect((await handleAction(postForm(submit(html), {})))!.status).toBe(403);
    expect(
      (await handleAction(postForm(submit(html), { "sec-fetch-site": "same-origin" })))!.status,
    ).toBe(303);
    expect(save).toHaveBeenCalledTimes(1);

    const plain = new FormData();
    plain.append("q", "search");
    const request = postForm(plain);
    expect(await handleAction(request)).toBeNull();
    // The app still reads the body.
    expect((await request.formData()).get("q")).toBe("search");
  });

  it("answer 413 for an action form over the limit, and leave other large posts to the app", async () => {
    const save = vi.fn(async () => {});
    registerServerReference(save, "big");
    const html = await render(h("form", { action: save }));
    expect(
      (await handleAction(postForm(submit(html, { note: "x".repeat(5000) })), {
        bodySizeLimit: 1000,
      }))!.status,
    ).toBe(413);
    const upload = new FormData();
    upload.append("file", "x".repeat(5000));
    expect(await handleAction(postForm(upload), { bodySizeLimit: 1000 })).toBeNull();
  });

  it("redirect where the action's error says", async () => {
    class Redirect extends Error {
      constructor(readonly to: string) {
        super("redirect");
      }
    }
    const save = async () => {
      throw new Redirect("/done");
    };
    registerServerReference(save, "redirecting");
    const html = await render(h("form", { action: save }));
    const options = {
      mapError: (error: unknown) =>
        error instanceof Redirect ? { redirect: error.to } : undefined,
    };
    const response = await handleAction(postForm(submit(html)), options);
    expect(response!.status).toBe(303);
    expect(response!.headers.get("location")).toBe("/done");
    const called = await handleAction(call("redirecting", { a: [] }), options);
    expect(await called!.json()).toEqual({ redirect: "/done" });
  });
});

describe("calls from JavaScript", () => {
  it("keep argument and result types", async () => {
    registerServerReference(
      async (at: Date, ids: Set<bigint>) => ({ at, ids, next: new Map([["n", 1n]]) }),
      "typed",
    );
    const response = await handleAction(
      call("typed", {
        a: [
          { $: "D", v: "2026-01-01T00:00:00.000Z" },
          { $: "S", v: [{ $: "B", v: "1" }] },
        ],
      }),
    );
    expect(await response!.json()).toEqual({
      result: {
        at: { $: "D", v: "2026-01-01T00:00:00.000Z" },
        ids: { $: "S", v: [{ $: "B", v: "1" }] },
        next: { $: "M", v: [["n", { $: "B", v: "1" }]] },
      },
    });
    expect(response!.headers.get("cache-control")).toBe("no-store");
  });

  it("tell the browser to reload for an unknown action", async () => {
    const response = await handleAction(call("missing-action", { a: [] }));
    expect(response!.status).toBe(404);
    expect(response!.headers.get("F-Action-Stale")).toBe("1");
  });

  it("report values sealed with another key as stale", async () => {
    const hoisted = async ([value]: [string]) => value;
    registerInlineAction(hoisted, "rotating", 1);
    const reference = bindInlineAction("rotating", () => ["kept"], ["value"]);
    await getActionReference(reference)!.ready();
    const sealed = getActionReference(reference)!.sealed();
    const oldKey = generateActionKey();
    configureActionKeys({ key: oldKey });
    const fresh = bindInlineAction("rotating", () => ["kept"], ["value"]);
    await getActionReference(fresh)!.ready();
    const sealedOld = getActionReference(fresh)!.sealed();
    configureActionKeys({ key: generateActionKey() });
    const stale = await handleAction(call("rotating", { a: [], b: sealedOld }));
    expect(stale!.status).toBe(409);
    expect(stale!.headers.get("F-Action-Stale")).toBe("1");
    // Keeping the old key as a previous key opens it.
    configureActionKeys({ key: generateActionKey(), previousKeys: [oldKey] });
    expect(await (await handleAction(call("rotating", { a: [], b: sealedOld })))!.json()).toEqual({
      result: "kept",
    });
    void sealed;
  });

  it("refuse malformed requests", async () => {
    registerServerReference(async () => "ok", "strict");
    const cases: Array<[Request, number]> = [
      [call("strict", "{not json"), 400],
      [call("strict", { a: "not an array" }), 400],
      [call("strict", { a: [{ $: "zz" }] }), 400],
      [call("strict", { a: [{ $: "r", v: "04jiw29097x8ki" }] }), 400],
      [call("strict", { a: [{ $: "a", v: "not-registered" }] }), 400],
      [call("strict", { a: [], b: 5 }), 400],
      [call("strict", { a: [], b: "not+base64" }), 400],
      [call("bad id!", { a: [] }), 400],
      [call("strict", { a: [] }, { origin: "https://evil.test" }), 403],
      [call("strict", { a: ["x".repeat(2000)] }, {}), 200],
    ];
    for (const [request, status] of cases) {
      expect((await handleAction(request))!.status).toBe(status);
    }
    expect(
      (await handleAction(call("strict", { a: ["x".repeat(2000)] }), { bodySizeLimit: 100 }))!
        .status,
    ).toBe(413);
  });

  it("accept an action passed back as an argument", async () => {
    const target = async () => "inner";
    registerServerReference(target, "callback-target");
    registerServerReference(
      async (callback: () => Promise<string>) => callback(),
      "takes-callback",
    );
    const response = await handleAction(
      call("takes-callback", { a: [{ $: "a", v: "callback-target" }] }),
    );
    expect(await response!.json()).toEqual({ result: "inner" });
  });

  it("send a FormData argument with its sealed values in a field", async () => {
    const hoisted = vi.fn(
      async ([team]: [string], form: FormData) => `${team}:${form.get("name")}`,
    );
    registerInlineAction(hoisted, "invite", 1);
    const reference = getActionReference(bindInlineAction("invite", () => ["core"], ["team"]))!;
    await reference.ready();
    const data = new FormData();
    data.append("name", "Ada");
    data.append("$F_BOUND", reference.sealed()!);
    const response = await handleAction(
      new Request(`${ORIGIN}/team`, {
        method: "POST",
        headers: { "F-Action": "invite", origin: ORIGIN },
        body: data,
      }),
    );
    expect(await response!.json()).toEqual({ result: "core:Ada" });
    expect([...hoisted.mock.calls[0]![1].keys()]).toEqual(["name"]);
  });

  it("answer 500 without details when an action fails", async () => {
    const onError = vi.fn();
    registerServerReference(async () => {
      throw new Error("database password is hunter2");
    }, "failing");
    const response = await handleAction(call("failing", { a: [] }), { onError });
    expect(response!.status).toBe(500);
    expect(await response!.text()).not.toContain("hunter2");
    expect(onError).toHaveBeenCalled();
  });

  it("ignore requests that are not posts", async () => {
    expect(await handleAction(new Request(`${ORIGIN}/todos`))).toBeNull();
  });
});

describe("calls with form data and files", () => {
  it("rebuild FormData and File arguments from multipart fields", async () => {
    const received: unknown[] = [];
    registerServerReference(async (...args: unknown[]) => {
      received.push(...args);
      return "ok";
    }, "with-attachments");
    const data = new FormData();
    data.append(
      "$F_CALL",
      JSON.stringify({ a: [{ votes: 1 }, { $: "F", v: 0 }, { $: "K", v: 1 }] }),
    );
    data.append("$F_0_by", "2");
    data.append("$F_0_tag", "a");
    data.append("$F_0_tag", "b");
    data.append("$F_1", new File(["hello"], "note.txt", { type: "text/plain" }));
    const response = await handleAction(
      new Request(`${ORIGIN}/votes`, {
        method: "POST",
        headers: { "F-Action": "with-attachments", origin: ORIGIN },
        body: data,
      }),
    );
    expect(await response!.json()).toEqual({ result: "ok" });
    expect(received[0]).toEqual({ votes: 1 });
    const form = received[1] as FormData;
    expect(form.get("by")).toBe("2");
    expect(form.getAll("tag")).toEqual(["a", "b"]);
    const file = received[2] as File;
    expect(file.name).toBe("note.txt");
    expect(await file.text()).toBe("hello");
  });

  it("refuse an attachment that is not there", async () => {
    registerServerReference(async () => "ok", "missing-attachment");
    const data = new FormData();
    data.append("$F_CALL", JSON.stringify({ a: [{ $: "K", v: 3 }] }));
    const response = await handleAction(
      new Request(`${ORIGIN}/x`, {
        method: "POST",
        headers: { "F-Action": "missing-attachment", origin: ORIGIN },
        body: data,
      }),
    );
    expect(response!.status).toBe(400);
  });
});
