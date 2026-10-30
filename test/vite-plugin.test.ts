import { describe, expect, it } from "vitest";
import { islx, resolveDirectives } from "@farm.js/islx/vite";

/** The plugin's transform, as Vite runs it in an environment. */
async function transformer(options: Parameters<typeof islx>[0] = {}) {
  const [main] = islx(options);
  await (main!.configResolved as any)({ root: "/app", base: "/", command: "serve", plugins: [] });
  return (environment: string, id: string, code: string) =>
    (main!.transform as any).call({ environment: { name: environment } }, code, id) as {
      code: string;
    } | null;
}

describe("directives", () => {
  it("default to the standard names, and refuse ones that mean two things", () => {
    expect(resolveDirectives()).toEqual({ client: "use client", server: "use server" });
    expect(resolveDirectives({ client: "use island" })).toEqual({
      client: "use island",
      server: "use server",
    });
    expect(() => resolveDirectives({ client: "use same", server: "use same" })).toThrow("both");
    expect(() => resolveDirectives({ client: "use strict" })).toThrow("plain directive");
    expect(() => resolveDirectives({ server: "" })).toThrow("plain directive");
    expect(() => resolveDirectives({ server: 'use "x"' })).toThrow("plain directive");
  });

  it("use your names in your code, and only those", async () => {
    const transform = await transformer({
      directives: { client: "use island", server: "use action" },
    });
    const island = transform(
      "ssr",
      "/app/src/chart.tsx",
      '"use island";\nexport function Chart() { return null; }',
    );
    expect(island!.code).toContain("$$islx_island(Chart");
    // The standard name means nothing in your code now: another tool may own it.
    expect(
      transform(
        "ssr",
        "/app/src/other.tsx",
        '"use client";\nexport function Other() { return null; }',
      ),
    ).toBeNull();
    const actions = transform(
      "ssr",
      "/app/src/actions.ts",
      '"use action";\nexport async function save() {}',
    );
    expect(actions!.code).toContain("$$islx_ref(save");
    expect(
      transform("ssr", "/app/src/x.ts", '"use server";\nexport async function save() {}'),
    ).toBeNull();
    const inline = transform(
      "ssr",
      "/app/src/page.tsx",
      'export function Page(u) { const f = async () => { "use action"; return u; }; return f; }',
    );
    expect(inline!.code).toContain("$$islx_bind(");
    expect(() =>
      transform(
        "client",
        "/app/src/button.tsx",
        'export function B() { const f = async () => { "use action"; }; }',
      ),
    ).toThrow('An inline "use action" function can only be written in server code');
  });

  it('turn libraries\' "use client" components into islands, and never register their actions', async () => {
    const transform = await transformer({ directives: { client: "use island" } });
    const library = transform(
      "ssr",
      "/app/node_modules/@acme/ui/dist/button.js",
      '"use client";\nexport function Button() { return null; }',
    );
    expect(library!.code).toContain(
      '$$islx_island(Button, "node_modules/@acme/ui/dist/button.js", "Button", "load")',
    );
    expect(
      transform(
        "ssr",
        "/app/node_modules/@acme/ui/dist/actions.js",
        '"use server";\nexport async function drop() {}',
      ),
    ).toBeNull();
    expect(
      transform(
        "client",
        "/app/node_modules/@acme/ui/dist/actions.js",
        '"use server";\nexport async function drop() {}',
      ),
    ).toBeNull();
    // A hoisted library outside the root keeps a stable name.
    const hoisted = transform(
      "ssr",
      "/node_modules/@acme/ui/dist/card.js",
      '"use client";\nexport function Card() { return null; }',
    );
    expect(hoisted!.code).toContain('"../node_modules/@acme/ui/dist/card.js"');
  });
});
