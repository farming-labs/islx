/**
 * Reviving what islands receive beyond plain JSON: slots, server trees, actions, promises,
 * streams, tagged values, and the form state of a page after a form post. The hydration runtime
 * loads this module with the first island, form state or action result that needs it, so a page
 * whose islands take plain props never does.
 */
import * as React from "react";
import { createServerReference } from "../client/actions";
import { getValueStore, type ValueStore } from "../client/value-store";
import { NOT_A_VALUE, decode, decodeTagged, resolveCycle, setOwn } from "../protocol/codec";
import { fromStreamSteps, type StreamStep } from "../protocol/stream";
import {
  HTML_ELEMENT,
  ACTION_TAG,
  CYCLE_TAG,
  OBJECT_TAG,
  FORM_STATE_SCRIPT_TYPE,
  PROMISE_SCRIPT_TYPE,
  PROMISE_TAG,
  STREAM_KIND_FIELD,
  STREAM_TAG,
  REFERENCE_TAG,
  SLOT_ELEMENT,
  SLOT_TAG,
  SLOT_HOST_FIELD,
  SLOT_TREE_FIELD,
  TAG,
  TAG_BOUND,
  TAG_VALUE,
  getTag,
} from "../protocol/wire";
import type { RenderedElementsPayload } from "../client/element-reviver";
import { mergeSlotHostProps } from "./island";
import { findSlot } from "./slots";
import { createSlotTree } from "./tree";

/** React's form state after a `useActionState` form post, if the page carries one. */
function readFormState(document: Document): unknown {
  const script = document.querySelector(`script[type="${FORM_STATE_SCRIPT_TYPE}"]`);
  if (!script) return undefined;
  try {
    return decode(JSON.parse(script.textContent || "null"));
  } catch {
    return undefined;
  }
}

/**
 * Revived values, by the object the value store resolved. Islands that share a value (one sent
 * once for several islands) then share the revived object instead of walking it again. A value
 * with a slot is not kept: a slot's HTML belongs to one island.
 */
const revivedValues = new WeakMap<object, unknown>();
let slotsRevived = 0;

/** Each island's slots that carry server trees, rebuilt before the island hydrates. */
const preparedSlots = new WeakMap<Element, Map<string, React.ReactNode>>();

/** The names of the slots in `value` that carry server trees. */
function collectTreeSlots(value: unknown, names: Set<string>, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  const object = value as Record<string, unknown>;
  if (
    object[TAG] === SLOT_TAG &&
    object[SLOT_TREE_FIELD] === 1 &&
    typeof object[TAG_VALUE] === "string"
  ) {
    names.add(object[TAG_VALUE]);
    return;
  }
  for (const entry of Array.isArray(value) ? value : Object.values(object)) {
    collectTreeSlots(entry, names, seen);
  }
}

/** A slot's one host element, as the server sent it (see `SLOT_HOST_FIELD`). */
interface SlotHostReference {
  t: string;
  p: Record<string, unknown>;
}

// Elements that take no children, so no inner HTML either.
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/**
 * A slot whose server output is one host element. A client component that clones the slot
 * (`asChild`, `render`) gives its props to the element itself. The element keeps its server HTML
 * inside, unless the clone gives it children: those replaced the element's children on the server,
 * and render here instead.
 */
function HostSlot({
  name,
  host,
  html,
  ...given
}: { name: string; host: SlotHostReference; html: string } & Record<string, unknown>) {
  const props = mergeSlotHostProps(host.p, given);
  const keepsHtml = !VOID_ELEMENTS.has(host.t) && props.children == null;
  return React.createElement(
    SLOT_ELEMENT,
    { name, style: { display: "contents" }, suppressHydrationWarning: true },
    React.createElement(host.t, {
      ...props,
      suppressHydrationWarning: true,
      ...(keepsHtml ? { dangerouslySetInnerHTML: { __html: html } } : {}),
    }),
  );
}

/**
 * Where a revive is: the objects, arrays, maps and sets above the value, revived (what a cycle
 * reference names), and the highest of them a cycle reference below has named.
 */
interface ReviveScope {
  ancestors: unknown[];
  lowest: number;
}

/** Turns travelled props back into values: slots keep their server HTML, actions become callable. */
function revive(
  value: unknown,
  container: Element,
  values: ValueStore,
  scope: ReviveScope = { ancestors: [], lowest: Infinity },
): unknown {
  if (value && typeof value === "object") {
    const cached = revivedValues.get(value);
    if (cached !== undefined) return cached;
    const slotsBefore = slotsRevived;
    const depth = scope.ancestors.length;
    const outer = scope.lowest;
    scope.lowest = Infinity;
    const revived = reviveUncached(value, container, values, scope);
    // A value that refers to one above it is a different value elsewhere: it is not kept.
    if (slotsRevived === slotsBefore && scope.lowest >= depth) revivedValues.set(value, revived);
    scope.lowest = Math.min(outer, scope.lowest);
    return revived;
  }
  return value;
}

/** Fills `into` with `fill` while cycle references inside may name it; `fill` says whether anything changed. */
function reviveInto<T>(
  into: T,
  scope: ReviveScope,
  fill: (into: T) => boolean,
): { value: T; changed: boolean } {
  scope.ancestors.push(into);
  try {
    return { value: into, changed: fill(into) };
  } finally {
    scope.ancestors.pop();
  }
}

function reviveUncached(
  value: object,
  container: Element,
  values: ValueStore,
  scope: ReviveScope,
): unknown {
  const child = (entry: unknown) => revive(entry, container, values, scope);
  if (Array.isArray(value)) {
    const revived = reviveInto([] as unknown[], scope, (into) => {
      let changed = false;
      for (const entry of value) {
        const next = child(entry);
        into.push(next);
        if (next !== entry) changed = true;
      }
      return changed;
    });
    return revived.changed ? revived.value : value;
  }
  const object = value as Record<string, unknown>;
  const tag = getTag(object);
  if (tag === ACTION_TAG && typeof object[TAG_VALUE] === "string") {
    const token = object[TAG_BOUND];
    return createServerReference(object[TAG_VALUE], typeof token === "string" ? token : undefined);
  }
  if (tag === SLOT_TAG && typeof object[TAG_VALUE] === "string") {
    slotsRevived++;
    const name = object[TAG_VALUE];
    if (object[SLOT_TREE_FIELD] === 1) {
      const tree = preparedSlots.get(container)?.get(name);
      if (tree === undefined) throw new Error(`the server tree of slot ${name} was not prepared`);
      return React.createElement(
        SLOT_ELEMENT,
        { key: name, name, style: { display: "contents" } },
        tree,
      );
    }
    const host = object[SLOT_HOST_FIELD] as SlotHostReference | undefined;
    if (host && typeof host.t === "string" && host.p && typeof host.p === "object") {
      return React.createElement(HostSlot, {
        key: name,
        name,
        host,
        html: findSlot(container, name)?.firstElementChild?.innerHTML ?? "",
      });
    }
    const html = findSlot(container, name)?.innerHTML ?? "";
    return React.createElement(SLOT_ELEMENT, {
      key: name,
      name,
      style: { display: "contents" },
      suppressHydrationWarning: true,
      dangerouslySetInnerHTML: { __html: html },
    });
  }
  if (tag === PROMISE_TAG && typeof object[TAG_VALUE] === "string") {
    const inherited = nextSteps.get(object);
    return islandPromise(object[TAG_VALUE], container, values, {
      ancestors: inherited ?? scope.ancestors.slice(),
      step: !!inherited,
    });
  }
  if (tag === STREAM_TAG && typeof object[TAG_VALUE] === "string") {
    const kind = object[STREAM_KIND_FIELD];
    if (kind !== "r" && kind !== "i" && kind !== "t") throw new TypeError("malformed islx stream");
    return fromStreamSteps(
      islandPromise(object[TAG_VALUE], container, values, {
        ancestors: scope.ancestors.slice(),
        step: true,
      }) as PromiseLike<StreamStep>,
      kind,
    );
  }
  if (tag === REFERENCE_TAG)
    throw new Error(`islx value ${String(object[TAG_VALUE])} was not resolved`);
  if (tag === CYCLE_TAG) {
    const target = resolveCycle(scope.ancestors, object[TAG_VALUE]);
    scope.lowest = Math.min(scope.lowest, scope.ancestors.length - (object[TAG_VALUE] as number));
    return target;
  }
  // Containers exist before their contents, so a cycle reference inside can name them.
  const data = object[TAG_VALUE];
  if (tag === "M" && Array.isArray(data)) {
    return reviveInto(new Map(), scope, (map) => {
      for (const pair of data) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError('malformed "M" tag');
        map.set(child(pair[0]), child(pair[1]));
      }
      return true;
    }).value;
  }
  if (tag === "S" && Array.isArray(data)) {
    return reviveInto(new Set(), scope, (set) => {
      for (const entry of data) set.add(child(entry));
      return true;
    }).value;
  }
  if (tag === OBJECT_TAG && data && typeof data === "object" && !Array.isArray(data)) {
    return reviveInto({} as Record<string, unknown>, scope, (into) => {
      for (const [key, entry] of Object.entries(data)) setOwn(into, key, child(entry));
      return true;
    }).value;
  }
  if (tag !== undefined) {
    const decoded = decodeTagged(object, child);
    if (decoded !== NOT_A_VALUE) return decoded;
  }
  const revived = reviveInto({} as Record<string, unknown>, scope, (into) => {
    let changed = false;
    for (const [key, entry] of Object.entries(object)) {
      const next = child(entry);
      setOwn(into, key, next);
      if (next !== entry) changed = true;
    }
    return changed;
  });
  return revived.changed ? revived.value : value;
}

type IslandThenable = Promise<unknown> & {
  status?: "pending" | "fulfilled" | "rejected";
  value?: unknown;
  reason?: unknown;
};

// Promises whose outcome has not arrived, by name; one observer watches the page for them.
const pendingPromises = new Map<
  string,
  {
    thenable: IslandThenable;
    container: Element;
    values: ValueStore;
    settle(script: Element): void;
  }
>();
let promiseObserver: MutationObserver | null = null;

// The island's document, then the page: an island read from a parsed response (kept across a
// refresh) ends up on the page, where its outcome streams in.
function findPromiseScript(container: Element, name: string): Element | null {
  const documents = new Set([container.ownerDocument, globalThis.document].filter(Boolean));
  for (const document of documents) {
    for (const script of document.querySelectorAll(`script[type="${PROMISE_SCRIPT_TYPE}"]`)) {
      if (script.getAttribute("name") === name) return script;
    }
  }
  return null;
}

type Outcome = { ok: true; value: unknown } | { ok: false; reason: unknown };

/** Where a promise's settled value continues: the containers above the promise, revived. */
interface Placement {
  ancestors: readonly unknown[];
  /** Whether it is a stream's step, whose next step continues the stream's ancestors. */
  step: boolean;
}

const UNPLACED: Placement = { ancestors: [], step: false };

/** The tags that name a stream step's next step, by tag object, with the stream's ancestors. */
const nextSteps = new WeakMap<object, readonly unknown[]>();

/**
 * Rebuilds the server trees of slots in a promise's value (installed by the hydration runtime,
 * which has the module loader). They join the island's other prepared slots.
 */
let prepareValueSlots: ((container: Element, names: Set<string>) => Promise<void>) | null = null;

/**
 * Reads a promise's outcome and gives it to `done`: at once, or once the server trees of the slots
 * in its value are rebuilt (their client modules load first).
 */
function readOutcome(
  script: Element,
  container: Element,
  values: ValueStore,
  place: Placement,
  done: (outcome: Outcome) => void,
): void {
  let parsed: unknown;
  try {
    const text = script.textContent || "{}";
    parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !("v" in parsed)) {
      return done({ ok: false, reason: new Error("islx: the promise rejected on the server") });
    }
    if (text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) {
      values.ingest(container.ownerDocument);
      parsed = values.resolve(parsed);
    }
  } catch (reason) {
    return done({ ok: false, reason });
  }
  const finish = () => {
    try {
      // The value continues where the promise is, so a cycle reference inside counts up through
      // the containers above it (the server does not count the `{"v":…}` wrapper).
      const value = (parsed as { v: unknown }).v;
      const next = place.step ? (value as { n?: unknown } | null)?.n : undefined;
      if (next && typeof next === "object") nextSteps.set(next, place.ancestors);
      const scope = { ancestors: [...place.ancestors], lowest: Infinity };
      done({ ok: true, value: revive(value, container, values, scope) });
    } catch (reason) {
      done({ ok: false, reason });
    }
  };
  const names = new Set<string>();
  collectTreeSlots(parsed, names);
  const prepared = preparedSlots.get(container);
  for (const name of names) if (prepared?.has(name)) names.delete(name);
  if (names.size === 0 || !prepareValueSlots) return finish();
  prepareValueSlots(container, names).then(finish, (reason) => done({ ok: false, reason }));
}

/**
 * The promise an island received, as a thenable React's `use` reads: settled already when its
 * outcome is on the page, so hydration does not suspend, and settled when the outcome streams in
 * otherwise.
 */
// Each promise an island received, by name: a name met again (a promise that settles to the
// object holding it) is the same promise, placed before its value is revived.
const islandPromises = new WeakMap<Element, Map<string, IslandThenable>>();

function islandPromise(
  name: string,
  container: Element,
  values: ValueStore,
  place: Placement = UNPLACED,
): IslandThenable {
  let named = islandPromises.get(container);
  if (!named) islandPromises.set(container, (named = new Map()));
  const known = named.get(name);
  if (known) return known;
  const pending = pendingPromises.get(name);
  if (pending) return pending.thenable;
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const thenable: IslandThenable = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  thenable.catch(() => {});
  thenable.status = "pending";
  named.set(name, thenable);
  // Settled in place, so a `use` that reads it after this does not suspend.
  const settle = (outcome: Outcome) => {
    if (outcome.ok) {
      Object.assign(thenable, { status: "fulfilled", value: outcome.value });
      resolve(outcome.value);
    } else {
      Object.assign(thenable, { status: "rejected", reason: outcome.reason });
      reject(outcome.reason);
    }
  };
  const script = findPromiseScript(container, name);
  if (script) {
    readOutcome(script, container, values, place, settle);
    return thenable;
  }
  pendingPromises.set(name, {
    thenable,
    container,
    values,
    settle(found) {
      pendingPromises.delete(name);
      readOutcome(found, container, values, place, settle);
    },
  });
  if (!promiseObserver && typeof MutationObserver === "function") {
    promiseObserver = new MutationObserver(() => {
      for (const [pendingName, entry] of pendingPromises) {
        const found = findPromiseScript(entry.container, pendingName);
        if (found) entry.settle(found);
      }
      if (pendingPromises.size === 0) {
        promiseObserver?.disconnect();
        promiseObserver = null;
      }
    });
    promiseObserver.observe(globalThis.document ?? container.ownerDocument, {
      childList: true,
      subtree: true,
    });
  }
  return thenable;
}

export interface ReviverOptions {
  /** Imports a client module, as the hydration runtime does. */
  load(src: string): Promise<Record<string, unknown>>;
  /** Renders the server HTML parts of server trees, hydrating the islands inside. */
  ServerHtml: React.ComponentType<any>;
  /** The value store. Default: the page's. */
  values?: ValueStore;
}

/** @internal What the hydration runtime revives with, once loaded. */
export function createReviver(options: ReviverOptions) {
  const values = options.values ?? getValueStore();
  const trees = { load: options.load, ServerHtml: options.ServerHtml, values };

  /** Rebuilds the server trees of `names` (their client modules load), beside the island's others. */
  const prepareTrees = async (container: Element, names: Iterable<string>): Promise<void> => {
    const prepared = new Map(preparedSlots.get(container));
    await Promise.all(
      Array.from(names, async (name) => {
        const slot = findSlot(container, name);
        const tree = slot && (await createSlotTree(slot, name, trees));
        if (!tree) throw new Error(`slot ${name} has no server tree`);
        prepared.set(name, tree);
      }),
    );
    preparedSlots.set(container, prepared);
  };
  prepareValueSlots = prepareTrees;

  return {
    /** Props parsed from `text`, with the values they name read from `roots` and resolved. */
    resolve(text: string, parsed: unknown, roots: ParentNode[]): unknown {
      if (!text.includes(`"${TAG}":"${REFERENCE_TAG}"`)) return parsed;
      for (const root of roots) values.ingest(root);
      return values.resolve(parsed);
    },
    /**
     * Rebuilds the server trees of the slots in `props`, or returns undefined when it has none.
     * `text`, the props as sent, rules them out early when it names none.
     */
    prepare(container: Element, props: unknown, text?: string): Promise<void> | undefined {
      if (text !== undefined && !text.includes(`"${SLOT_TREE_FIELD}":1`)) return undefined;
      const names = new Set<string>();
      collectTreeSlots(props, names);
      return names.size ? prepareTrees(container, names) : undefined;
    },
    /** Turns resolved props back into values: slots keep their server HTML, actions are callable. */
    revive(props: unknown, container: Element): Record<string, unknown> {
      return revive(props, container, values) as Record<string, unknown>;
    },
    /** Elements an action returned, rebuilt as a slot's tree is: their client components are live. */
    async reviveElements({ s: scope, h: html }: RenderedElementsPayload): Promise<unknown> {
      const template = document.createElement("template");
      template.innerHTML = html;
      const tree = await createSlotTree(template.content, scope, trees);
      return (
        tree ??
        React.createElement(HTML_ELEMENT, {
          style: { display: "contents" },
          dangerouslySetInnerHTML: { __html: html },
        })
      );
    },
    readFormState,
    /** Stops waiting for the promises of islands inside `scope`, which left the page. */
    release(scope: Node): void {
      for (const [name, entry] of pendingPromises) {
        if (scope.contains(entry.container)) pendingPromises.delete(name);
      }
      if (pendingPromises.size === 0) {
        promiseObserver?.disconnect();
        promiseObserver = null;
      }
    },
  };
}

export type Reviver = ReturnType<typeof createReviver>;
