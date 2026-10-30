/**
 * The `"use client"` compiler. In the server build, every component a `"use client"` module
 * exports renders as an island: its server HTML, and its props for the browser. The browser build
 * keeps the module as it is.
 *
 * A component is an export named in PascalCase (`Chart`, not `COLORS` or `useChart`) that is not
 * a literal value, or the default export. Other exports (hooks, constants, helpers) stay as they
 * are on both sides.
 *
 * When an island hydrates comes from the module's `hydrate` export:
 *
 *   export const hydrate = "visible";                        // every component in the file
 *   export const hydrate = { Chart: "visible", Legend: "idle" };  // per component; others "load"
 */
import path from "node:path";
import MagicString from "magic-string";
import { ISLAND_STRATEGIES, type IslandStrategy } from "../client/schedule";
import { ActionCompileError, hasModuleDirective, type AstNode } from "./actions";

export interface TransformClientOptions {
  code: string;
  id: string;
  root: string;
  /** Parses JavaScript (or the language the plugin runs after) to an ESTree program. */
  parse(code: string): AstNode;
  /**
   * The JavaScript expression for the URL the browser imports this module from, given its path
   * from the root: in development the module's own URL, in a build a placeholder the plugin
   * replaces once the browser build has named its chunk.
   */
  reference(relativePath: string): string;
  /** Where `createIsland` is imported from. */
  runtime?: string;
  /** Modules the island wrapper imports for their side effects (the plugin's runtime setup). */
  sideEffects?: readonly string[];
  /** The directive that marks a module of client components. Default `"use client"`. */
  directive?: string;
  /**
   * When an export hydrates, from the framework's own configuration (a route's setting): wins over
   * the module's `hydrate` export. Return undefined to use that.
   */
  strategy?(exportName: string): IslandStrategy | undefined;
}

export interface TransformClientResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
  /** Exported components and when each hydrates. */
  islands: Array<{ exportName: string; strategy: IslandStrategy }>;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name) && /[a-z]/.test(name);
}

const VALUE_TYPES = new Set([
  "Literal",
  "ArrayExpression",
  "ObjectExpression",
  "TemplateLiteral",
  "UnaryExpression",
  "BinaryExpression",
]);

/** Reads the `hydrate` export: a strategy for every component, or one per component. */
function readStrategies(
  program: AstNode,
  fail: (message: string, node: AstNode) => never,
): { all?: IslandStrategy; byName: Map<string, IslandStrategy> } {
  const byName = new Map<string, IslandStrategy>();
  const check = (value: unknown, node: AstNode): IslandStrategy => {
    if (typeof value !== "string" || !ISLAND_STRATEGIES.includes(value as IslandStrategy)) {
      fail(`hydrate must be one of ${ISLAND_STRATEGIES.map((s) => `"${s}"`).join(", ")}`, node);
    }
    return value as IslandStrategy;
  };
  for (const node of program.body ?? []) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration?.type !== "VariableDeclaration")
      continue;
    for (const declarator of node.declaration.declarations ?? []) {
      if (declarator.id?.type !== "Identifier" || declarator.id.name !== "hydrate") continue;
      let init = declarator.init as AstNode | null;
      // `"visible" as const`, `{ … } satisfies …`
      while (init && (init.type === "TSAsExpression" || init.type === "TSSatisfiesExpression"))
        init = init.expression;
      if (init?.type === "Literal") return { all: check(init.value, init), byName };
      if (init?.type === "ObjectExpression") {
        for (const property of init.properties ?? []) {
          const key = property.key?.type === "Identifier" ? property.key.name : property.key?.value;
          if (
            property.type !== "Property" ||
            property.computed ||
            typeof key !== "string" ||
            property.value?.type !== "Literal"
          ) {
            fail(
              'hydrate must be a string, or an object of strings: { Chart: "visible" }',
              property,
            );
          }
          byName.set(key, check(property.value.value, property.value));
        }
        return { byName };
      }
      fail('hydrate must be written as a literal: "visible", or { Chart: "visible" }', declarator);
    }
  }
  return { byName };
}

/** Wraps a `"use client"` module's components as islands, or returns null for any other module. */
export function transformClientModule(
  options: TransformClientOptions,
): TransformClientResult | null {
  const { code, id, root } = options;
  if (!hasModuleDirective(code, options.directive ?? "use client")) return null;
  const file = id.split("?", 1)[0]!;
  const relative = path.relative(root, file).split(path.sep).join("/");
  const program = options.parse(code);
  const fail = (message: string, node: AstNode): never => {
    throw new ActionCompileError(message, file, code, node.start);
  };
  const strategies = readStrategies(program, fail);
  const strategyOf = (name: string): IslandStrategy => {
    const configured = options.strategy?.(name);
    if (configured !== undefined && !ISLAND_STRATEGIES.includes(configured)) {
      throw new Error(`islx: strategy for ${name} must be one of ${ISLAND_STRATEGIES.join(", ")}`);
    }
    return configured ?? strategies.byName.get(name) ?? strategies.all ?? "load";
  };

  const output = new MagicString(code);
  const wrapped: Array<{ local: string; exportName: string }> = [];
  for (const node of program.body ?? []) {
    if (node.type === "ExportNamedDeclaration" && !node.source && node.exportKind !== "type") {
      const declaration = node.declaration;
      if (declaration) {
        const names: string[] =
          declaration.type === "VariableDeclaration"
            ? declaration.declarations.flatMap((d: AstNode) =>
                d.id?.type === "Identifier" && !(d.init && VALUE_TYPES.has(d.init.type))
                  ? [d.id.name]
                  : [],
              )
            : declaration.id?.name
              ? [declaration.id.name]
              : [];
        const declared =
          declaration.type === "VariableDeclaration"
            ? declaration.declarations.length
            : names.length;
        const components = names.filter(isComponentName);
        if (components.length === 0 || String(declaration.type).startsWith("TS")) continue;
        if (components.length !== declared) {
          fail("Export components and other values in separate statements", declaration);
        }
        // `export function Chart` → `function Chart`, exported wrapped below.
        output.remove(node.start, declaration.start);
        for (const name of components) wrapped.push({ local: name, exportName: name });
        continue;
      }
      const kept: string[] = [];
      for (const specifier of node.specifiers ?? []) {
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        const local = specifier.local?.name ?? specifier.local?.value;
        if (
          specifier.exportKind !== "type" &&
          (isComponentName(exported) || exported === "default")
        ) {
          wrapped.push({ local, exportName: exported });
        } else {
          kept.push(output.slice(specifier.start, specifier.end));
        }
      }
      output.overwrite(
        node.start,
        node.end,
        kept.length > 0 ? `export { ${kept.join(", ")} };` : "",
      );
    } else if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      if (
        FUNCTION_TYPES.has(declaration.type) ||
        declaration.type === "ClassDeclaration" ||
        declaration.type === "ClassExpression"
      ) {
        if (declaration.id?.name) {
          output.remove(node.start, declaration.start);
          wrapped.push({ local: declaration.id.name, exportName: "default" });
        } else {
          output.overwrite(node.start, declaration.start, "const $$islx_default = ");
          wrapped.push({ local: "$$islx_default", exportName: "default" });
        }
      } else if (declaration.type === "Identifier" || declaration.type.endsWith("Expression")) {
        output.overwrite(node.start, declaration.start, "const $$islx_default = ");
        if (!code.slice(declaration.end, node.end).includes(";"))
          output.appendLeft(declaration.end, ";");
        wrapped.push({ local: "$$islx_default", exportName: "default" });
      }
    }
  }
  if (wrapped.length === 0) return null;

  const runtime = options.runtime ?? "@farm.js/islx/react";
  const src = options.reference(relative);
  const lines = [
    ...wrapped.map(({ local, exportName }, index) => {
      return `const $$islx_island_${index} = $$islx_island(${local}, ${src}, ${JSON.stringify(exportName)}, ${JSON.stringify(strategyOf(exportName === "default" ? "default" : exportName))});`;
    }),
    `export { ${wrapped.map(({ exportName }, index) => `$$islx_island_${index} as ${exportName}`).join(", ")} };`,
  ];
  const imports = [
    `import { createIsland as $$islx_island } from ${JSON.stringify(runtime)};`,
    ...(options.sideEffects ?? []).map((module) => `import ${JSON.stringify(module)};`),
  ];
  output.prepend(`${imports.join("\n")}\n`);
  output.append(`\n${lines.join("\n")}\n`);
  return {
    code: output.toString(),
    map: output.generateMap({ hires: true, source: file }),
    islands: wrapped.map(({ exportName }) => ({ exportName, strategy: strategyOf(exportName) })),
  };
}
