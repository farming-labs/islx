/**
 * When an island hydrates if its module sets no `hydrate` export: `"interaction"` when its code
 * provably does nothing before a click, `"load"` otherwise. Such an island renders exactly its
 * server HTML until it is clicked, so it can wait: the scheduler holds that click (or a submit),
 * hydrates the island, and replays it. A press or a focus on the island starts hydrating it early.
 *
 * The checks read the module and the app files it imports. They prove the island can wait when:
 *
 * - it calls no hook that runs code after a render or reads outside React: `useEffect`,
 *   `useLayoutEffect`, `useInsertionEffect`, `useSyncExternalStore`, `useImperativeHandle`, `use`,
 *   `useActionState`, `useOptimistic`, `useFormStatus`, `useDeferredValue`, `useEffectEvent`;
 * - its HTML elements handle only `onClick` and `onSubmit` (a handled link only when its `href` is a
 *   `#` link on the page), and none is a form field, takes a `ref`, `autoFocus`, `contentEditable`,
 *   a form `action` or `formAction`, or props spread onto it;
 * - it declares no class, calls no `createElement`, `cloneElement`, `forwardRef` or `createRef`,
 *   and imports nothing at runtime;
 * - its top level only declares values (`createContext()` and `memo()` included);
 * - it imports only React, stylesheets and assets, and app files that pass the same checks.
 *
 * Anything the checks cannot prove, a package import or a file they cannot read included, keeps
 * `"load"`. Renderer-neutral as a contract: the rules here are React's.
 */
import fs from "node:fs";
import path from "node:path";
import type { AstNode } from "./actions";

export interface InferOptions {
  /** Parses a module's source (TypeScript and JSX included) to an ESTree program. */
  parse(file: string, code: string): AstNode;
  /**
   * Resolves an import to a source file of the app's own, or null for a package or anything
   * unknown (which keeps `"load"`). Default: relative and root-absolute paths, with the usual
   * extensions and index files.
   */
  resolve?(specifier: string, importer: string): string | null;
}

export interface Inference {
  /** `"interaction"` when the islands can wait; null to keep `"load"`. */
  strategy: "interaction" | null;
  /** The source files the result read, the module itself first. */
  files: string[];
  /** Why the islands keep `"load"`. */
  reason?: string;
}

const EFFECT_HOOKS = new Set([
  "useEffect",
  "useLayoutEffect",
  "useInsertionEffect",
  "useSyncExternalStore",
  "useImperativeHandle",
  "use",
  "useActionState",
  "useOptimistic",
  "useFormStatus",
  "useDeferredValue",
  "useEffectEvent",
]);
const UNREADABLE_CALLS = new Set(["createElement", "cloneElement", "forwardRef", "createRef"]);
const REACT_MODULES = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"]);
const HELD_EVENTS = new Set(["onClick", "onSubmit"]);
const FORM_CONTROLS = new Set(["input", "textarea", "select"]);
const ASSET_IMPORT =
  /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|json)(?:\?.*)?$/;
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

function defaultResolve(specifier: string, importer: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

/** Infers when the islands `file` exports hydrate; `code` is its source. */
export function inferStrategy(file: string, code: string, options: InferOptions): Inference {
  const resolve = options.resolve ?? defaultResolve;
  const files: string[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; code: string | null }> = [{ file, code }];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.file)) continue;
    seen.add(next.file);
    files.push(next.file);
    let source = next.code;
    if (source === null) {
      try {
        source = fs.readFileSync(next.file, "utf8");
      } catch {
        return { strategy: null, files, reason: `${path.basename(next.file)} could not be read` };
      }
    }
    const imports: string[] = [];
    const reason = inspect(next.file, source, options.parse, (specifier) => {
      if (REACT_MODULES.has(specifier) || ASSET_IMPORT.test(specifier)) return null;
      const resolved = resolve(specifier, next.file);
      if (!resolved || resolved.includes(`${path.sep}node_modules${path.sep}`)) {
        return `imports ${specifier}`;
      }
      imports.push(resolved);
      return null;
    });
    if (reason) return { strategy: null, files, reason: `${path.basename(next.file)}: ${reason}` };
    for (const imported of imports) queue.push({ file: imported, code: null });
  }
  return { strategy: "interaction", files };
}

function inspect(
  file: string,
  source: string,
  parse: InferOptions["parse"],
  importSource: (specifier: string) => string | null,
): string | null {
  let program: AstNode;
  try {
    program = parse(file, source);
  } catch {
    return "could not be parsed";
  }
  for (const statement of program.body ?? []) {
    const problem = topLevelProblem(statement, importSource);
    if (problem) return problem;
  }
  return findProblem(program);
}

function isTypeOnly(node: AstNode): boolean {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  const specifiers: AstNode[] = node.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type");
}

/** What a top-level statement does as the module loads, which waiting would delay. */
function topLevelProblem(
  statement: AstNode,
  importSource: (specifier: string) => string | null,
): string | null {
  switch (statement.type) {
    case "ImportDeclaration":
      return isTypeOnly(statement) ? null : importSource(statement.source.value);
    case "ExportAllDeclaration":
      return statement.exportKind === "type" ? null : importSource(statement.source.value);
    case "ExportNamedDeclaration":
      if (statement.source) {
        return isTypeOnly(statement) ? null : importSource(statement.source.value);
      }
      return statement.declaration ? topLevelProblem(statement.declaration, importSource) : null;
    case "ExportDefaultDeclaration":
      return statement.declaration.type === "FunctionDeclaration" ||
        String(statement.declaration.type).startsWith("TS")
        ? null
        : pureValueProblem(statement.declaration);
    case "ExpressionStatement":
      // A directive ("use client") is the only expression a module may evaluate.
      return typeof statement.directive === "string" ? null : "runs code as it loads";
    case "VariableDeclaration":
      for (const declarator of statement.declarations ?? []) {
        const problem = declarator.init ? pureValueProblem(declarator.init) : null;
        if (problem) return problem;
      }
      return null;
    case "FunctionDeclaration":
    case "EmptyStatement":
      return null;
    case "ClassDeclaration":
      return "declares a class";
    default:
      return String(statement.type).startsWith("TS") ? null : `has a top-level ${statement.type}`;
  }
}

/** Whether evaluating `node` at the top level does anything but build a value. */
function pureValueProblem(node: AstNode): string | null {
  switch (node.type) {
    case "Literal":
    case "Identifier":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "MemberExpression":
      return null;
    case "TemplateLiteral":
      return firstProblem(node.expressions, pureValueProblem);
    case "ArrayExpression":
      return firstProblem(node.elements.filter(Boolean), pureValueProblem);
    case "ObjectExpression":
      return firstProblem(node.properties, (property: AstNode) =>
        property.type === "SpreadElement"
          ? pureValueProblem(property.argument)
          : property.computed
            ? "has a computed key"
            : pureValueProblem(property.value),
      );
    case "UnaryExpression":
    case "SpreadElement":
      return pureValueProblem(node.argument);
    case "BinaryExpression":
    case "LogicalExpression":
      return pureValueProblem(node.left) ?? pureValueProblem(node.right);
    case "ConditionalExpression":
      return (
        pureValueProblem(node.test) ??
        pureValueProblem(node.consequent) ??
        pureValueProblem(node.alternate)
      );
    case "CallExpression": {
      // createContext() and memo() build values; any other call runs code as the module loads.
      const name = memberCallName(node.callee);
      if (name === "createContext" || name === "memo" || name === "Object.freeze") {
        return firstProblem(node.arguments, pureValueProblem);
      }
      return "runs code as it loads";
    }
    default:
      return String(node.type).startsWith("TS") && node.expression
        ? pureValueProblem(node.expression)
        : `evaluates a ${node.type} as it loads`;
  }
}

function firstProblem<T>(items: T[], check: (item: T) => string | null): string | null {
  for (const item of items) {
    const problem = check(item);
    if (problem) return problem;
  }
  return null;
}

function memberCallName(callee: AstNode): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.object.type === "Identifier" && callee.object.name === "Object"
      ? `Object.${callee.property.name}`
      : callee.property.name;
  }
  return null;
}

/** A call to one of React's functions: `name()` or `React.name()`, not `document.name()`. */
function reactCallName(callee: AstNode): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "React" &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

function isHashHref(value: AstNode | null | undefined): boolean {
  if (!value) return false;
  if (value.type === "Literal") {
    return typeof value.value === "string" && value.value.startsWith("#");
  }
  if (value.type !== "JSXExpressionContainer") return false;
  const expression = value.expression;
  if (expression.type === "Literal") {
    return typeof expression.value === "string" && expression.value.startsWith("#");
  }
  return (
    expression.type === "TemplateLiteral" &&
    String(expression.quasis[0]?.value?.cooked ?? "").startsWith("#")
  );
}

/** What an HTML element does that an island waiting for a click would get wrong. */
function hostElementProblem(element: AstNode): string | null {
  // A component (`<Theme.Provider>` too): its own module decides, through its import.
  if (element.name.type !== "JSXIdentifier") return null;
  const tag: string = element.name.name;
  if (!/^[a-z]/.test(tag)) return null;
  if (FORM_CONTROLS.has(tag)) return `renders <${tag}>`;
  let href: AstNode | null | undefined;
  let clicks = false;
  for (const attribute of element.attributes ?? []) {
    if (attribute.type === "JSXSpreadAttribute") return `spreads props onto <${tag}>`;
    const name = attribute.name?.type === "JSXIdentifier" ? attribute.name.name : null;
    if (name === null) continue;
    if (name === "ref") return `sets a ref on <${tag}>`;
    if (name === "autoFocus") return `sets autoFocus on <${tag}>`;
    if (name === "contentEditable") return `makes <${tag}> editable`;
    if (tag === "form" && name === "action") return "gives a form an action";
    if (name === "formAction") return `sets formAction on <${tag}>`;
    if (name === "href") href = attribute.value;
    if (/^on[A-Z]/.test(name)) {
      if (!HELD_EVENTS.has(name)) return `handles ${name}`;
      if (name === "onClick") clicks = true;
    }
  }
  if (tag === "a" && clicks && !isHashHref(href)) return "handles a click on a link";
  return null;
}

function findProblem(node: AstNode): string | null {
  switch (node.type) {
    case "CallExpression": {
      const name = reactCallName(node.callee);
      if (name && (EFFECT_HOOKS.has(name) || UNREADABLE_CALLS.has(name))) return `calls ${name}`;
      break;
    }
    case "JSXOpeningElement": {
      const problem = hostElementProblem(node);
      if (problem) return problem;
      break;
    }
    case "ClassDeclaration":
    case "ClassExpression":
      return "declares a class";
    case "ImportExpression":
      return "imports a module at runtime";
  }
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "range" || key === "loc") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") {
          const problem = findProblem(child);
          if (problem) return problem;
        }
      }
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      const problem = findProblem(value);
      if (problem) return problem;
    }
  }
  return null;
}
