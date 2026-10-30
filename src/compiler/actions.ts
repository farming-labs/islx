/**
 * The server-action compiler: a pure function from a module's source to its source for the
 * server or the browser. Bundler plugins call it; it parses with the parser they pass.
 *
 * - A `"use server"` module: on the server every export registers as an action; in the browser
 *   the module becomes references that call those ids, so its code never reaches a bundle.
 * - An inline `"use server"` function in server code: hoisted to module scope, taking the
 *   variables it read from the component around it as one array. Where it was written, it
 *   becomes a reference that carries those variables, sealed.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { walk } from "estree-walker";
import isReference from "is-reference";
import MagicString from "magic-string";
import { analyze, type Scope } from "periscopic";

/** An ESTree node with source offsets, as Rollup, Rolldown, oxc and acorn produce. */
export interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: any;
}

export interface TransformActionsOptions {
  /** The module's source. */
  code: string;
  /** The module's file path. */
  id: string;
  /** The app root: ids are made from paths relative to it, so they match on every machine. */
  root: string;
  /** Whether the output runs on the server or in the browser. */
  environment: "server" | "client";
  /** Parses JavaScript (or the language the plugin runs after) to an ESTree program. */
  parse(code: string): AstNode;
  /** Mixed into every id, so ids of one build are not guessable from another's. */
  salt?: string;
  /** The directive that marks actions, at the top of a module or a function. Default `"use server"`. */
  directive?: string;
  /** Where the runtime is imported from. */
  runtime?: { server?: string; client?: string };
}

export interface TransformActionsResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

/** A mistake in the source, with where it is. Bundlers show `loc` with a code frame. */
export class ActionCompileError extends Error {
  readonly loc: { file: string; line: number; column: number };
  readonly id: string;
  constructor(message: string, file: string, code: string, offset: number) {
    const before = code.slice(0, offset).split("\n");
    const line = before.length;
    const column = before.at(-1)!.length;
    super(`${message} (${file}:${line}:${column + 1})`);
    this.name = "ActionCompileError";
    this.id = file;
    this.loc = { file, line, column };
  }
}

/**
 * Whether the module's directive prologue (the strings before any other statement, after
 * comments) holds `directive`. A linear scan, for a cheap check before parsing.
 */
export function hasModuleDirective(code: string, directive: string): boolean {
  let index = 0;
  while (index < code.length) {
    const char = code.charCodeAt(index);
    if (char === 32 || (char >= 9 && char <= 13) || char === 0xfeff || char === 0xa0) {
      index++;
    } else if (code.startsWith("//", index)) {
      const end = code.indexOf("\n", index);
      if (end === -1) return false;
      index = end + 1;
    } else if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 2;
    } else if (char === 34 || char === 39) {
      const quote = code[index]!;
      const end = code.indexOf(quote, index + 1);
      if (end === -1) return false;
      const value = code.slice(index + 1, end);
      index = end + 1;
      while (index < code.length && /[ \t]/.test(code[index]!)) index++;
      if (code[index] === ";") index++;
      else if (index < code.length && code[index] !== "\n" && code[index] !== "\r") return false;
      if (value === directive) return true;
    } else {
      return false;
    }
  }
  return false;
}

/** The id an action has on both sides: a hash of its module path from the root and its name. */
export function getActionId(root: string, file: string, name: string, salt = ""): string {
  const relative = path.relative(root, file.split("?", 1)[0]!).split(path.sep).join("/");
  return createHash("sha256").update(`${salt}${relative}#${name}`).digest("base64url").slice(0, 22);
}

function hasDirective(statements: AstNode[] | undefined, directive: string): boolean {
  for (const statement of statements ?? []) {
    if (statement.type !== "ExpressionStatement") return false;
    const expression = statement.expression;
    const value =
      statement.directive ?? (expression?.type === "Literal" ? expression.value : undefined);
    if (typeof value !== "string") return false;
    if (value === directive) return true;
  }
  return false;
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

function isInlineAction(node: AstNode, directive: string): boolean {
  return (
    FUNCTION_TYPES.has(node.type) &&
    node.body?.type === "BlockStatement" &&
    hasDirective(node.body.body, directive)
  );
}

interface InlineAction {
  node: AstNode;
  parent: AstNode | null;
  /** Whether a function encloses it: module-level actions capture nothing and stay in place. */
  nested: boolean;
  name: string | null;
  captured: string[];
  /** The scope stack index of the action's own scope. */
  scopeIndex: number;
}

interface ExportEntry {
  exported: string;
  local: string | null;
  node: AstNode;
}

function actionName(node: AstNode, parent: AstNode | null): string | null {
  if (node.id?.name) return node.id.name;
  if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier")
    return parent.id.name;
  if (parent?.type === "Property" && parent.key?.type === "Identifier") return parent.key.name;
  if (parent?.type === "JSXExpressionContainer") return null;
  return null;
}

/** Exports of a `"use server"` module, refusing what cannot be an action. */
function collectExports(
  program: AstNode,
  fail: (message: string, node: AstNode) => never,
  directive: string,
): ExportEntry[] {
  const exports: ExportEntry[] = [];
  const onlyAsync = `A "${directive}" module may export only async functions`;
  const checkFunction = (node: AstNode, name: string) => {
    if (FUNCTION_TYPES.has(node.type)) {
      if (!node.async) fail(`${onlyAsync}: make ${name} async`, node);
      if (node.generator) fail(`${onlyAsync}: ${name} is a generator`, node);
      return;
    }
    if (
      node.type === "Literal" ||
      node.type === "ObjectExpression" ||
      node.type === "ArrayExpression" ||
      node.type === "TemplateLiteral" ||
      node.type === "ClassExpression"
    ) {
      fail(`${onlyAsync}; ${name} is not a function`, node);
    }
    // An identifier or a call: checked when the module registers it.
  };
  for (const node of program.body ?? []) {
    if (node.type === "ExportAllDeclaration") {
      fail(
        `"${directive}" modules cannot re-export with \`export *\`: export each action by name`,
        node,
      );
    }
    if (node.type === "ExportNamedDeclaration") {
      if (node.exportKind === "type") continue;
      if (node.source) {
        fail(
          `"${directive}" modules cannot re-export from another module: import the actions, then export them`,
          node,
        );
      }
      const declaration = node.declaration;
      if (declaration?.type === "FunctionDeclaration") {
        checkFunction(declaration, declaration.id.name);
        exports.push({
          exported: declaration.id.name,
          local: declaration.id.name,
          node: declaration,
        });
      } else if (declaration?.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations ?? []) {
          if (declarator.id?.type !== "Identifier") {
            fail(`${onlyAsync}; destructured exports are not supported`, declarator);
          }
          if (declarator.init) checkFunction(declarator.init, declarator.id.name);
          exports.push({
            exported: declarator.id.name,
            local: declarator.id.name,
            node: declarator,
          });
        }
      } else if (declaration?.type === "ClassDeclaration") {
        fail(`${onlyAsync}; ${declaration.id?.name ?? "a class"} is a class`, declaration);
      } else if (declaration && !String(declaration.type).startsWith("TS")) {
        fail(onlyAsync, declaration);
      }
      for (const specifier of node.specifiers ?? []) {
        if (specifier.exportKind === "type") continue;
        const exported = specifier.exported?.name ?? specifier.exported?.value;
        exports.push({ exported, local: specifier.local?.name ?? null, node: specifier });
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const declaration = node.declaration;
      checkFunction(declaration, "the default export");
      const local =
        (FUNCTION_TYPES.has(declaration.type) && declaration.id?.name) ||
        (declaration.type === "Identifier" && declaration.name) ||
        null;
      exports.push({ exported: "default", local, node });
    }
  }
  return exports;
}

/**
 * Compiles a module's server actions, or returns null when it has none. Throws an
 * `ActionCompileError` for a mistake, such as an inline action in browser code.
 */
export function transformActions(options: TransformActionsOptions): TransformActionsResult | null {
  const { code, id, root, environment } = options;
  const salt = options.salt ?? "";
  const serverRuntime = options.runtime?.server ?? "@farm.js/islx/server";
  const clientRuntime = options.runtime?.client ?? "@farm.js/islx/client";
  const directive = options.directive ?? "use server";
  const moduleDirective = hasModuleDirective(code, directive);
  if (!moduleDirective && !code.includes(directive)) return null;

  const program = options.parse(code);
  const file = id.split("?", 1)[0]!;
  const relative = path.relative(root, file).split(path.sep).join("/");
  const fail = (message: string, node: AstNode): never => {
    throw new ActionCompileError(message, file, code, node.start);
  };
  const actionId = (name: string) => getActionId(root, file, name, salt);
  const label = (name: string) => `${name} (${relative})`;

  if (moduleDirective && environment === "client") {
    const exports = collectExports(program, fail, directive);
    const lines = [
      `import { createServerReference as $$islx_ref } from ${JSON.stringify(clientRuntime)};`,
    ];
    for (const entry of exports) {
      const reference = `$$islx_ref(${JSON.stringify(actionId(entry.exported))}, undefined, ${JSON.stringify(entry.exported === "default" ? "default" : entry.exported)})`;
      lines.push(
        entry.exported === "default"
          ? `export default ${reference};`
          : `export const ${entry.exported} = ${reference};`,
      );
    }
    const output = new MagicString(code);
    output.overwrite(0, code.length, `${lines.join("\n")}\n`);
    return { code: output.toString(), map: output.generateMap({ hires: true, source: file }) };
  }

  // Find inline actions, with the variables each reads from the functions around it.
  const { map, scope: moduleScope } = analyze(program as any);
  const scopes: Scope[] = [moduleScope];
  const scopeNodes: AstNode[] = [program];
  const inline: InlineAction[] = [];
  const active: InlineAction[] = [];
  let functionDepth = 0;
  // Per active action: how many plain functions deep inside it the walk is (`this` is theirs).
  const ownFunctionDepth: number[] = [];

  walk(program as any, {
    enter(rawNode: any, rawParent: any) {
      const node = rawNode as AstNode;
      const parent = rawParent as AstNode | null;
      if (typeof node.type === "string" && node.type.startsWith("TS")) {
        this.skip();
        return;
      }
      const scope = node === program ? undefined : map.get(node as any);
      if (scope) {
        scopes.push(scope);
        scopeNodes.push(node);
      }
      if (FUNCTION_TYPES.has(node.type)) {
        if (isInlineAction(node, directive) && !(moduleDirective && functionDepth === 0)) {
          if (environment === "client") {
            fail(
              `An inline "${directive}" function can only be written in server code. ` +
                `Move it to a "${directive}" module and import it here`,
              node,
            );
          }
          if (!node.async) fail("A server action must be an async function", node);
          if (node.generator) fail("A server action cannot be a generator", node);
          const action: InlineAction = {
            node,
            parent,
            nested: functionDepth > 0,
            name: actionName(node, parent),
            captured: [],
            scopeIndex: scopes.length - 1,
          };
          inline.push(action);
          active.push(action);
          ownFunctionDepth.push(0);
        } else if (node.type !== "ArrowFunctionExpression") {
          for (let index = 0; index < ownFunctionDepth.length; index++) ownFunctionDepth[index]!++;
        }
        functionDepth++;
        return;
      }
      if (active.length === 0) return;
      if (
        node.type === "ThisExpression" ||
        (node.type === "Identifier" &&
          node.name === "arguments" &&
          parent &&
          isReference(node as any, parent as any))
      ) {
        for (let index = 0; index < active.length; index++) {
          if (ownFunctionDepth[index] === 0) {
            fail(
              `A server action cannot use \`${node.type === "ThisExpression" ? "this" : "arguments"}\`: ` +
                "pass what it needs as an argument",
              node,
            );
          }
        }
        return;
      }
      if (node.type !== "Identifier" || !parent || !isReference(node as any, parent as any)) return;
      // A function's own name is a declaration, not a read.
      if (parent.id === node && FUNCTION_TYPES.has(parent.type)) return;
      const owner = scopes.at(-1)!.find_owner(node.name);
      if (!owner || owner === moduleScope) return;
      const ownerIndex = scopes.lastIndexOf(owner);
      for (const action of active) {
        if (
          ownerIndex > 0 &&
          ownerIndex < action.scopeIndex &&
          !action.captured.includes(node.name)
        ) {
          if (action.node.type === "FunctionDeclaration" && action.name === node.name) {
            fail(
              `The server action ${node.name} refers to itself. ` +
                `To call it again, move it to a "${directive}" module`,
              node,
            );
          }
          action.captured.push(node.name);
        }
      }
    },
    leave(rawNode: any) {
      const node = rawNode as AstNode;
      if (scopeNodes.at(-1) === node && node !== program) {
        scopes.pop();
        scopeNodes.pop();
      }
      if (FUNCTION_TYPES.has(node.type)) {
        functionDepth--;
        if (active.at(-1)?.node === node) {
          active.pop();
          ownFunctionDepth.pop();
        } else if (node.type !== "ArrowFunctionExpression") {
          for (let index = 0; index < ownFunctionDepth.length; index++) ownFunctionDepth[index]!--;
        }
      }
    },
  });

  if (inline.length === 0 && !moduleDirective) return null;
  const output = new MagicString(code);
  const footer: string[] = [];
  let usesBind = false;
  let usesInline = false;
  let usesReference = false;

  // Ids by source order; rewrites innermost first, so an outer action's body already holds the
  // inner one's replacement when it is moved.
  const numbered = [...inline].sort((a, b) => a.node.start - b.node.start);
  const ids = new Map(numbered.map((action, index) => [action, index]));
  for (const action of [...inline].sort((a, b) => b.node.start - a.node.start)) {
    const index = ids.get(action)!;
    const name = action.name ?? `action ${index + 1}`;
    const idValue = actionId(`inline:${index}`);
    const { node } = action;
    if (!action.nested) {
      // Module level: it captures nothing; it stays where it is and registers as it is.
      usesReference = true;
      if (node.type === "FunctionDeclaration") {
        footer.push(
          `$$islx_ref(${node.id.name}, ${JSON.stringify(idValue)}, ${JSON.stringify(label(name))});`,
        );
      } else {
        output.prependLeft(node.start, "$$islx_ref(");
        output.appendRight(
          node.end,
          `, ${JSON.stringify(idValue)}, ${JSON.stringify(label(name))})`,
        );
      }
      continue;
    }
    usesBind = true;
    usesInline = true;
    const hoisted = `$$islx_action_${index}`;
    const params = node.params.map((param: AstNode) => output.slice(param.start, param.end));
    const captured =
      action.captured.length > 0 ? `[${action.captured.join(", ")}]` : "$$islx_captured";
    const body = output.slice(node.body.start + 1, node.body.end - 1);
    footer.push(
      `async function ${hoisted}(${[captured, ...params].join(", ")}) {${body}}`,
      `$$islx_inline(${hoisted}, ${JSON.stringify(idValue)}, ${action.captured.length}, ${JSON.stringify(label(name))});`,
    );
    const reference = `$$islx_bind(${JSON.stringify(idValue)}, () => [${action.captured.join(", ")}], ${JSON.stringify(action.captured)})`;
    if (node.type === "FunctionDeclaration") {
      // Declarations are visible to the whole block: bind it at the block's start. Captured
      // variables are read lazily, so ones declared later in the block are fine.
      const block = action.parent;
      if (!block || (block.type !== "BlockStatement" && block.type !== "StaticBlock")) {
        fail("Declare this server action directly inside a function body", node);
      }
      output.remove(node.start, node.end);
      output.appendRight(block!.start + 1, `const ${node.id.name} = ${reference};`);
    } else {
      output.overwrite(node.start, node.end, reference);
    }
  }

  if (moduleDirective) {
    usesReference = true;
    for (const entry of collectExports(program, fail, directive)) {
      if (!entry.local) {
        // `export default async function () {}`: give it a name to register.
        const declaration = entry.node.declaration as AstNode;
        output.overwrite(entry.node.start, declaration.start, "const $$islx_default = ");
        footer.push("export { $$islx_default as default };");
        entry.local = "$$islx_default";
      }
      footer.push(
        `$$islx_ref(${entry.local}, ${JSON.stringify(actionId(entry.exported))}, ${JSON.stringify(label(entry.exported))});`,
      );
    }
  }

  const imports = [
    usesBind && "bindInlineAction as $$islx_bind",
    usesInline && "registerInlineAction as $$islx_inline",
    usesReference && "registerServerReference as $$islx_ref",
  ].filter(Boolean);
  output.prepend(`import { ${imports.join(", ")} } from ${JSON.stringify(serverRuntime)};\n`);
  output.append(`\n${footer.join("\n")}\n`);
  return { code: output.toString(), map: output.generateMap({ hires: true, source: file }) };
}
