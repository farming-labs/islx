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
 * an unknown element type) renders as server HTML inside `<f-html>`, whose own client components
 * hydrate as islands. A client component whose props cannot be sent fails the render there, as
 * under React Server Components.
 */
import * as React from "react";
import { NOT_A_VALUE, decodeTagged, encodeLeaf } from "../protocol/codec";
import {
  CHUNK_SCRIPT_TYPE,
  HTML_ELEMENT,
  HTML_TEMPLATE_ELEMENT,
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
/**
 * On a host element inside a server tree whose children are plain HTML: the payload leaves its
 * children out, and the browser renders the element with the HTML it already shows (or the HTML a
 * client component's template keeps). The value names it like an `<f-html>` part.
 */
const STATIC_HTML_ATTRIBUTE = HTML_ELEMENT;
/**
 * Children whose JSON is shorter than this stay in the payload: the attribute that names a static
 * element costs about as much.
 */
const STATIC_HTML_MIN_JSON = 64;
// Elements whose subtree never becomes static HTML: their state lives in the DOM or React reads
// their content (forms and their fields, media), the parser treats them specially, or they load
// something when created.
const DYNAMIC_HTML_TAGS = /* @__PURE__ */ new Set([
  "audio",
  "button",
  "canvas",
  "details",
  "dialog",
  "embed",
  "form",
  "iframe",
  "img",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "picture",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "video",
]);
const OUTLET = Symbol.for("islx.react.outlet");

/**
 * Where a layout rendered as a server tree places the page (or another outlet, by `name`). The
 * tree records the outlet, and the server and the browser render what they are given there.
 */
export function Outlet(_props: { name?: string }): null {
  return null;
}
(Outlet as unknown as { [OUTLET]: true })[OUTLET] = true;

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
  /**
   * After a client component: the server HTML parts `ids` its props carry that it did not render
   * (a closed folder's icon), in a template the browser reads them from when it renders them.
   */
  unrendered(ids: number[]): React.ReactNode;
  /** A layout tree's outlet: where the layout renders the page, or another outlet by name. */
  outlet(name: string): React.ReactNode;
  /** The function a server action reference stands for. */
  action(id: string, sealed: string | undefined): unknown;
  /**
   * A host element whose children are static HTML (`s` on an `h` node): the server renders them,
   * and the browser renders the element with the HTML the page shows for it.
   */
  staticHtml?(id: number, type: string, props: Record<string, unknown>): React.ReactElement;
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

/**
 * A host element whose children are static HTML: its tag, its other props and its children, as
 * resolved values or, for children made only of host elements and text, as they were rendered.
 */
type StaticHtml =
  | { type: string; props: { [key: string]: TreeValue }; children: TreeValue; source?: never }
  | { type: string; props: { [key: string]: TreeValue }; source: unknown; children?: never };

const hostSizes = /* @__PURE__ */ new WeakMap<object, number | null>();

/** An attribute value React renders as it is: text, a finite number, or a `style` object of them. */
function plainAttributeSize(value: unknown): number | null {
  if (value === null || typeof value === "boolean") return 5;
  if (typeof value === "string") return value.length + 2;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : null;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
  let size = 2;
  for (const [name, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry === "object") return null;
    const entrySize = plainAttributeSize(entry);
    if (entrySize === null) return null;
    size += name.length + entrySize + 4;
  }
  return size;
}

/**
 * The JSON length of a node's tree when it holds only host elements, fragments and text that React
 * renders as they are (no components, functions or tagged values), or null. The resolver leaves
 * such children unresolved: the server renders them as they came.
 */
function plainHostSize(node: unknown): number | null {
  if (node === null || node === undefined || typeof node === "boolean") return 5;
  if (typeof node === "string") return node.length + 2;
  if (typeof node === "number") return Number.isFinite(node) ? String(node).length : null;
  if (Array.isArray(node)) {
    let size = node.length + 1;
    for (const entry of node) {
      const entrySize = plainHostSize(entry);
      if (entrySize === null) return null;
      size += entrySize;
    }
    return size;
  }
  if (!React.isValidElement(node)) return null;
  const known = hostSizes.get(node);
  if (known !== undefined) return known;
  let size: number | null = null;
  const type = node.type;
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (type === React.Fragment) {
    size = plainHostSize(props.children);
    if (size !== null) size += 12;
  } else if (typeof type === "string" && !DYNAMIC_HTML_TAGS.has(type)) {
    size = type.length + 30;
    for (const [name, value] of Object.entries(props)) {
      if (value === undefined || (name === "ref" && value === null)) continue;
      const valueSize =
        name === "children"
          ? plainHostSize(value)
          : name === "ref" || typeof value === "function"
            ? null
            : plainAttributeSize(value);
      if (valueSize === null) {
        size = null;
        break;
      }
      size += name.length + valueSize + 4;
    }
  }
  hostSizes.set(node, size);
  return size;
}

interface ResolveContext {
  parserSensitive: boolean;
  /** Inside a client component's prop other than `children`, which it may read rather than render. */
  elementProp?: true;
}

interface ResolveState {
  nextId: number;
  components: Map<string, React.ComponentType<any>>;
  serverHtml: Map<number, React.ReactNode>;
  chunks: Map<number, { encoded: Promise<TreeValue>; chunk?: ResolvedChunk }>;
  /** Server actions the tree passes, by id: the server renders them as themselves. */
  actions: Map<string, unknown>;
  /**
   * The children of host elements whose children are static HTML, by id, when this tree leaves
   * them out of its payload: a render whose HTML reaches the browser (not a `partial` navigation).
   */
  staticHtml?: Map<number, StaticHtml>;
  /**
   * Whether a client component receives a server HTML part as a prop, which it may clone with
   * props of its own (`asChild`, `render`): only rendering that component shows the part then.
   */
  clonableParts?: true;
}

function isServerHtmlPart(value: TreeValue): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.$ === "x";
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

/**
 * Resolved host elements and fragments that are plain HTML (nothing to rebuild), with the JSON
 * length of their node once any static element inside is inlined. Children resolve before their
 * parent, so each node is classified once from its children's entries.
 */
const staticSizes = /* @__PURE__ */ new WeakMap<object, number>();

/** The JSON length of a resolved value that is plain HTML, or null when it holds anything else. */
function staticSize(value: TreeValue): number | null {
  if (value === null || typeof value !== "object") return JSON.stringify(value).length;
  if (Array.isArray(value)) {
    let size = value.length + 1;
    for (const entry of value) {
      const entrySize = staticSize(entry);
      if (entrySize === null) return null;
      size += entrySize;
    }
    return size;
  }
  return staticSizes.get(value) ?? null;
}

/** Records a fragment as plain HTML when its children are. */
function classifyStaticFragment(state: ResolveState, node: { [key: string]: TreeValue }) {
  if (!state.staticHtml) return node;
  const childrenSize = staticSize(node.c as TreeValue);
  if (childrenSize !== null) {
    const { c: _children, ...rest } = node;
    staticSizes.set(node, JSON.stringify(rest).length + 5 + childrenSize);
  }
  return node;
}

/** Data an attribute renders from as it is (a `style` object, a string): nothing tagged. */
function isPlainData(value: TreeValue): boolean {
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(isPlainData);
  return !("$" in value) && Object.values(value).every(isPlainData);
}

/**
 * `value` with the static elements directly in it (through arrays and fragments) given their
 * children back, so only the outermost element is static. Deeper ones are inlined already: a
 * static element that is not itself one holds less than `STATIC_HTML_MIN_JSON`, so none inside.
 */
function inlineStaticHtml(staticHtml: Map<number, StaticHtml>, value: TreeValue): TreeValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => inlineStaticHtml(staticHtml, entry));
  if (value.$ === "f") return { ...value, c: inlineStaticHtml(staticHtml, value.c as TreeValue) };
  if (typeof value.s !== "number") return value;
  const { s: id, ...element } = value;
  // Only resolved entries are inlined: an element whose children stayed unresolved is not recorded
  // as static HTML, so its parent never inlines it.
  const children = staticHtml.get(id)!.children as TreeValue;
  staticHtml.delete(id);
  return { ...element, p: { ...(value.p as { [key: string]: TreeValue }), children } };
}

/**
 * Records a resolved host element as plain HTML when it is one, and returns the id under which its
 * children stay out of the payload, or null when they stay in: they hold anything to rebuild,
 * React manages the element's content, the parser treats it specially, or they are too small to be
 * worth the attribute that names them.
 */
function staticHtmlId(
  state: ResolveState,
  type: string,
  resolved: { [key: string]: TreeValue },
  stub: boolean,
): { size: number; id: number | null } | null {
  const staticHtml = state.staticHtml;
  if (!staticHtml || DYNAMIC_HTML_TAGS.has(type)) return null;
  const { children, ...props } = resolved;
  for (const prop of Object.values(props)) if (!isPlainData(prop)) return null;
  const childrenSize = children === undefined ? 0 : staticSize(children);
  if (childrenSize === null) return null;
  // The node's JSON: `{"$":"h","t":…,"p":{…,"children":…}}`, near enough for a threshold.
  const size = JSON.stringify(props).length + type.length + 30 + childrenSize;
  if (!stub || children === undefined || "dangerouslySetInnerHTML" in resolved) {
    return { size, id: null };
  }
  if (childrenSize < STATIC_HTML_MIN_JSON) return { size, id: null };
  const id = state.nextId++;
  staticHtml.set(id, { type, props, children: inlineStaticHtml(staticHtml, children) });
  return { size, id };
}

/**
 * A resolved value, or a promise of it while something in the subtree is async (an async
 * component, a promise prop). Synchronous subtrees resolve without a microtask per node.
 */
type MaybePromise<T> = T | Promise<T>;

function after<T, R>(value: MaybePromise<T>, next: (value: T) => MaybePromise<R>): MaybePromise<R> {
  return value instanceof Promise ? value.then(next) : next(value);
}

/** Runs `run`, passing its synchronous throw or its rejection to `onError`. */
function recover<T>(
  run: () => MaybePromise<T>,
  onError: (error: unknown) => MaybePromise<T>,
): MaybePromise<T> {
  let result: MaybePromise<T>;
  try {
    result = run();
  } catch (error) {
    return onError(error);
  }
  return result instanceof Promise ? result.catch(onError) : result;
}

/** `resolve` over `items`, started together like `Promise.all(items.map(resolve))`. */
function resolveAll<T>(
  items: readonly T[],
  resolve: (item: T) => MaybePromise<TreeValue>,
): MaybePromise<TreeValue[]> {
  const values: MaybePromise<TreeValue>[] = [];
  let pending = false;
  try {
    for (const item of items) {
      const value = resolve(item);
      if (value instanceof Promise) pending = true;
      values.push(value);
    }
  } catch (error) {
    // The entries already started settle unobserved: their rejection is not the one reported.
    for (const value of values) if (value instanceof Promise) value.catch(() => {});
    throw error;
  }
  return pending ? Promise.all(values) : (values as TreeValue[]);
}

function resolveProps(
  state: ResolveState,
  props: Record<string, unknown>,
  context: ResolveContext,
  host: boolean,
): MaybePromise<{ [key: string]: TreeValue }> {
  const entries = Object.entries(props).filter(([name, value]) => {
    // A client component's undefined prop keeps its key, as in RSC.
    if (value === undefined && host) return false;
    if (name === "ref") {
      if (value === null) return false;
      throw new UnsupportedNode("receives a ref");
    }
    if (host && typeof value === "function") {
      throw new UnsupportedNode(`passes a function to <${String(name)}>`);
    }
    return true;
  });
  return after(
    resolveAll(entries, ([, value]) => resolveValue(state, value, context, new Set())),
    (values) => Object.fromEntries(entries.map(([name], index) => [name, values[index]!])),
  );
}

async function resolveThenable(
  state: ResolveState,
  value: PromiseLike<unknown>,
  context: ResolveContext,
  seen: Set<object>,
): Promise<TreeValue> {
  try {
    return { $: "P", v: await resolveValue(state, await value, context, seen) };
  } catch (error) {
    if (error instanceof UnsupportedInParserSensitiveElement) throw error;
    throw new UnsupportedNode("passes a promise that does not resolve to a serializable value");
  }
}

function resolveValue(
  state: ResolveState,
  value: unknown,
  context: ResolveContext,
  seen: Set<object>,
): MaybePromise<TreeValue> {
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
  if (isThenable(value)) return resolveThenable(state, value, context, seen);
  if (seen.has(value)) throw new UnsupportedNode("passes a circular value");
  seen.add(value);
  let result: MaybePromise<TreeValue>;
  try {
    result = resolveContainer(state, value, context, seen);
  } catch (error) {
    seen.delete(value);
    throw error;
  }
  if (result instanceof Promise) return result.finally(() => seen.delete(value));
  seen.delete(value);
  return result;
}

/** An array, Map, Set or plain object, entry by entry. */
function resolveContainer(
  state: ResolveState,
  value: object,
  context: ResolveContext,
  seen: Set<object>,
): MaybePromise<TreeValue> {
  if (Array.isArray(value)) {
    return resolveAll(value, (entry) => resolveValue(state, entry, context, seen));
  }
  if (value instanceof Map) {
    return after(resolveValue(state, Array.from(value), context, seen), (v) => ({ $: "M", v }));
  }
  if (value instanceof Set) {
    return after(resolveValue(state, Array.from(value), context, seen), (v) => ({ $: "S", v }));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsupportedNode("passes a class instance");
  }
  // A key whose value is undefined stays, as `{"$":"u"}`.
  const entries = Object.entries(value);
  return after(
    resolveAll(entries, ([, entry]) => resolveValue(state, entry, context, seen)),
    (values): TreeValue => {
      const object = Object.fromEntries(entries.map(([name], index) => [name, values[index]!]));
      return Object.prototype.hasOwnProperty.call(object, "$") ? { $: "o", v: object } : object;
    },
  );
}

function resolveElement(
  state: ResolveState,
  element: React.ReactElement<Record<string, unknown>>,
  context: ResolveContext,
): MaybePromise<TreeValue> {
  const key = element.key === null || element.key === undefined ? null : String(element.key);
  return recover(
    () => resolveElementType(state, element, key, context),
    (error) => {
      if (error instanceof UnsupportedNode) return serverHtmlNode(state, element, key, context);
      throw error;
    },
  );
}

function resolveElementType(
  state: ResolveState,
  element: React.ReactElement<Record<string, unknown>>,
  key: string | null,
  context: ResolveContext,
): MaybePromise<TreeValue> {
  const withKey = <T extends { [key: string]: TreeValue }>(node: T): T =>
    key === null ? node : { ...node, k: key };
  let type: unknown = element.type;
  const props = element.props ?? {};

  if (typeof type === "string") {
    const tag = type;
    const parserSensitive = context.parserSensitive || PARSER_SENSITIVE_TAGS.has(tag);
    const hostNode = (resolved: { [key: string]: TreeValue }): TreeValue => {
      const html = context.elementProp
        ? null
        : staticHtmlId(state, tag, resolved, !parserSensitive);
      const node =
        html?.id == null
          ? withKey({ $: "h", t: tag, p: resolved })
          : withKey({ $: "h", t: tag, p: state.staticHtml!.get(html.id)!.props, s: html.id });
      if (html) staticSizes.set(node, html.size);
      return node;
    };
    // Children made only of host elements and text stay as they are: the server renders them,
    // and the payload names the element (as `hostNode` would decide, without resolving them).
    const plainChildren =
      state.staticHtml &&
      !parserSensitive &&
      !context.elementProp &&
      !DYNAMIC_HTML_TAGS.has(tag) &&
      props.children !== undefined &&
      !("dangerouslySetInnerHTML" in props)
        ? plainHostSize(props.children)
        : null;
    return recover(
      () => {
        const { children, ...rest } = props;
        return after(resolveProps(state, rest, context, true), (resolved) => {
          if (children === undefined) return hostNode(resolved);
          if (
            plainChildren !== null &&
            plainChildren >= STATIC_HTML_MIN_JSON &&
            Object.values(resolved).every(isPlainData)
          ) {
            const id = state.nextId++;
            state.staticHtml!.set(id, { type: tag, props: resolved, source: children });
            return withKey({ $: "h", t: tag, p: resolved, s: id });
          }
          const childContext: ResolveContext = context.elementProp
            ? { parserSensitive, elementProp: true }
            : { parserSensitive };
          return after(resolveValue(state, children, childContext, new Set()), (value) => {
            resolved.children = value;
            return hostNode(resolved);
          });
        });
      },
      (error) => {
        if (error instanceof UnsupportedInParserSensitiveElement && !context.parserSensitive) {
          return serverHtmlNode(state, element, key, context);
        }
        throw error;
      },
    );
  }

  if (type === React.Fragment || type === React.StrictMode) {
    return after(resolveValue(state, props.children, context, new Set()), (c) =>
      classifyStaticFragment(state, withKey({ $: "f", c })),
    );
  }

  if (type === React.Suspense) {
    const id = state.nextId++;
    return after(resolveValue(state, props.fallback, context, new Set()), (fallback) => {
      const encoded = new Promise<TreeValue>((resolve) =>
        resolve(resolveValue(state, props.children, context, new Set())),
      ).catch((error) => {
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
    });
  }

  if (typeof type === "function" && (type as { [OUTLET]?: true })[OUTLET]) {
    return withKey({ $: "L", n: String(props.name ?? "children") });
  }

  const clientReference = getClientReference(type);
  if (clientReference) {
    const { children, ...rest } = props;
    const clientNode = (resolved: { [key: string]: TreeValue }): TreeValue => {
      if (Object.values(resolved).some(isServerHtmlPart)) state.clonableParts = true;
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
    };
    return after(
      resolveProps(state, rest, { ...context, elementProp: true }, false),
      (resolved) => {
        if (children === undefined) return clientNode(resolved);
        return after(resolveValue(state, children, context, new Set()), (value) => {
          resolved.children = value;
          return clientNode(resolved);
        });
      },
    );
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
  const rendered = callServerComponent(
    type as (props: unknown, ref?: unknown) => unknown,
    props,
    forwardRef,
  );
  return after(isThenable(rendered) ? Promise.resolve(rendered) : rendered, (value) =>
    after(resolveValue(state, value, context, new Set()), (resolved) =>
      key === null ? resolved : classifyStaticFragment(state, { $: "f", k: key, c: resolved }),
    ),
  );
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
  inClient: boolean,
): React.ReactNode[] {
  if (children === undefined) return [];
  const node = createTreeValue(children, resolver, inClient);
  // Spread a static child list the way JSX does, so React does not ask for keys.
  return Array.isArray(children) ? (node as React.ReactNode[]) : [node as React.ReactNode];
}

function createTreeProps(
  props: { [key: string]: TreeValue },
  resolver: TreeResolver,
  key: TreeValue | undefined,
  inClient: boolean,
): { props: Record<string, unknown>; children: React.ReactNode[] } {
  const { children, ...rest } = props;
  const created: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    created[name] = createTreeValue(value, resolver, inClient);
  }
  if (typeof key === "string") created.key = key;
  return { props: created, children: createTreeChildren(children, resolver, inClient) };
}

/** The server HTML parts and static elements in `value`, in tree order. */
function collectServerHtml(value: TreeValue, ids: number[]): number[] {
  if (value === null || typeof value !== "object") return ids;
  if (Array.isArray(value)) {
    for (const entry of value) collectServerHtml(entry, ids);
    return ids;
  }
  if (value.$ === "x") {
    ids.push(value.i as number);
    return ids;
  }
  if (value.$ === "h" && typeof value.s === "number") ids.push(value.s);
  const object = value.$ === "o" ? (value.v as { [key: string]: TreeValue }) : value;
  for (const entry of Object.values(object)) collectServerHtml(entry, ids);
  return ids;
}

/**
 * `inClient`: inside a client component's props, whose server HTML parts the outermost client
 * component's template keeps when they do not render.
 */
function createTreeValue(value: TreeValue, resolver: TreeResolver, inClient = false): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => createTreeValue(entry, resolver, inClient));
  switch (value.$) {
    case "h": {
      const { props, children } = createTreeProps(
        value.p as { [key: string]: TreeValue },
        resolver,
        value.k,
        inClient,
      );
      if (typeof value.s === "number") {
        if (!resolver.staticHtml)
          throw new Error("islx: static HTML outside a page or layout tree");
        return resolver.staticHtml(value.s, value.t as string, props);
      }
      return React.createElement(value.t as string, props, ...children);
    }
    case "c": {
      const ids = inClient ? [] : collectServerHtml(value.p as TreeValue, []);
      const { props, children } = createTreeProps(
        value.p as { [key: string]: TreeValue },
        resolver,
        ids.length > 0 ? undefined : value.k,
        true,
      );
      const element = React.createElement(
        resolver.component(value.r as string, value.e as string),
        props,
        ...children,
      );
      if (ids.length === 0) return element;
      return React.createElement(
        React.Fragment,
        typeof value.k === "string" ? { key: value.k } : null,
        element,
        resolver.unrendered(ids),
      );
    }
    case "f":
      return React.createElement(
        React.Fragment,
        typeof value.k === "string" ? { key: value.k } : null,
        ...createTreeChildren(value.c, resolver, inClient),
      );
    case "p":
      return React.createElement(
        React.Suspense,
        {
          ...(typeof value.k === "string" ? { key: value.k } : {}),
          fallback: createTreeValue(value.f as TreeValue, resolver, inClient) as React.ReactNode,
        },
        React.createElement(getChunkComponent(), {
          chunk: resolver.chunk(value.i as number),
        }),
      );
    case "x":
      return resolver.serverHtml(value.i as number, typeof value.k === "string" ? value.k : null);
    case "L":
      return resolver.outlet(value.n as string);
    case "n":
      return Number(value.v);
    case "a":
      return resolver.action(value.v as string, typeof value.b === "string" ? value.b : undefined);
    case "P":
      return fulfilledThenable(createTreeValue(value.v as TreeValue, resolver, inClient));
    case "o": {
      const object = value.v as { [key: string]: TreeValue };
      return Object.fromEntries(
        Object.entries(object).map(([name, entry]) => [
          name,
          createTreeValue(entry, resolver, inClient),
        ]),
      );
    }
    default: {
      if (value.$ !== undefined) {
        // A value JSON cannot hold: Date, Map, BigInt, …
        const decoded = decodeTagged(value as Record<string, unknown>, (child) =>
          createTreeValue(child as TreeValue, resolver, inClient),
        );
        if (decoded !== NOT_A_VALUE) return decoded;
      }
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [
          name,
          createTreeValue(entry, resolver, inClient),
        ]),
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
 * so the page renders as usual and its error boundaries apply, and when a client component
 * receives a server HTML part as a prop, which only rendering that component shows.
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
  if (state.clonableParts) return null;
  // Static elements arrive as HTML, which is smaller than their tree, in a template the browser
  // reads them from.
  const staticHtml = state.staticHtml;
  const staticElements =
    staticHtml && staticHtml.size > 0
      ? React.createElement(
          HTML_TEMPLATE_ELEMENT,
          { key: "static", [STATIC_HTML_ATTRIBUTE]: "" },
          Array.from(staticHtml, ([id, element]) =>
            resolver.staticHtml!(id, element.type, {
              ...createTreeProps(element.props, resolver, undefined, false).props,
              key: `s${id}`,
            }),
          ),
        )
      : null;
  return React.createElement(
    React.Fragment,
    null,
    staticElements,
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
  /**
   * A layout rendered as a server tree: what each `<Outlet>` renders, by name. The payload script
   * then sits at the `children` outlet, inside the layout's markup, so a layout that renders the
   * whole document keeps it in the body.
   */
  outlets?: Record<string, React.ReactNode>;
  /**
   * Names this tree's payload, chunks and server HTML parts, so a layout's tree and the trees at
   * its outlet do not read each other's. A page's tree has none.
   */
  scope?: string;
}

/** The name of a tree part: its number, after the tree's scope. */
function scopedName(scope: string | undefined, id: number): string {
  return scope ? `${scope}:${id}` : String(id);
}

/**
 * A server HTML part in the browser. A client component that clones the part (`asChild`, `render`)
 * gives its props to this component, so they never reach the part's `<f-html>`: the server already
 * rendered them into its HTML.
 */
function ServerHtmlPart({ element }: { element: React.ReactElement }): React.ReactNode {
  return element;
}

// Renders after its client component, so the parts that component rendered are known by then; a
// part rendered later, by a part of it that suspended first, renders in both places.
function UnrenderedServerHtml({
  ids,
  rendered,
  scope,
  part,
}: {
  ids: number[];
  rendered: Set<number>;
  scope: string | undefined;
  part(id: number, key: string): React.ReactElement;
}): React.ReactNode {
  const unrendered = ids.filter((id) => !rendered.has(id));
  if (unrendered.length === 0) return null;
  return React.createElement(
    HTML_TEMPLATE_ELEMENT,
    { [SERVER_HTML_ATTRIBUTE]: scopedName(scope, unrendered[0]!) },
    unrendered.map((id) => part(id, `h${id}`)),
  );
}

/** A server resolver's `<f-html>` parts, and the templates of the ones client components skip. */
/** A static element's children to render on the server: as they came, or rebuilt from the tree. */
function staticChildren(entry: StaticHtml, resolver: TreeResolver): React.ReactNode[] {
  if (entry.source !== undefined) return [entry.source as React.ReactNode];
  return createTreeChildren(entry.children!, resolver, false);
}

function createServerHtmlParts(
  state: ResolveState,
  scope: string | undefined,
  isolate: (element: React.ReactNode) => React.ReactNode,
  resolver: () => TreeResolver,
): Pick<TreeResolver, "serverHtml" | "unrendered" | "staticHtml"> {
  const rendered = new Set<number>();
  // A static element renders its children with a marker before them, so the template after its
  // client component knows whether it rendered.
  const staticElement = (
    id: number,
    type: string,
    props: Record<string, unknown>,
  ): React.ReactElement =>
    React.createElement(
      type,
      { ...props, [STATIC_HTML_ATTRIBUTE]: scopedName(scope, id) },
      React.createElement(RenderedStaticHtml, { id, rendered }),
      ...staticChildren(state.staticHtml!.get(id)!, resolver()),
    );
  const part = (
    id: number,
    key: string | null,
    props?: Record<string, unknown>,
  ): React.ReactElement => {
    const unrenderedStatic = state.staticHtml?.get(id);
    if (unrenderedStatic) {
      const attributes = createTreeProps(
        unrenderedStatic.props,
        resolver(),
        undefined,
        false,
      ).props;
      return staticElement(
        id,
        unrenderedStatic.type,
        key === null ? attributes : { ...attributes, key },
      );
    }
    const node = state.serverHtml.get(id) as React.ReactNode;
    return React.createElement(
      SERVER_HTML_TAG,
      {
        ...(key === null ? {} : { key }),
        [SERVER_HTML_ATTRIBUTE]: scopedName(scope, id),
        style: { display: "contents" },
      },
      isolate(props && React.isValidElement(node) ? React.cloneElement(node, props) : node),
    );
  };
  // Each part renders through a component of its own that carries the props of the element it
  // stands for. A client component that clones the part merges its props with that element's, as
  // it would without the part, and the element renders with the result.
  const components = new Map<number, React.FunctionComponent<Record<string, unknown>>>();
  const component = (id: number) => {
    let Part = components.get(id);
    if (!Part) {
      Part = (props) => {
        rendered.add(id);
        return part(id, null, props);
      };
      components.set(id, Part);
    }
    return Part;
  };
  return {
    serverHtml: (id, key) => {
      const node = state.serverHtml.get(id);
      return React.createElement(component(id), {
        ...(React.isValidElement(node) ? (node.props as Record<string, unknown>) : {}),
        ...(key === null ? {} : { key }),
      });
    },
    unrendered: (ids) => React.createElement(UnrenderedServerHtml, { ids, rendered, scope, part }),
    staticHtml: state.staticHtml ? staticElement : undefined,
  };
}

function RenderedStaticHtml({ id, rendered }: { id: number; rendered: Set<number> }): null {
  rendered.add(id);
  return null;
}

function hasChildrenOutlet(value: TreeValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasChildrenOutlet);
  if (value.$ === "L") return value.n === "children";
  return Object.values(value).some(hasChildrenOutlet);
}

/** What renders at a layout's outlet: its content, after the layout's payload at `children`. */
function outletContent(
  outlets: Record<string, React.ReactNode> | undefined,
  name: string,
  script: React.ReactElement | null | undefined,
): React.ReactNode {
  const content = outlets?.[name] ?? null;
  if (name !== "children" || !script) return content;
  return React.createElement(React.Fragment, null, script, content);
}

/**
 * Resolves a server page and returns what renders in its place: the resolved tree and its
 * payload. Errors from the page's own code (a framework's redirect or not-found) propagate
 * unchanged. Suspense children resolve concurrently and stream as React renders them.
 * Needs `@farm.js/islx/react/server` imported (large values and actions are encoded there).
 */
export async function renderServerTree(
  element: React.ReactNode,
  options: ServerTreeRenderOptions = {},
): Promise<React.ReactElement> {
  const hook = getIslandServerHook();
  if (!hook) throw new Error("islx: renderServerTree needs @farm.js/islx/react/server imported");
  const isolate = options.isolate ?? isolateIslands;
  const state: ResolveState = {
    nextId: 0,
    components: new Map(),
    serverHtml: new Map(),
    chunks: new Map(),
    actions: new Map(),
    staticHtml: new Map(),
  };
  const scope = options.scope;
  const tree = await resolveValue(state, element, { parserSensitive: false }, new Set());
  const held = options.held && options.held.size > 0 ? options.held : null;
  const encode = (payload: Record<string, unknown>): { json: string; values: TreeValueScripts } => {
    const addressed = hook.address(payload, held);
    return {
      json: hook.escape(addressed.json),
      values: addressed.values.map((value) => [value.key, hook.escape(value.json)] as const),
    };
  };
  // A layout tree's payload script, rendered at its `children` outlet.
  let layoutScript: React.ReactElement | null = null;
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
              createTreeScript(
                CHUNK_SCRIPT_TYPE,
                scopedName(scope, id),
                payload.json,
                payload.values,
              ),
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
    ...createServerHtmlParts(state, scope, isolate, () => resolver),
    outlet(name) {
      return outletContent(options.outlets, name, layoutScript);
    },
    action(id) {
      return state.actions.get(id);
    },
  };
  const payload = encode({ v: 1, t: tree });
  if (options.outlets) {
    const script = createTreeScript(TREE_SCRIPT_TYPE, scope ?? "", payload.json, payload.values);
    // Decided from the tree itself, as the browser decides it: an outlet inside a streamed chunk
    // resolves later, so the script follows the layout then.
    const atOutlet = hasChildrenOutlet(tree);
    if (atOutlet) layoutScript = script;
    const layout = createTreeValue(tree, resolver) as React.ReactNode;
    const content = atOutlet ? layout : React.createElement(React.Fragment, null, layout, script);
    return React.createElement(function ServerTreeLayout() {
      return content;
    });
  }
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

interface PreparedTree {
  payload: TreeValue;
  json: string;
  values: TreeValueScripts;
  components: Map<string, React.ComponentType<any>>;
  resolver(outlets?: Record<string, React.ReactNode>, script?: React.ReactElement): TreeResolver;
  hasOutlet: boolean;
}

/** Reads a tree's payload, chunks and server HTML from `root` and loads its client modules. */
async function prepareTree(
  root: ParentNode,
  scope: string | undefined,
  options: ServerTreeElementOptions,
): Promise<PreparedTree | null> {
  const values = options.values ?? getValueStore();
  // A page's tree is unnamed; a layout's carries its scope.
  const script = Array.from(
    root.querySelectorAll<HTMLScriptElement>(`script[type="${TREE_SCRIPT_TYPE}"]`),
  ).find((candidate) => (candidate.getAttribute("name") ?? undefined) === scope);
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
  // The number in a part's name, or null for another tree's part.
  const partId = (name: string | null): number | null => {
    if (name === null) return null;
    const prefix = scope === undefined ? "" : `${scope}:`;
    if (!name.startsWith(prefix)) return null;
    const id = name.slice(prefix.length);
    return /^\d+$/.test(id) ? Number(id) : null;
  };

  const chunks = new Map<number, { tree: TreeValue; json: string; values: TreeValueScripts }>();
  for (const chunkScript of root.querySelectorAll<HTMLScriptElement>(
    `script[type="${CHUNK_SCRIPT_TYPE}"]`,
  )) {
    const id = partId(chunkScript.getAttribute("name"));
    if (id === null) continue;
    const chunkJson = chunkScript.textContent ?? "";
    chunks.set(id, {
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
  const readParts = (parts: Iterable<Element>) => {
    for (const container of parts) {
      if (container.localName !== SERVER_HTML_TAG) continue;
      const id = partId(container.getAttribute(SERVER_HTML_ATTRIBUTE));
      if (id !== null) serverHtml.set(id, container.innerHTML);
    }
  };
  readParts(root.querySelectorAll(`${SERVER_HTML_TAG}[${SERVER_HTML_ATTRIBUTE}]`));
  // The parts client components did not render, by the first part's number.
  const templates = new Map<number, string>();
  for (const template of root.querySelectorAll<HTMLTemplateElement>(
    `${HTML_TEMPLATE_ELEMENT}[${SERVER_HTML_ATTRIBUTE}]`,
  )) {
    const id = partId(template.getAttribute(SERVER_HTML_ATTRIBUTE));
    if (id === null) continue;
    templates.set(id, template.innerHTML);
    readParts(template.content.children);
  }
  // Static elements' HTML, from the page and from the templates of client components that did not
  // render them.
  const staticHtml = new Map<number, string>();
  const readStatic = (parent: ParentNode) => {
    for (const element of parent.querySelectorAll(`[${STATIC_HTML_ATTRIBUTE}]`)) {
      const id = partId(element.getAttribute(STATIC_HTML_ATTRIBUTE));
      if (id !== null && !staticHtml.has(id)) staticHtml.set(id, element.innerHTML);
    }
  };
  readStatic(root);
  for (const template of root.querySelectorAll<HTMLTemplateElement>(
    `${HTML_TEMPLATE_ELEMENT}[${SERVER_HTML_ATTRIBUTE}]`,
  )) {
    if (partId(template.getAttribute(SERVER_HTML_ATTRIBUTE)) !== null) readStatic(template.content);
  }
  // A `partial` navigation sends its static elements in a template of their own.
  for (const template of root.querySelectorAll<HTMLTemplateElement>(
    `${HTML_TEMPLATE_ELEMENT}[${STATIC_HTML_ATTRIBUTE}]`,
  )) {
    readStatic(template.content);
  }

  const resolver = (
    outlets?: Record<string, React.ReactNode>,
    outletScript?: React.ReactElement,
  ): TreeResolver => {
    const treeResolver: TreeResolver = {
      component(reference, exportName) {
        const Component = components.get(`${reference}#${exportName}`);
        if (!Component)
          throw new Error(`client reference ${reference}#${exportName} was not loaded`);
        return Component;
      },
      chunk(id) {
        const chunk = chunks.get(id);
        if (!chunk) throw new Error(`server tree chunk ${id} was not found`);
        const value = React.createElement(
          React.Fragment,
          null,
          createTreeValue(chunk.tree, treeResolver) as React.ReactNode,
          createTreeScript(CHUNK_SCRIPT_TYPE, scopedName(scope, id), chunk.json, chunk.values),
        );
        return { status: "fulfilled", value, promise: Promise.resolve(value) };
      },
      serverHtml(id, key) {
        const html = serverHtml.get(id);
        if (html === undefined) throw new Error(`server HTML ${id} was not found`);
        return React.createElement(ServerHtmlPart, {
          ...(key === null ? {} : { key }),
          element: React.createElement(options.ServerHtml, {
            as: SERVER_HTML_TAG,
            [SERVER_HTML_ATTRIBUTE]: scopedName(scope, id),
            style: { display: "contents" },
            suppressHydrationWarning: true,
            dangerouslySetInnerHTML: { __html: html },
          }),
        });
      },
      unrendered(ids) {
        const id = ids.find((candidate) => templates.has(candidate));
        if (id === undefined) return null;
        return React.createElement(HTML_TEMPLATE_ELEMENT, {
          [SERVER_HTML_ATTRIBUTE]: scopedName(scope, id),
          suppressHydrationWarning: true,
          dangerouslySetInnerHTML: { __html: templates.get(id)! },
        });
      },
      outlet(name) {
        return outletContent(outlets, name, outletScript);
      },
      action(id, sealed) {
        return createServerReference(id, sealed);
      },
      staticHtml(id, type, props) {
        const html = staticHtml.get(id);
        if (html === undefined) throw new Error(`static HTML ${id} was not found`);
        return React.createElement(type, {
          ...props,
          [STATIC_HTML_ATTRIBUTE]: scopedName(scope, id),
          suppressHydrationWarning: true,
          dangerouslySetInnerHTML: { __html: html },
        });
      },
    };
    return treeResolver;
  };

  return {
    payload: payload.t,
    json,
    values: scripts,
    components,
    resolver,
    hasOutlet: hasChildrenOutlet(payload.t),
  };
}

/** Points a tree's loaded components at a hot-updated module; true when the tree renders it. */
function updateTreeComponents(
  components: Map<string, React.ComponentType<any>>,
  src: string,
  module: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const key of components.keys()) {
    const separator = key.lastIndexOf("#");
    if (key.slice(0, separator) !== src) continue;
    components.set(key, exportOf(module, src, key.slice(separator + 1)));
    changed = true;
  }
  return changed;
}

/**
 * Rebuilds a server-tree page in the browser from its server HTML (an element, or the HTML of a
 * navigation), after loading its client modules. Returns null for a page without a tree.
 */
export async function createServerTreeElement(
  source: ParentNode | string,
  options: ServerTreeElementOptions,
): Promise<React.ReactElement | null> {
  const root = typeof source === "string" ? parseHtml(source) : source;
  const prepared = await prepareTree(root, undefined, options);
  if (!prepared) return null;
  const tree = prepared;
  const resolver = tree.resolver();

  // Validate the whole tree now, so a missing chunk or module falls back before hydration starts.
  const build = () => createTreePage(tree.payload, tree.json, resolver, undefined, tree.values);
  build();

  return React.createElement(ServerTreePage, {
    components: tree.components,
    build,
    ...(options.key === undefined ? {} : { key: options.key }),
  });
}

/**
 * Every rebuilt page is this one component type, so the next page of a layout updates the page on
 * screen in place, as a Flight update does, instead of replacing every node of it.
 */
function ServerTreePage({
  components,
  build,
}: {
  components: Map<string, React.ComponentType<any>>;
  build: () => React.ReactElement;
}): React.ReactNode {
  const [, setVersion] = React.useState(0);
  React.useEffect(() => {
    const listener: TreeUpdateListener = (src, module) => {
      const changed = updateTreeComponents(components, src, module);
      if (changed) setVersion((version) => version + 1);
      return changed;
    };
    const listeners = treeListeners();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [components]);
  return build();
}

/** A layout rebuilt from its server tree. */
export interface ServerTreeLayout {
  /** The layout around these outlets: plain elements, the same tree the server rendered. */
  render(outlets: Record<string, React.ReactNode>): React.ReactNode;
  /** Stops following hot module updates. */
  dispose(): void;
}

export interface ServerTreeLayoutOptions extends Omit<ServerTreeElementOptions, "key"> {
  /** Runs after a hot update to one of the layout's client modules: render the route again. */
  onUpdate?(): void;
}

/**
 * Rebuilds a layout the server rendered with `renderServerTree(..., { outlets, scope })`, from
 * its server HTML or a navigation's HTML. The layout's own module never reaches the browser: its
 * client components load from the tree, and `render(outlets)` places the page at its outlet.
 * Rendering it with the same component types at the same place keeps its client state across
 * navigations. Returns null when `source` has no tree for `scope`.
 */
export async function createServerTreeLayout(
  source: ParentNode | string,
  scope: string,
  options: ServerTreeLayoutOptions,
): Promise<ServerTreeLayout | null> {
  const root = typeof source === "string" ? parseHtml(source) : source;
  const tree = await prepareTree(root, scope, options);
  if (!tree) return null;
  // The script the server rendered, at the same place: the `children` outlet, or after the tree.
  const script = createTreeScript(TREE_SCRIPT_TYPE, scope, tree.json, tree.values);
  const render = (outlets: Record<string, React.ReactNode>): React.ReactNode => {
    const resolver = tree.resolver(outlets, tree.hasOutlet ? script : undefined);
    const layout = createTreeValue(tree.payload, resolver) as React.ReactNode;
    return tree.hasOutlet ? layout : React.createElement(React.Fragment, null, layout, script);
  };
  // Validate the whole tree now, so a missing chunk or module falls back before hydration starts.
  render({});
  const listener: TreeUpdateListener = (src, module) => {
    const changed = updateTreeComponents(tree.components, src, module);
    if (changed) options.onUpdate?.();
    return changed;
  };
  const listeners = treeListeners();
  listeners.add(listener);
  return {
    render,
    dispose: () => {
      listeners.delete(listener);
    },
  };
}

/** Whether a resolved tree needs the browser to rebuild it: it holds anything but plain HTML. */
function needsRebuild(value: TreeValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(needsRebuild);
  if (value.$ === "c" || value.$ === "p" || value.$ === "x" || value.$ === "a") return true;
  return Object.values(value).some(needsRebuild);
}

/** @internal An island's element prop, resolved on the server (see `createIsland`). */
export interface SlotTree {
  /** What renders where the island places the slot. */
  element: React.ReactElement;
  /** True when the browser rebuilds the slot from its payload; false for plain server HTML. */
  rebuild: boolean;
  /** Plain server HTML that is one host element: that element, which a clone gives its props. */
  host?: SlotHost;
}

/** @internal A slot's one host element: its tag and its props, other than its children. */
export interface SlotHost {
  element: React.ReactElement<Record<string, unknown>>;
  tag: string;
  props: Record<string, unknown>;
}

const isPrimitive = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/** The host element `node` is, when its props travel as JSON: strings, numbers, a style. */
function getSlotHost(node: React.ReactNode): SlotHost | undefined {
  if (!React.isValidElement(node) || typeof node.type !== "string") return undefined;
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.props as Record<string, unknown>)) {
    if (key === "children" || value === undefined) continue;
    if (key === "dangerouslySetInnerHTML" || key === "ref") return undefined;
    if (key === "style") {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      if (!Object.values(value).every(isPrimitive)) return undefined;
    } else if (!isPrimitive(value)) {
      return undefined;
    }
    props[key] = value;
  }
  return {
    element: node as React.ReactElement<Record<string, unknown>>,
    tag: node.type,
    props,
  };
}

/**
 * @internal Resolves server output passed to an island. Plain HTML renders as it is, and the
 * browser keeps it. Output holding client components (or Suspense, actions, server HTML parts)
 * renders with its payload, scoped to the slot's name, so the browser rebuilds it inside the
 * island's root: its client components are then the island's descendants and read its context,
 * as in React Server Components.
 */
export async function renderSlotTree(
  element: React.ReactNode,
  scope: string,
  held: ReadonlySet<string> | null,
): Promise<SlotTree> {
  const hook = getIslandServerHook();
  if (!hook) throw new Error("islx: an island rendered without @farm.js/islx/react/server");
  const state: ResolveState = {
    nextId: 0,
    components: new Map(),
    serverHtml: new Map(),
    chunks: new Map(),
    actions: new Map(),
  };
  const tree = await resolveValue(state, element, { parserSensitive: false }, new Set());
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
              createTreeScript(
                CHUNK_SCRIPT_TYPE,
                scopedName(scope, id),
                payload.json,
                payload.values,
              ),
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
    ...createServerHtmlParts(state, scope, isolateIslands, () => resolver),
    outlet() {
      return null;
    },
    action(id) {
      return state.actions.get(id);
    },
  };
  const rendered = createTreeValue(tree, resolver) as React.ReactNode;
  if (!needsRebuild(tree)) {
    const host = getSlotHost(rendered);
    return {
      element: React.createElement(React.Fragment, null, rendered),
      rebuild: false,
      ...(host ? { host } : {}),
    };
  }
  const payload = encode({ v: 1, t: tree });
  return {
    element: React.createElement(
      React.Fragment,
      null,
      rendered,
      createTreeScript(TREE_SCRIPT_TYPE, scope, payload.json, payload.values),
    ),
    rebuild: true,
  };
}

/**
 * @internal Rebuilds a slot the server rendered with `renderSlotTree`, from `root` (the slot's
 * element, or the template holding it) after loading its client modules. Null when the slot has no
 * payload there.
 */
export async function createSlotTree(
  root: ParentNode,
  scope: string,
  options: Omit<ServerTreeElementOptions, "key">,
): Promise<React.ReactNode | null> {
  const tree = await prepareTree(root, scope, options);
  if (!tree) return null;
  const resolver = tree.resolver();
  const script = createTreeScript(TREE_SCRIPT_TYPE, scope, tree.json, tree.values);
  const build = () =>
    React.createElement(
      React.Fragment,
      null,
      createTreeValue(tree.payload, resolver) as React.ReactNode,
      script,
    );
  // Validate the whole tree now, so a missing chunk or module fails before hydration starts.
  build();
  return build();
}
