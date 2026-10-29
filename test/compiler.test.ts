import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync } from "oxc-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionCompileError, getActionId, transformActions } from "@farmjs/islx/compiler";
import {
  configureActionKeys,
  generateActionKey,
  getActionReference,
  handleAction,
} from "@farmjs/islx/server";

const root = "/app";
const parse = (code: string) => parseSync("module.tsx", code).program as any;
const compile = (
  code: string,
  environment: "server" | "client" = "server",
  id = "/app/src/page.tsx",
) => transformActions({ code, id, root, environment, parse });

configureActionKeys({ key: generateActionKey() });

const tmp = path.join(import.meta.dirname, ".tmp");
let counter = 0;
/** Compiles plain JavaScript for the server and imports it. */
async function load(code: string): Promise<any> {
  const file = path.join(tmp, `module-${process.pid}-${counter++}.mjs`);
  const result = transformActions({ code, id: file, root: tmp, environment: "server", parse });
  await writeFile(file, result ? result.code : code);
  return import(/* @vite-ignore */ pathToFileURL(file).href);
}

function post(id: string, body: unknown) {
  return handleAction(
    new Request("https://app.test/page", {
      method: "POST",
      headers: { "F-Action": id, origin: "https://app.test", "content-type": "text/plain" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(() => mkdir(tmp, { recursive: true }));
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe('"use server" modules', () => {
  const source = `"use server";
import { db } from "./db";
export async function save(form) { await db.save(form); }
export const remove = async (id) => db.remove(id);
async function hidden() {}
export { hidden as rename };
export default async function () {}
`;

  it("become references in the browser, with none of their code", () => {
    const output = compile(source, "client")!.code;
    expect(output).not.toContain("db");
    expect(output).toContain(
      'import { createServerReference as $$islx_ref } from "@farmjs/islx/client";',
    );
    expect(output).toContain(
      `export const save = $$islx_ref(${JSON.stringify(getActionId(root, "/app/src/page.tsx", "save"))}, undefined, "save");`,
    );
    expect(output).toContain("export const rename = $$islx_ref(");
    expect(output).toContain("export default $$islx_ref(");
  });

  it("register every export on the server under the same ids", () => {
    const output = compile(source)!.code;
    expect(output).toContain(
      `$$islx_ref(save, ${JSON.stringify(getActionId(root, "/app/src/page.tsx", "save"))}, "save (src/page.tsx)");`,
    );
    expect(output).toContain("$$islx_ref(hidden, ");
    expect(output).toContain("const $$islx_default = async function () {}");
    expect(output).toContain("export { $$islx_default as default };");
  });

  it("refuse exports that cannot be actions", () => {
    const cases: Array<[string, string]> = [
      ['"use server"; export function save() {}', "make save async"],
      ['"use server"; export const config = { a: 1 };', "config is not a function"],
      ['"use server"; export * from "./x";', "export *"],
      ['"use server"; export { a } from "./x";', "re-export"],
      ['"use server"; export class Store {}', "is a class"],
      ['"use server"; export async function* stream() {}', "generator"],
    ];
    for (const [code, message] of cases) {
      expect(() => compile(code, "client")).toThrow(message);
      expect(() => compile(code)).toThrow(ActionCompileError);
    }
  });

  it("keep ids stable per path and different per salt", () => {
    expect(getActionId("/a", "/a/x.ts", "save")).toBe(getActionId("/b", "/b/x.ts", "save"));
    expect(getActionId("/a", "/a/x.ts", "save", "build-1")).not.toBe(
      getActionId("/a", "/a/x.ts", "save"),
    );
    expect(getActionId("/a", "/a/x.ts", "save")).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("inline actions", () => {
  it("capture only the variables of the functions around them", () => {
    const output = compile(`
import { db } from "./db";
const LIMIT = 10;
export default async function Page({ params }) {
  const user = await getUser(params.id);
  const { team } = user;
  async function rename(form) {
    "use server";
    const name = form.get("name");
    await db.rename(user.id, team, name, LIMIT, Math.max(1, 2));
  }
  return <form action={rename} />;
}`)!.code;
    expect(output).toContain("const rename = $$islx_bind(");
    expect(output).toContain('() => [user, team], ["user","team"])');
    expect(output).toMatch(/async function \$\$islx_action_0\(\[user, team\], form\) \{/);
    expect(output).toContain("$$islx_inline($$islx_action_0, ");
    expect(output).toContain(', 2, "rename (src/page.tsx)");');
    expect(output).not.toMatch(/async function rename/);
  });

  it("refuse mistakes with where they are", () => {
    const cases: Array<[string, string]> = [
      ['function A() { function f() { "use server"; } }', "must be an async function"],
      [
        'function A() { const f = async function () { "use server"; return this.x; }; }',
        "cannot use `this`",
      ],
      [
        'function A() { const f = async function () { "use server"; return arguments[0]; }; }',
        "cannot use `arguments`",
      ],
      ['function A() { async function f() { "use server"; return f(); } }', "refers to itself"],
    ];
    for (const [code, message] of cases) {
      expect(() => compile(code)).toThrow(message);
    }
    let error: unknown;
    try {
      compile(
        'function A() {\n  const f = async () => { "use server"; };\n}',
        "client",
        "/app/src/Button.tsx",
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ActionCompileError);
    expect((error as Error).message).toContain("can only be written in server code");
    expect((error as ActionCompileError).loc).toEqual({
      file: "/app/src/Button.tsx",
      line: 2,
      column: 12,
    });
  });

  it("allow `this` inside a function of their own", () => {
    expect(() =>
      compile(
        'function A() { const f = async () => { "use server"; return [1].map(function () { return this; }); }; }',
      ),
    ).not.toThrow();
  });

  it("run with their captured variables, on the server and through a request", async () => {
    const module = await load(`
export function Page(user, settings) {
  const save = async (value) => {
    "use server";
    return { user, theme: settings.theme, value };
  };
  return save;
}`);
    const user = { id: 7, joined: new Date("2026-01-01T00:00:00.000Z") };
    const save = module.Page(user, { theme: "dark" });
    // Called on the server, it is just the function.
    expect(await save(1)).toEqual({ user, theme: "dark", value: 1 });
    // Through the browser: the reference carries the captured values sealed.
    const reference = getActionReference(save)!;
    await reference.ready();
    const sealed = reference.sealed()!;
    expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain('"dark"');
    const response = await post(reference.id, { a: [2], b: sealed });
    expect(response!.status).toBe(200);
    const { result } = (await response!.json()) as any;
    expect(result.theme).toBe("dark");
    expect(result.user.joined).toEqual({ $: "D", v: "2026-01-01T00:00:00.000Z" });
    expect(result.value).toBe(2);
    // Without its sealed values it is refused.
    expect((await post(reference.id, { a: [2] }))!.status).toBe(400);
  });

  it("bind declarations at the top of their block, reading variables when first needed", async () => {
    const module = await load(`
export function Page() {
  const early = save;
  const label = "late";
  async function save() {
    "use server";
    return label;
  }
  return early;
}`);
    expect(await module.Page()()).toBe("late");
  });

  it("nest: an action that captures another carries it sealed", async () => {
    const module = await load(`
export function Page(secret) {
  const inner = async (x) => {
    "use server";
    return secret + ":" + x;
  };
  const outer = async () => {
    "use server";
    return inner("from outer");
  };
  return outer;
}`);
    const outer = module.Page("s3cret");
    const reference = getActionReference(outer)!;
    await reference.ready();
    expect(Buffer.from(reference.sealed()!, "base64url").toString("latin1")).not.toContain(
      "s3cret",
    );
    const response = await post(reference.id, { a: [], b: reference.sealed() });
    expect(await response!.json()).toEqual({ result: "s3cret:from outer" });
  });

  it("register module-level inline actions where they are", async () => {
    const module = await load(`
export async function ping() {
  "use server";
  return "pong";
}
export const pong = async () => {
  "use server";
  return "ping";
};`);
    expect(await module.ping()).toBe("pong");
    const reference = getActionReference(module.pong)!;
    expect(reference.sealed()).toBeUndefined();
    expect(await (await post(reference.id, { a: [] }))!.json()).toEqual({ result: "ping" });
  });

  it("explain a captured variable that cannot travel", async () => {
    const module = await load(`
class Pool {}
export function Page() {
  const db = new Pool();
  const save = async () => {
    "use server";
    return db;
  };
  return save;
}`);
    await expect(getActionReference(module.Page())!.ready()).rejects.toThrow(
      /`db` cannot be captured by the server action save \(module-\d+-\d+\.mjs\): class instances \(Pool\) are not serializable/,
    );
  });

  it("leave modules without actions alone", () => {
    expect(compile("export const a = 1;")).toBeNull();
    expect(compile('const s = "use server is just text";')).toBeNull();
  });
});
