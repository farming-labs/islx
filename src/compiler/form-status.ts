/**
 * Points a client module's `useFormStatus` import from `react-dom` at islx's hook, which also
 * reports a server component's form around an island (`@farm.js/islx/react` `useFormStatus`).
 * Both builds rewrite it, so the server and the browser render the same hook. A namespace import
 * (`ReactDOM.useFormStatus()`) keeps React's.
 */
import MagicString from "magic-string";
import type { AstNode } from "./actions";

const HOOK = "useFormStatus";

function importedName(specifier: AstNode): string | undefined {
  const imported = specifier.imported;
  return imported?.type === "Identifier" ? imported.name : imported?.value;
}

/** Applies the rewrite to `output`; true when the module imported the hook. */
export function rewriteFormStatusImport(
  program: AstNode,
  code: string,
  output: MagicString,
  from: string,
): boolean {
  let changed = false;
  for (const node of program.body ?? []) {
    if (node.type !== "ImportDeclaration" || node.source?.value !== "react-dom") continue;
    if (node.importKind === "type") continue;
    const specifiers: AstNode[] = node.specifiers ?? [];
    const hooks = specifiers.filter(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        importedName(specifier) === HOOK,
    );
    if (hooks.length === 0) continue;
    const others = specifiers.filter((specifier) => !hooks.includes(specifier));
    const defaults = others.filter((specifier) => specifier.type !== "ImportSpecifier");
    const named = others.filter((specifier) => specifier.type === "ImportSpecifier");
    const text = (specifier: AstNode) => code.slice(specifier.start, specifier.end);
    const clause = [
      ...defaults.map(text),
      ...(named.length > 0 ? [`{ ${named.map(text).join(", ")} }`] : []),
    ].join(", ");
    const lines = [
      ...(clause ? [`import ${clause} from "react-dom";`] : []),
      `import { ${hooks.map((hook) => `${HOOK} as ${hook.local.name}`).join(", ")} } from ${JSON.stringify(from)};`,
    ];
    output.overwrite(node.start, node.end, lines.join("\n"));
    changed = true;
  }
  return changed;
}

/** The rewrite for a framework's own transform: the module's new code and map, or null. */
export function rewriteFormStatusImports(options: {
  code: string;
  id: string;
  parse(code: string): AstNode;
  /** The module islx's React entry resolves as. Default `@farm.js/islx/react`. */
  from?: string;
}): { code: string; map: ReturnType<MagicString["generateMap"]> } | null {
  if (!options.code.includes(HOOK)) return null;
  const output = new MagicString(options.code);
  const program = options.parse(options.code);
  if (
    !rewriteFormStatusImport(program, options.code, output, options.from ?? "@farm.js/islx/react")
  )
    return null;
  return { code: output.toString(), map: output.generateMap({ source: options.id, hires: true }) };
}
