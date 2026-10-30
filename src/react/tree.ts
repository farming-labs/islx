/**
 * Server trees: a page as a serialized React tree, the role React Server Components' Flight
 * payload has, for pages under a layout that hydrates as one React root.
 *
 * A page that cannot hydrate (it is async, or it reads server data) used to keep its client
 * components as islands of their own, which cannot read the layout's context. Instead the server
 * resolves the page into host elements and client-component references, renders that tree, and
 * embeds it as JSON (`<script type="f/tree">`). The browser rebuilds the same tree inside the
 * layout's root, so the page's client components hydrate as the layout's descendants.
 *
 * Anything the resolver cannot represent (a server component that calls hooks, a class component,
 * a client component whose props do not serialize, an unknown element type) renders as server
 * HTML inside `<f-html>`, whose own client components hydrate as islands.
 */
import * as React from "react";
import { NOT_A_VALUE, decodeTagged, encodeLeaf } from "../protocol/codec";
import {
  CHUNK_SCRIPT_TYPE,
  HTML_ELEMENT,
  REFERENCE_TAG,
  TAG,
  TREE_SCRIPT_TYPE,
  VALUE_SCRIPT_TYPE,
} from "../protocol/wire";
import { createServerReference } from "../client/actions";
import { getValueStore, type ValueStore } from "../client/value-store";
import { getClientReference, getIslandServerHook, isolateIslands } from "./island";

const MEMO_TYPE = Symbol.for("react.memo");
const FORWARD_REF_TYPE = Symbol.for("react.forward_ref");
/** The element around server HTML a tree cannot represent; its `name` is the HTML's id. */
const SERVER_HTML_TAG = HTML_ELEMENT;
/**
 * Marks a navigation response that carries only the page's payload. The browser rebuilds such a
 * page in its layout's React root and never shows its HTML, so the server leaves the HTML out.
 */
export const PAYLOAD_ONLY_ATTRIBUTE = "partial";
const SERVER_HTML_ATTRIBUTE = "name";

// The HTML parser moves or drops a custom element placed inside these, so a subtree that needs a
// `<f-html>` wrapper there is wrapped at the nearest ancestor outside them instead.
const PARSER_SENSITIVE_TAGS = /* @__PURE__ */ new Set([
  "caption",
  "colgroup",
  "datalist",
  "head",
  "html",
  "iframe",
  "math",
  "noscript",
  "optgroup",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
]);

type TreeValue = null | boolean | number | string | TreeValue[] | { [key: string]: TreeValue };

/** Thrown where the resolver cannot represent a node; the node then renders as server HTML. */
class UnsupportedNode extends Error {}
/** An unsupported node inside a parser-sensitive element; its outermost such ancestor wraps. */
class UnsupportedInParserSensitiveElement extends Error {}

interface ResolvedChunk {
  status: "pending" | "fulfilled" | "rejected";
  value?: React.ReactNode;
  reason?: unknown;
  promise: Promise<React.ReactNode>;
}

interface TreeResolver {
  component(reference: string, exportName: string): React.ComponentType<any>;
  chunk(id: number): ResolvedChunk;
  serverHtml(id: number, key: React.Key | null): React.ReactElement;
  /** The function a server action reference stands for. */
  action(id: string, sealed: string | undefined): unknown;
}

type ReactInternals = { H?: unknown; ReactCurrentDispatcher?: { current: unknown } };

function getHooksDispatcherSlot() {
  const runtime = React as unknown as Record<string, ReactInternals | undefined>;
  const react19 = runtime.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (react19 && "H" in react19) {
    return {
      get: () => react19.H,
      set: (value: unknown) => {
        react19.H = value;
      },
    };
  }
  const react18 =
    runtime.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.ReactCurrentDispatcher;
  if (react18) {
    return {
      get: () => react18.current,
      set: (value: unknown) => {
        react18.current = value;
      },
    };
  }
  return null;
}

// Server components run outside React here. Any hook call reports the component as unsupported
// instead of failing with React's "invalid hook call", and the component renders as server HTML,
// where React runs it with its real dispatcher.
const unsupportedHooksDispatcher = /* @__PURE__ */ new Proxy(
  {},
  {
    get(_target, name) {
      return () => {
        throw new UnsupportedNode(`calls ${String(name)}()`);
      };
    },
  },
);

function callServerComponent(
  render: (props: unknown, ref?: unknown) => unknown,
  props: unknown,
  forwardRef: boolean,
): unknown {
  const slot = getHooksDispatcherSlot();
  const previous = slot?.get();
  slot?.set(unsupportedHooksDispatcher);
  try {
    return forwardRef ? render(props, null) : render(props);
  } finally {
    slot?.set(previous);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

interface ResolveContext {
  parserSensitive: boolean;
}

interface ResolveState {
  nextId: number;
  components: Map<string, React.ComponentType<any>>;
  serverHtml: Map<number, React.ReactNode>;
  chunks: Map<number, { encoded: Promise<TreeValue>; chunk?: ResolvedChunk }>;
  /** Server actions the tree passes, by id: the server renders them as themselves. */
  actions: Map<string, unknown>;
}

function serverHtmlNode(
  state: ResolveState,
  node: React.ReactNode,
  key: React.Key | null,
  context: ResolveContext,
): TreeValue {
  if (context.parserSensitive) throw new UnsupportedInParserSensitiveElement();
  const id = state.nextId++;
  state.serverHtml.set(id, node);
  return key === null ? { $: "x", i: id } : { $: "x", i: id, k: String(key) };
}

async function resolveProps(
  state: ResolveState,
  props: Record<string, unknown>,
  context: ResolveContext,
  host: boolean,
): Promise<{ [key: string]: TreeValue }> {
  const entries = await Promise.all(
    Object.entries(props).map(async ([name, value]): Promise<[string, TreeValue] | null> => {
      // A client component's undefined prop keeps its key, as in RSC.
      if (value === undefined && host) return null;
      if (name === "ref") {
        if (value === null) return null;
        throw new UnsupportedNode("receives a ref");
      }
      if (host && typeof value === "function") {
        throw new UnsupportedNode(`passes a function to <${String(name)}>`);
      }
      return [name, await resolveValue(state, value, context, new Set())];
    }),
  );
  return Object.fromEntries(entries.filter((entry) => entry !== null));
}

async function resolveValue(
  state: ResolveState,
  value: unknown,
  context: ResolveContext,
  seen: Set<object>,
): Promise<TreeValue> {
  // Values JSON cannot hold (Date, BigInt, undefined, …) travel tagged.
  const leaf = encodeLeaf(value);
  if (leaf) return leaf as TreeValue;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : { $: "n", v: String(value) };
  }
  if (typeof value === "function") {
    // A server action passes as a reference the browser can call.
    const reference = getIslandServerHook()?.action(value);
    if (reference) {
      state.actions.set(reference.v as string, value);
      return reference as TreeValue;
    }
  }
  if (typeof value !== "object") throw new UnsupportedNode(`passes a ${typeof value} value`);
  if (React.isValidElement(value)) {
    return resolveElement(state, value as React.ReactElement<Record<string, unknown>>, context);
  }
  if (isThenable(value)) {
    try {
      return { $: "P", v: await resolveValue(state, await value, context, seen) };
    } catch (error) {
      if (error instanceof UnsupportedInParserSensitiveElement) throw error;
      throw new UnsupportedNode("passes a promise that does not resolve to a serializable value");
    }
  }
  if (seen.has(value)) throw new UnsupportedNode("passes a circular value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return await Promise.all(value.map((entry) => resolveValue(state, entry, context, seen)));
    }
    if (value instanceof Map) {
      return { $: "M", v: await resolveValue(state, Array.from(value), context, seen) };
    }
    if (value instanceof Set) {
      return { $: "S", v: await resolveValue(state, Array.from(value), context, seen) };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnsupportedNode("passes a class instance");
    }
    const entries = await Promise.all(
      Object.entries(value)
        // A key whose value is undefined stays, as `{"$":"u"}`.
        .map(
          async ([name, entry]): Promise<[string, TreeValue]> => [
            name,
            await resolveValue(state, entry, context, seen),
          ],
        ),
    );
    const object = Object.fromEntries(entries);
    return Object.prototype.hasOwnProperty.call(object, "$") ? { $: "o", v: object } : object;
  } finally {
    seen.delete(value);
  }
}

async function resolveElement(
  state: ResolveState,
  element: React.ReactElement<Record<string, unknown>>,
  context: ResolveContext,
): Promise<TreeValue> {
  const key = element.key === null || element.key === undefined ? null : String(element.key);
  const withKey = <T extends { [key: string]: TreeValue }>(node: T): T =>
    key === null ? node : { ...node, k: key };
  let type: unknown = element.type;
  const props = element.props ?? {};

  try {
    if (typeof type === "string") {
      const parserSensitive = context.parserSensitive || PARSER_SENSITIVE_TAGS.has(type);
      try {
        const { children, ...rest } = props;
        const resolved = await resolveProps(state, rest, context, true);
        if (children !== undefined) {
          resolved.children = await resolveValue(state, children, { parserSensitive }, new Set());
        }
        return withKey({ $: "h", t: type, p: resolved });
      } catch (error) {
        if (error instanceof UnsupportedInParserSensitiveElement && !context.parserSensitive) {
          return serverHtmlNode(state, element, key, context);
        }
        throw error;
      }
    }

    if (type === React.Fragment || type === React.StrictMode) {
      return withKey({
        $: "f",
        c: await resolveValue(state, props.children, context, new Set()),
      });
    }

    if (type === React.Suspense) {
      const id = state.nextId++;
      const fallback = await resolveValue(state, props.fallback, context, new Set());
      const encoded = resolveValue(state, props.children, context, new Set()).catch((error) => {
        if (error instanceof UnsupportedNode) {
          return serverHtmlNode(
            state,
            React.createElement(React.Fragment, null, props.children as React.ReactNode),
            null,
            { parserSensitive: false },
          );
        }
        throw error;
      });
      // Rendering reads the result; a rejection must not be reported before React sees it.
      encoded.catch(() => {});
      state.chunks.set(id, { encoded });
      return withKey({ $: "p", f: fallback, i: id });
    }

    const clientReference = getClientReference(type);
    if (clientReference) {
      const { children, ...rest } = props;
      const resolved = await resolveProps(state, rest, context, false);
      if (children !== undefined) {
        resolved.children = await resolveValue(state, children, context, new Set());
      }
      state.components.set(
        `${clientReference.src}#${clientReference.exportName}`,
        clientReference.Component,
      );
      return withKey({
        $: "c",
        r: clientReference.src,
        e: clientReference.exportName,
        p: resolved,
      });
    }

    let forwardRef = false;
    while (type && typeof type === "object") {
      const typeOf = (type as { $$typeof?: symbol }).$$typeof;
      if (typeOf === MEMO_TYPE) {
        type = (type as { type: unknown }).type;
        if (getClientReference(type)) {
          return resolveElement(
            state,
            React.createElement(type as React.ComponentType<any>, {
              ...props,
              key: element.key,
            }) as React.ReactElement<Record<string, unknown>>,
            context,
          );
        }
        continue;
      }
      if (typeOf === FORWARD_REF_TYPE) {
        type = (type as { render: unknown }).render;
        forwardRef = true;
        break;
      }
      throw new UnsupportedNode("is not a function component");
    }

    if (typeof type !== "function") throw new UnsupportedNode("is not a function component");
    if ((type as { prototype?: { isReactComponent?: unknown } }).prototype?.isReactComponent) {
      throw new UnsupportedNode("is a class component");
    }
    let rendered = callServerComponent(
      type as (props: unknown, ref?: unknown) => unknown,
      props,
      forwardRef,
    );
    if (isThenable(rendered)) rendered = await rendered;
    const resolved = await resolveValue(state, rendered, context, new Set());
    return key === null ? resolved : { $: "f", k: key, c: resolved };
  } catch (error) {
    if (error instanceof UnsupportedNode) return serverHtmlNode(state, element, key, context);
    throw error;
  }
}

const chunkComponents = /* @__PURE__ */ new WeakMap<
  object,
  React.ComponentType<{ chunk: ResolvedChunk }>
>();

function getChunkComponent() {
  const existing = chunkComponents.get(React.createElement);
  if (existing) return existing;
  function ServerTreeChunk({ chunk }: { chunk: ResolvedChunk }): React.ReactNode {
    if (chunk.status === "fulfilled") return chunk.value;
    if (chunk.status === "rejected") throw chunk.reason;
    return React.use(chunk.promise);
  }
  chunkComponents.set(React.createElement, ServerTreeChunk);
  return ServerTreeChunk;
}

function fulfilledThenable(value: unknown): Promise<unknown> {
  const promise = Promise.resolve(value) as Promise<unknown> & { status?: string; value?: unknown };
  // `use()` returns a settled thenable's value synchronously, so hydration does not suspend.
  promise.status = "fulfilled";
  promise.value = value;
  return promise;
}

function createTreeChildren(
  children: TreeValue | undefined,
  resolver: TreeResolver,
): React.ReactNode[] {
  if (children === undefined) return [];
  const node = createTreeValue(children, resolver);
  // Spread a static child list the way JSX does, so React does not ask for keys.
  return Array.isArray(children) ? (node as React.ReactNode[]) : [node as React.ReactNode];
}

function createTreeProps(
  props: { [key: string]: TreeValue },
  resolver: TreeResolver,
  key: TreeValue | undefined,
): { props: Record<string, unknown>; children: React.ReactNode[] } {
  const { children, ...rest } = props;
  const created: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    created[name] = createTreeValue(value, resolver);
  }
  if (typeof key === "string") created.key = key;
  return { props: created, children: createTreeChildren(children, resolver) };
}

function createTreeValue(value: TreeValue, resolver: TreeResolver): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => createTreeValue(entry, resolver));
  switch (value.$) {
    case "h": {
      const { props, children } = createTreeProps(
        value.p as { [key: string]: TreeValue },
        resolver,
        value.k,
      );
      return React.createElement(value.t as string, props, ...children);
    }
    case "c": {
      const { props, children } = createTreeProps(
        value.p as { [key: string]: TreeValue },
        resolver,
        value.k,
      );
      return React.createElement(
        resolver.component(value.r as string, value.e as string),
        props,
        ...children,
      );
    }
    case "f":
      return React.createElement(
        React.Fragment,
        typeof value.k === "string" ? { key: value.k } : null,
        ...createTreeChildren(value.c, resolver),
      );
    case "p":
      return React.createElement(
        React.Suspense,
        {
          ...(typeof value.k === "string" ? { key: value.k } : {}),
          fallback: createTreeValue(value.f as TreeValue, resolver) as React.ReactNode,
        },
        React.createElement(getChunkComponent(), {
          chunk: resolver.chunk(value.i as number),
        }),
      );
    case "x":
      return resolver.serverHtml(value.i as number, typeof value.k === "string" ? value.k : null);
    case "n":
      return Number(value.v);
    case "a":
      return resolver.action(value.v as string, typeof value.b === "string" ? value.b : undefined);
    case "P":
      return fulfilledThenable(createTreeValue(value.v as TreeValue, resolver));
    case "o": {
      const object = value.v as { [key: string]: TreeValue };
      return Object.fromEntries(
        Object.entries(object).map(([name, entry]) => [name, createTreeValue(entry, resolver)]),
      );
    }
    default: {
      if (value.$ !== undefined) {
        // A value JSON cannot hold: Date, Map, BigInt, …
        const decoded = decodeTagged(value as Record<string, unknown>, (child) =>
          createTreeValue(child as TreeValue, resolver),
        );
        if (decoded !== NOT_A_VALUE) return decoded;
      }
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, createTreeValue(entry, resolver)]),
      );
    }
  }
}

/** A payload's JSON and the island values it sends with it (islands mode), as [key, json]. */
type TreeValueScripts = ReadonlyArray<readonly [key: string, json: string]>;

function createTreeScript(
  type: string,
  name: string,
  json: string,
  values: TreeValueScripts = [],
  attributes: Record<string, string> = {},
): React.ReactElement {
  const script = React.createElement("script", {
    type,
    ...(name ? { name } : {}),
    ...attributes,
    dangerouslySetInnerHTML: { __html: json },
  });
  if (values.length === 0) return script;
  // The values right before the payload: the browser re-renders exactly these, so hydration sees
  // the markup the server sent.
  return React.createElement(
    React.Fragment,
    null,
    ...values.map(([valueKey, valueJson]) =>
      React.createElement("script", {
        key: valueKey,
        type: VALUE_SCRIPT_TYPE,
        name: valueKey,
        dangerouslySetInnerHTML: { __html: valueJson },
      }),
    ),
    script,
  );
}

function createTreePage(
  tree: TreeValue,
  json: string,
  resolver: TreeResolver,
  key?: string,
  values: TreeValueScripts = [],
): React.ReactElement {
  return React.createElement(
    React.Fragment,
    key === undefined ? null : { key },
    createTreeValue(tree, resolver) as React.ReactNode,
    createTreeScript(TREE_SCRIPT_TYPE, "", json, values),
  );
}

/** The value scripts the server sent right before a payload script. */
function readTreeValueScripts(script: Element): TreeValueScripts {
  const values: Array<readonly [string, string]> = [];
  for (
    let node = script.previousElementSibling;
    node?.tagName === "SCRIPT" && node.getAttribute("type") === VALUE_SCRIPT_TYPE;
    node = node.previousElementSibling
  ) {
    values.unshift([node.getAttribute("name") ?? "", node.textContent ?? ""]);
  }
  return values;
}

/**
 * The page as a navigation the browser renders itself receives it: its payload, every chunk's
 * payload, and the server HTML parts, with none of the HTML the payload rebuilds. Waits for every
 * chunk, since a navigation reads the whole response anyway. Returns null when a chunk failed,
 * so the page renders as usual and its error boundaries apply.
 */
async function createPayloadOnlyPage(
  state: ResolveState,
  payload: { json: string; values: TreeValueScripts },
  encode: (payload: Record<string, unknown>) => { json: string; values: TreeValueScripts },
  resolver: TreeResolver,
): Promise<React.ReactElement | null> {
  const chunks = new Map<number, TreeValue>();
  // A chunk can contain further chunks; settle until none are pending.
  for (let pending = [...state.chunks.keys()]; pending.length > 0; ) {
    const settled = await Promise.allSettled(
      pending.map(async (id) => [id, await state.chunks.get(id)!.encoded] as const),
    );
    for (const result of settled) {
      if (result.status === "rejected") return null;
      chunks.set(result.value[0], result.value[1]);
    }
    pending = [...state.chunks.keys()].filter((id) => !chunks.has(id));
  }
  return React.createElement(
    React.Fragment,
    null,
    ...Array.from(state.serverHtml.keys(), (id) => resolver.serverHtml(id, `h${id}`)),
    React.createElement(
      React.Fragment,
      { key: "payload" },
      createTreeScript(TREE_SCRIPT_TYPE, "", payload.json, payload.values, {
        [PAYLOAD_ONLY_ATTRIBUTE]: "",
      }),
    ),
    ...Array.from(chunks, ([id, encoded]) => {
      const chunk = encode({ t: encoded });
      return React.createElement(
        React.Fragment,
        { key: `c${id}` },
        createTreeScript(CHUNK_SCRIPT_TYPE, String(id), chunk.json, chunk.values),
      );
    }),
  );
}

export interface ServerTreeRenderOptions {
  /**
   * Renders a part the resolver cannot represent, as server HTML whose client components are
   * islands. Default `isolateIslands`.
   */
  isolate?(element: React.ReactNode): React.ReactNode;
  /** Value keys the browser holds (`parseHeldValues(request)`): the payload leaves them out. */
  held?: ReadonlySet<string> | null;
  /**
   * A navigation the browser renders in its layout's React root: send the payload, the chunks it
   * streams and the server HTML parts it cannot represent, without the page's rendered HTML.
   */
  payloadOnly?: boolean;
}

/**
 * Resolves a server page and returns what renders in its place: the resolved tree and its
 * payload. Errors from the page's own code (a framework's redirect or not-found) propagate
 * unchanged. Suspense children resolve concurrently and stream as React renders them.
 * Needs `@farmjs/islx/react/server` imported (large values and actions are encoded there).
 */
export async function renderServerTree(
  element: React.ReactNode,
  options: ServerTreeRenderOptions = {},
): Promise<React.ReactElement> {
  const hook = getIslandServerHook();
  if (!hook) throw new Error("islx: renderServerTree needs @farmjs/islx/react/server imported");
  const isolate = options.isolate ?? isolateIslands;
  const state: ResolveState = {
    nextId: 0,
    components: new Map(),
    serverHtml: new Map(),
    chunks: new Map(),
    actions: new Map(),
  };
  const tree = await resolveValue(state, element, { parserSensitive: false }, new Set());
  const held = options.held && options.held.size > 0 ? options.held : null;
  const encode = (payload: Record<string, unknown>): { json: string; values: TreeValueScripts } => {
    const addressed = hook.address(payload, held);
    return {
      json: hook.escape(addressed.json),
      values: addressed.values.map((value) => [value.key, hook.escape(value.json)] as const),
    };
  };
  const resolver: TreeResolver = {
    component(reference, exportName) {
      const Component = state.components.get(`${reference}#${exportName}`);
      if (!Component)
        throw new Error(`client reference ${reference}#${exportName} was not resolved`);
      return Component;
    },
    chunk(id) {
      const entry = state.chunks.get(id)!;
      if (entry.chunk) return entry.chunk;
      const chunk: ResolvedChunk = {
        status: "pending",
        promise: entry.encoded.then(
          (encoded) => {
            const payload = encode({ t: encoded });
            chunk.value = React.createElement(
              React.Fragment,
              null,
              createTreeValue(encoded, resolver) as React.ReactNode,
              createTreeScript(CHUNK_SCRIPT_TYPE, String(id), payload.json, payload.values),
            );
            chunk.status = "fulfilled";
            return chunk.value;
          },
          (error) => {
            chunk.status = "rejected";
            chunk.reason = error;
            throw error;
          },
        ),
      };
      chunk.promise.catch(() => {});
      entry.chunk = chunk;
      return chunk;
    },
    serverHtml(id, key) {
      return React.createElement(
        SERVER_HTML_TAG,
        {
          ...(key === null ? {} : { key }),
          [SERVER_HTML_ATTRIBUTE]: String(id),
          style: { display: "contents" },
        },
        isolate(state.serverHtml.get(id) as React.ReactNode),
      );
    },
    action(id) {
      return state.actions.get(id);
    },
  };
  const payload = encode({ v: 1, t: tree });
  const page =
    (options.payloadOnly && (await createPayloadOnlyPage(state, payload, encode, resolver))) ||
    createTreePage(tree, payload.json, resolver, undefined, payload.values);
  // The browser renders the page through ServerTreePage; the server renders the same layer.
  return React.createElement(function ServerTreePage() {
    return page;
  });
}

function collectReferences(value: TreeValue, references: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, references);
    return;
  }
  if (value.$ === "c") references.add(`${value.r as string}#${value.e as string}`);
  for (const entry of Object.values(value)) collectReferences(entry, references);
}

// Hot updates reach mounted server trees. Shared through globalThis, so a tree and the island
// runtime see one registry even when the bundler gives them separate copies of this module.
type TreeUpdateListener = (src: string, module: Record<string, unknown>) => boolean;
const TREE_UPDATES = Symbol.for("islx.react.tree-updates");

function treeListeners(): Set<TreeUpdateListener> {
  const scope = globalThis as typeof globalThis &
    Record<symbol, Set<TreeUpdateListener> | undefined>;
  return (scope[TREE_UPDATES] ??= new Set());
}

/** Re-renders mounted server trees that render a hot-updated client module. */
export function updateServerTrees(src: string, module: Record<string, unknown>): number {
  let updated = 0;
  for (const listener of treeListeners()) if (listener(src, module)) updated++;
  return updated;
}

export interface ServerTreeElementOptions {
  /** Imports a client module, as the hydration runtime's `load`. */
  load(src: string): Promise<Record<string, unknown>>;
  /**
   * Renders an `<f-html>` part from its server HTML and hydrates its islands:
   * `createServerHtml(runtime)`.
   */
  ServerHtml: React.ComponentType<any>;
  /** Remounts the page's client components when it changes, as a navigation does. */
  key?: string;
  /** The value store. Default: the page's. */
  values?: Pick<ValueStore, "ingest" | "resolve">;
}

function parseHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function exportOf(module: Record<string, unknown>, src: string, exportName: string) {
  const Component = module[exportName];
  if (typeof Component !== "function" && (typeof Component !== "object" || Component === null)) {
    throw new Error(`${src} has no export ${exportName}`);
  }
  return Component as React.ComponentType<any>;
}

/**
 * Rebuilds a server-tree page in the browser from its server HTML (an element, or the HTML of a
 * navigation), after loading its client modules. Returns null for a page without a tree.
 */
export async function createServerTreeElement(
  source: ParentNode | string,
  options: ServerTreeElementOptions,
): Promise<React.ReactElement | null> {
  const values = options.values ?? getValueStore();
  const root = typeof source === "string" ? parseHtml(source) : source;
  const script = root.querySelector<HTMLScriptElement>(`script[type="${TREE_SCRIPT_TYPE}"]`);
  if (!script) return null;
  const json = script.textContent ?? "";
  // A payload that names values reads them from the page (or this navigation's HTML) and from
  // the values the browser already holds.
  let ingested = false;
  const parsePayload = (text: string): unknown => {
    const parsed = JSON.parse(text);
    if (!text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) return parsed;
    if (!ingested) {
      values.ingest(root);
      ingested = true;
    }
    return values.resolve(parsed);
  };
  const payload = parsePayload(json) as { v?: number; t: TreeValue };
  if (payload.v !== 1) throw new Error("unsupported server tree payload version");
  const scripts = readTreeValueScripts(script);

  const chunks = new Map<number, { tree: TreeValue; json: string; values: TreeValueScripts }>();
  for (const chunkScript of root.querySelectorAll<HTMLScriptElement>(
    `script[type="${CHUNK_SCRIPT_TYPE}"]`,
  )) {
    const chunkJson = chunkScript.textContent ?? "";
    chunks.set(Number(chunkScript.getAttribute("name")), {
      tree: (parsePayload(chunkJson) as { t: TreeValue }).t,
      json: chunkJson,
      values: readTreeValueScripts(chunkScript),
    });
  }

  const references = new Set<string>();
  collectReferences(payload.t, references);
  for (const chunk of chunks.values()) collectReferences(chunk.tree, references);
  const components = new Map<string, React.ComponentType<any>>();
  await Promise.all(
    Array.from(references, async (key) => {
      const separator = key.lastIndexOf("#");
      const src = key.slice(0, separator);
      components.set(key, exportOf(await options.load(src), src, key.slice(separator + 1)));
    }),
  );

  const serverHtml = new Map<number, string>();
  for (const container of root.querySelectorAll(`${SERVER_HTML_TAG}[${SERVER_HTML_ATTRIBUTE}]`)) {
    serverHtml.set(Number(container.getAttribute(SERVER_HTML_ATTRIBUTE)), container.innerHTML);
  }

  const resolver: TreeResolver = {
    component(reference, exportName) {
      const Component = components.get(`${reference}#${exportName}`);
      if (!Component) throw new Error(`client reference ${reference}#${exportName} was not loaded`);
      return Component;
    },
    chunk(id) {
      const chunk = chunks.get(id);
      if (!chunk) throw new Error(`server tree chunk ${id} was not found`);
      const value = React.createElement(
        React.Fragment,
        null,
        createTreeValue(chunk.tree, resolver) as React.ReactNode,
        createTreeScript(CHUNK_SCRIPT_TYPE, String(id), chunk.json, chunk.values),
      );
      return { status: "fulfilled", value, promise: Promise.resolve(value) };
    },
    serverHtml(id, key) {
      const html = serverHtml.get(id);
      if (html === undefined) throw new Error(`server HTML ${id} was not found`);
      return React.createElement(options.ServerHtml, {
        ...(key === null ? {} : { key }),
        as: SERVER_HTML_TAG,
        [SERVER_HTML_ATTRIBUTE]: String(id),
        style: { display: "contents" },
        suppressHydrationWarning: true,
        dangerouslySetInnerHTML: { __html: html },
      });
    },
    action(id, sealed) {
      return createServerReference(id, sealed);
    },
  };

  // Validate the whole tree now, so a missing chunk or module falls back before hydration starts.
  const build = () => createTreePage(payload.t, json, resolver, undefined, scripts);
  build();

  function ServerTreePage(): React.ReactNode {
    const [, setVersion] = React.useState(0);
    React.useEffect(() => {
      const listener: TreeUpdateListener = (src, module) => {
        let changed = false;
        for (const key of components.keys()) {
          const separator = key.lastIndexOf("#");
          if (key.slice(0, separator) !== src) continue;
          components.set(key, exportOf(module, src, key.slice(separator + 1)));
          changed = true;
        }
        if (changed) setVersion((version) => version + 1);
        return changed;
      };
      const listeners = treeListeners();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }, []);
    return build();
  }

  return React.createElement(
    ServerTreePage,
    options.key === undefined ? null : { key: options.key },
  );
}
