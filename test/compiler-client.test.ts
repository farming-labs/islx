import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { ActionCompileError } from "@farmjs/islx/compiler";
import { transformClientModule } from "../src/compiler/client";

const compile = (code: string) =>
  transformClientModule({
    code,
    id: "/app/src/widgets.tsx",
    root: "/app",
    parse: (source) => parseSync("widgets.tsx", source).program as any,
    reference: (relative) => JSON.stringify(relative),
  });

describe('"use client" modules on the server', () => {
  it("wrap components as islands and leave other exports alone", () => {
    const result = compile(`"use client";
import { useState } from "react";
export function Chart() { return null; }
export const Legend = () => null;
export function useChart() { return useState(0); }
export const COLORS = ["red"];
function Hidden() { return null; }
export { Hidden as Tooltip };
export default function () { return null; }
`)!;
    expect(result.islands).toEqual([
      { exportName: "Chart", strategy: "load" },
      { exportName: "Legend", strategy: "load" },
      { exportName: "Tooltip", strategy: "load" },
      { exportName: "default", strategy: "load" },
    ]);
    expect(result.code).toContain(
      'import { createIsland as $$islx_island } from "@farmjs/islx/react";',
    );
    expect(result.code).toContain('$$islx_island(Chart, "src/widgets.tsx", "Chart", "load")');
    expect(result.code).toContain('$$islx_island(Hidden, "src/widgets.tsx", "Tooltip", "load")');
    expect(result.code).toContain("export function useChart()");
    expect(result.code).toContain("export const COLORS");
    expect(result.code).not.toMatch(/export function Chart/);
    expect(result.code).toContain("const $$islx_default = function ()");
  });

  it("read when each component hydrates", () => {
    expect(
      compile(
        '"use client"; export const hydrate = "visible"; export function Alpha() {} export function Beta() {}',
      )!.islands,
    ).toEqual([
      { exportName: "Alpha", strategy: "visible" },
      { exportName: "Beta", strategy: "visible" },
    ]);
    expect(
      compile(
        '"use client"; export const hydrate = { Alpha: "idle" } as const; export function Alpha() {} export function Beta() {}',
      )!.islands,
    ).toEqual([
      { exportName: "Alpha", strategy: "idle" },
      { exportName: "Beta", strategy: "load" },
    ]);
  });

  it("refuse a hydrate the compiler cannot read, or an unknown strategy", () => {
    expect(() =>
      compile('"use client"; export const hydrate = "soon"; export function Alpha() {}'),
    ).toThrow('hydrate must be one of "load", "idle", "visible", "interaction"');
    expect(() =>
      compile('"use client"; export const hydrate = pick(); export function Alpha() {}'),
    ).toThrow("written as a literal");
    expect(() =>
      compile('"use client"; export const hydrate = { Alpha: mode }; export function Alpha() {}'),
    ).toThrow(ActionCompileError);
    expect(() => compile('"use client"; export const Chart = () => null, helper = 1;')).toThrow(
      "separate statements",
    );
  });

  it("leave other modules alone", () => {
    expect(compile("export function Alpha() {}")).toBeNull();
    expect(compile('"use client"; export const x = 1;')).toBeNull();
  });
});
