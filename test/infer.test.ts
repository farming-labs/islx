import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { afterAll, describe, expect, it } from "vitest";
import { inferStrategy } from "@farm.js/islx/compiler";
import {
  BOOT_HYDRATED_ATTRIBUTE,
  BOOT_INTERACTION_EVENT,
  BOOT_ISLAND_ELEMENT,
  BOOT_VISIBLE_MARGIN,
} from "../src/boot";
import { INTERACTION_EVENT } from "../src/client/prehydration";
import { transformClientModule } from "../src/compiler/client";
import { HYDRATED_ATTRIBUTE, ISLAND_ELEMENT } from "../src/protocol/wire";

const parse = (file: string, code: string) => parseSync(file, code).program as any;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "islx-infer-"));
let count = 0;

/** Writes `files` into a fresh app; returns the first one's path and source. */
function app(files: Record<string, string>) {
  const root = path.join(dir, `app-${count++}`);
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  }
  const [first, code] = Object.entries(files)[0]!;
  return { file: path.join(root, first), code, root };
}

function infer(files: Record<string, string>) {
  const { file, code } = app(files);
  return inferStrategy(file, code, { parse });
}

const client = (body: string) => `"use client";\nimport { useState } from "react";\n${body}`;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("inferStrategy", () => {
  it("lets an island that only changes state on a click wait for one", () => {
    expect(
      infer({
        "like.tsx": client(
          `export function Like() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }`,
        ),
      }).strategy,
    ).toBe("interaction");
  });

  it("allows browser APIs in handlers, same-page links it handles, context and memo", () => {
    expect(
      infer({
        "toc.tsx": client(`import { createContext, memo, useContext } from "react";
const Theme = createContext("light");
export const Toc = memo(function Toc({ ids }: { ids: string[] }) {
  const theme = useContext(Theme);
  const [active, setActive] = useState(ids[0]);
  return <Theme.Provider value={theme}><ol>{ids.map((id) => (
    <li key={id} data-active={id === active ? "" : undefined}>
      <a href={\`#\${id}\`} onClick={() => { setActive(id); document.createElement("p"); }}>{id}</a>
    </li>))}</ol></Theme.Provider>;
});`),
      }).strategy,
    ).toBe("interaction");
  });

  it("follows relative imports, and keeps load for what they do", () => {
    const passing = infer({
      "menu.tsx": client(
        `import { Item } from "./item";\nexport function Menu() { return <ul><Item /></ul>; }`,
      ),
      "item.tsx": `export function Item() { return <li><a href="/docs">Docs</a></li>; }`,
    });
    expect(passing).toMatchObject({ strategy: "interaction" });
    expect(passing.files).toHaveLength(2);
    expect(
      infer({
        "menu.tsx": client(
          `import { useWidth } from "./width";\nexport function Menu() { return <p>{useWidth()}</p>; }`,
        ),
        "width.ts": `import { useEffect, useState } from "react";\nexport function useWidth() { const [w, setW] = useState(0); useEffect(() => setW(1), []); return w; }`,
      }),
    ).toMatchObject({ strategy: null, reason: "width.ts: calls useEffect" });
  });

  it.each([
    [`export function A() { useEffect(() => {}, []); return null; }`, "calls useEffect"],
    [
      `import * as React from "react";\nexport function A() { React.useLayoutEffect(() => {}); return null; }`,
      "calls useLayoutEffect",
    ],
    [
      `export function A() { return <div ref={(node) => node?.focus()} />; }`,
      "sets a ref on <div>",
    ],
    [`export function A() { return <button autoFocus>Go</button>; }`, "sets autoFocus"],
    [`export function A() { return <div onMouseEnter={() => {}} />; }`, "handles onMouseEnter"],
    [`export function A() { return <input name="q" />; }`, "renders <input>"],
    [
      `export function A(props: object) { return <button {...props} />; }`,
      "spreads props onto <button>",
    ],
    [
      `export function A() { return <a href="/next" onClick={() => {}}>Next</a>; }`,
      "handles a click on a link",
    ],
    [`export class A { render() { return null; } }`, "declares a class"],
    [
      `window.addEventListener("resize", () => {});\nexport function A() { return null; }`,
      "runs code as it loads",
    ],
    [
      `import { motion } from "motion/react";\nexport function A() { return <motion.div />; }`,
      "imports motion/react",
    ],
    [`export function A() { void import("./b"); return null; }`, "imports a module at runtime"],
  ])("keeps load for %s", (body, reason) => {
    const result = infer({ "a.tsx": client(body) });
    expect(result.strategy).toBeNull();
    expect(result.reason).toContain(reason);
  });
});

describe("inferred islands in the compiler", () => {
  const compile = (code: string, infer = true) =>
    transformClientModule({
      code,
      id: "/app/src/like.tsx",
      root: "/app",
      parse: (source) => parse("like.tsx", source),
      reference: (relative) => JSON.stringify(relative),
      ...(infer ? { infer: { parse } } : {}),
    })!;
  const like = client(
    `export function Like() { const [n, setN] = useState(0); return <button onClick={() => setN(n + 1)}>{n}</button>; }`,
  );

  it("gives a module without a hydrate export the inferred strategy, marked as inferred", () => {
    const result = compile(like);
    expect(result.islands).toEqual([{ exportName: "Like", strategy: "interaction" }]);
    expect(result.code).toContain(`"interaction", { inferred: true })`);
  });

  it("keeps a declared strategy, and infers nothing when asked not to", () => {
    expect(compile(`${like}\nexport const hydrate = "load";`).islands).toEqual([
      { exportName: "Like", strategy: "load" },
    ]);
    expect(compile(like, false).islands).toEqual([{ exportName: "Like", strategy: "load" }]);
  });
});

describe("the boot script", () => {
  it("reads the islands, attribute, event and margin the runtime writes", () => {
    expect(BOOT_ISLAND_ELEMENT).toBe(ISLAND_ELEMENT);
    expect(BOOT_HYDRATED_ATTRIBUTE).toBe(HYDRATED_ATTRIBUTE);
    expect(BOOT_INTERACTION_EVENT).toBe(INTERACTION_EVENT);
    const schedule = fs.readFileSync(path.join(__dirname, "../src/client/schedule.ts"), "utf8");
    expect(schedule).toContain(`rootMargin: "${BOOT_VISIBLE_MARGIN}"`);
  });
});
