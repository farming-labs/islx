/**
 * @farm.js/islx/react/server: rendering a React page with islands. Importing it gives islands the
 * server code they need (values, action references); `renderToStream` renders a page.
 */
import * as React from "react";
import { fromStreamSteps, getStreamKind, toStreamSteps, type StreamStep } from "../protocol/stream";
import type { RenderToReadableStreamOptions } from "react-dom/server";
import { encode, readIterator, setIteratorEntries } from "../protocol/codec";
import {
  FORM_STATE_SCRIPT_TYPE,
  PROMISE_TAG,
  STREAM_KIND_FIELD,
  STREAM_TAG,
  RENDER_HEADER,
  TAG,
  TAG_VALUE,
} from "../protocol/wire";
import { RUNTIME_GLOBAL } from "../boot";
import { PREHYDRATION_SCRIPT } from "../client/prehydration";
import { encodeActionReference } from "../server/actions";
import { encodeSentObject, prepareBlobs } from "../server/blobs";
import { isTemporaryReference } from "../server/temporary";
import { getBuildDefaults } from "../server/build";
import { RenderedElements, setActionResultRenderer, type ReactFormState } from "../server/handle";
import {
  addressValues,
  escapeScriptJson,
  parseHeldValues,
  selectValuesToSend,
} from "../server/values";
import {
  getContexts,
  getWireSteps,
  runtimeTagged,
  setIslandServerHook,
  type IslandPromiseEntry,
} from "./island";
import { renderSlotTree } from "./tree";

// Promise names are unique across renders and server instances, so a page that keeps islands from
// an earlier response never has two promises of one name. The random prefix is made at the first
// render: Cloudflare Workers reject a module that generates random values while it loads.
let promisePrefix: string | undefined;
let promiseCount = 0;

function nextPromiseName(): string {
  promisePrefix ??= `${Array.from(crypto.getRandomValues(new Uint32Array(2)), (part) =>
    part.toString(36),
  ).join("")}.`;
  return promisePrefix + (promiseCount++).toString(36);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

setIslandServerHook({
  encode(props, held, context, ancestors) {
    const promises: IslandPromiseEntry[] = [];
    const named = context?.named;
    const addressed = addressValues(props, {
      ancestors,
      encodeSpecial: (value, above) => {
        if (value && typeof value === "object" && runtimeTagged.has(value)) return value;
        if (isTemporaryReference(value)) {
          throw new TypeError(
            "a value the browser sent to a server action can be returned to it, but not passed to a client component's props",
          );
        }
        const sent = encodeSentObject(value);
        if (sent) return sent;
        const known = value && typeof value === "object" ? named?.get(value) : undefined;
        if (known) return known;
        const kind = getStreamKind(value);
        if (kind) {
          // Sent as the promise of its first step, which settles as the stream is read. A stream
          // the island split already has its steps.
          const name = nextPromiseName();
          const split = getWireSteps(value as object);
          promises.push({
            name,
            promise: split?.first ?? toStreamSteps(value as object, kind),
            ancestors: above(),
            step: true,
          });
          const tag = {
            [TAG]: STREAM_TAG,
            [TAG_VALUE]: name,
            [STREAM_KIND_FIELD]: split?.kind ?? kind,
          };
          named?.set(value as object, tag);
          return tag;
        }
        if (isThenable(value)) {
          const name = nextPromiseName();
          const inherited = context?.nextSteps.get(value);
          promises.push({
            name,
            promise: value,
            ancestors: inherited ?? above(),
            step: !!inherited,
          });
          const tag = { [TAG]: PROMISE_TAG, [TAG_VALUE]: name };
          named?.set(value as object, tag);
          return tag;
        }
        if (typeof value === "function") {
          const reference = encodeActionReference(value);
          if (reference) return reference;
          const name = (value as { name?: string }).name;
          throw new TypeError(
            `functions are not serializable${name ? ` (${name})` : ""}: pass a server action, or move the function into the client component`,
          );
        }
        return undefined;
      },
    });
    return {
      json: addressed.json,
      values: selectValuesToSend(addressed, held).map(({ key, json }) => ({ key, json })),
      promises,
    };
  },
  prepare: prepareBlobs,
  escape: escapeScriptJson,
  address(payload, skip) {
    const addressed = addressValues(payload, { encoded: true });
    return {
      json: addressed.json,
      values: selectValuesToSend(addressed, skip).map(({ key, json }) => ({ key, json })),
    };
  },
  action: (value) => encodeActionReference(value),
});

export interface RenderToStreamOptions extends Omit<RenderToReadableStreamOptions, "formState"> {
  /**
   * The request being answered: its `F-Values` header names the values the browser holds, and
   * the page leaves them out. Leave it out for a response that may be shared (a CDN, a static
   * page): every value is sent.
   */
  request?: Request;
  /**
   * The form state `handleAction` passed to `renderFormState`, after a form posted from a
   * `useActionState` hook. The page shows the action's result, and so do its islands once they
   * hydrate.
   */
  formState?: ReactFormState | null;
  /**
   * Adds the browser entry that hydrates islands (from the bundler plugin) to the page. Default
   * true; a framework that adds its own scripts turns it off.
   */
  bootstrap?: boolean;
  /**
   * Adds the inline script that holds a click or a submit on an island before the browser entry
   * has run, to replay it once the island hydrates. Default: with the browser entry.
   */
  prehydration?: boolean;
}

/** The script carrying a form post's state to the browser, for `hydrateRoot`. */
function FormStateScript({ formState }: { formState: ReactFormState }) {
  return React.createElement("script", {
    type: FORM_STATE_SCRIPT_TYPE,
    dangerouslySetInnerHTML: { __html: escapeScriptJson(JSON.stringify(encode(formState))) },
  });
}

/**
 * Renders a page whose client components are islands. A response rendered with a `request` whose
 * browser holds values is that browser's alone: send it `private` and never share it.
 *
 * A navigation (`F-Render` on the request) gets the whole page in one piece: the browser puts it
 * in place with DOM methods, which run no scripts, so the page cannot stream in with React's
 * inline scripts. Every Suspense boundary has resolved before the first byte.
 */
export async function renderToStream(
  element: React.ReactNode,
  { request, formState, bootstrap = true, prehydration, ...options }: RenderToStreamOptions = {},
): Promise<ReadableStream<Uint8Array> & { allReady: Promise<void> }> {
  const held = request ? parseHeldValues(request) : null;
  const { render } = getContexts();
  const tree = React.createElement(
    render.Provider,
    { value: { held: held && held.size > 0 ? held : null, sent: new Set<string>() } },
    element,
    formState ? React.createElement(FormStateScript, { formState }) : null,
  );
  const defaults = getBuildDefaults();
  const entry = bootstrap ? defaults.entry : undefined;
  // The boot entry starts the page and loads the browser entry when the page first needs it.
  const boot = entry !== undefined ? defaults.boot : undefined;
  const bootstrapModules = entry
    ? [...(options.bootstrapModules ?? []), boot ?? entry]
    : options.bootstrapModules;
  const runtime = boot
    ? `window.${RUNTIME_GLOBAL}=${escapeScriptJson(JSON.stringify(entry))};`
    : "";
  // The inline script runs as soon as the page's content is parsed, before the deferred entry.
  const bootstrapScriptContent =
    (prehydration ?? entry !== undefined)
      ? `${PREHYDRATION_SCRIPT}${runtime}${options.bootstrapScriptContent ?? ""}`
      : runtime || options.bootstrapScriptContent
        ? `${runtime}${options.bootstrapScriptContent ?? ""}`
        : undefined;
  // Loaded here, not at the top: importing this module (for islands' server code) must work in any
  // React environment, including a react-server one that has no renderToReadableStream.
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(tree, {
    ...options,
    bootstrapModules,
    bootstrapScriptContent,
    formState: formState as never,
  });
  if (request?.headers.has(RENDER_HEADER)) await stream.allReady;
  return stream;
}

let resultScopes = 0;

/**
 * Renders elements an action returned as a slot's server tree, so the browser rebuilds them with
 * their client components live. Each result gets a scope of its own.
 */
async function renderResultElements(element: React.ReactElement): Promise<RenderedElements> {
  const scope = `x${(resultScopes++).toString(36)}`;
  const tree = await renderSlotTree(element, scope, null);
  const { render } = getContexts();
  const { renderToReadableStream } = await import("react-dom/server");
  const stream = await renderToReadableStream(
    React.createElement(
      render.Provider,
      { value: { held: null, sent: new Set<string>() } },
      tree.element,
    ),
  );
  await stream.allReady;
  return new RenderedElements(scope, await new Response(stream).text());
}

/**
 * One action result's render: each object and array becomes one copy, made before what is inside
 * it, so a value that refers to itself refers to its copy; each promise and stream is wrapped
 * once. What a promise or stream settles to renders after what came before it, so it reuses those
 * copies: a promise that settles to the object holding it gives back that object's copy.
 */
interface ResultRender {
  copies: WeakMap<object, unknown>;
  wrapped: WeakMap<object, unknown>;
  /** The renders so far, in order. */
  queue: Promise<unknown>;
}

/** Elements rendering: the copy holds a placeholder until they have. */
class RenderingElements {
  constructor(readonly done: Promise<RenderedElements>) {}
}

/**
 * The value with each React element in it rendered and the rest copied. `pending` collects the
 * element renders still running, which set their place in the copy once done.
 */
function renderInResult(value: unknown, render: ResultRender, pending: Promise<void>[]): unknown {
  if (!value || typeof value !== "object") return value;
  if (React.isValidElement(value)) return new RenderingElements(renderResultElements(value));
  const copied = render.copies.get(value) ?? render.wrapped.get(value);
  if (copied !== undefined) return copied;
  // What a promise or a stream settles to renders as it settles. The callbacks are attached here,
  // inside the framework's `run`, so they render with the request's context too.
  if (isThenable(value)) {
    const wrapped = Promise.resolve(value).then((settled) => renderLater(settled, render));
    render.wrapped.set(value, wrapped);
    return wrapped;
  }
  const kind = getStreamKind(value);
  if (kind) {
    const wrapped = fromStreamSteps(renderSteps(toStreamSteps(value, kind), render), kind);
    render.wrapped.set(value as object, wrapped);
    return wrapped;
  }
  const place = (rendered: unknown, set: (value: unknown) => void) => {
    if (rendered instanceof RenderingElements) pending.push(rendered.done.then(set));
    else set(rendered);
  };
  if (Array.isArray(value)) {
    const copy: unknown[] = Array.from({ length: value.length });
    render.copies.set(value, copy);
    value.forEach((entry, index) => {
      place(renderInResult(entry, render, pending), (rendered) => (copy[index] = rendered));
    });
    return copy;
  }
  // An iterator travels as its entries (read once), rendered like an array's.
  const entries = readIterator(value);
  if (entries) {
    const copy: unknown[] = Array.from({ length: entries.length });
    const iterator = copy.values();
    setIteratorEntries(iterator, copy);
    render.copies.set(value, iterator);
    entries.forEach((entry, index) => {
      place(renderInResult(entry, render, pending), (rendered) => (copy[index] = rendered));
    });
    return iterator;
  }
  // A map's or set's entries render in order, keys too, once each is ready.
  if (value instanceof Map || value instanceof Set) {
    const copy = value instanceof Map ? new Map<unknown, unknown>() : new Set<unknown>();
    render.copies.set(value, copy);
    const entries: unknown[][] = Array.from(
      value instanceof Map ? value : value.values(),
      (entry) => (value instanceof Map ? (entry as [unknown, unknown]).slice() : [entry]),
    );
    const filling: Promise<void>[] = [];
    for (const entry of entries) {
      entry.forEach((part, index) => {
        const rendered = renderInResult(part, render, pending);
        if (rendered instanceof RenderingElements) {
          filling.push(rendered.done.then((done) => void (entry[index] = done)));
        } else entry[index] = rendered;
      });
    }
    const add = () => {
      for (const entry of entries) {
        if (copy instanceof Map) copy.set(entry[0], entry[1]);
        else copy.add(entry[0]);
      }
    };
    if (filling.length === 0) add();
    else pending.push(Promise.all(filling).then(add));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype) as Record<string, unknown>;
  render.copies.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    const set = (rendered: unknown) =>
      Object.defineProperty(copy, key, {
        value: rendered,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    // Its place first, so the copy keeps the order of the keys while elements render.
    set(undefined);
    place(renderInResult(entry, render, pending), set);
  }
  return copy;
}

/** Renders `value` once every render before it finished, so it reuses their copies. */
function renderLater(value: unknown, render: ResultRender): Promise<unknown> {
  const done = render.queue.then(async () => {
    const pending: Promise<void>[] = [];
    const rendered = renderInResult(value, render, pending);
    await Promise.all(pending);
    return rendered instanceof RenderingElements ? await rendered.done : rendered;
  });
  render.queue = done.catch(() => {});
  return done;
}

const renderResult = (value: unknown) =>
  renderLater(value, { copies: new WeakMap(), wrapped: new WeakMap(), queue: Promise.resolve() });

/** Each step's chunk and return value, rendered. Steps are read as they arrive, as before. */
function renderSteps(steps: PromiseLike<StreamStep>, render: ResultRender): Promise<StreamStep> {
  return Promise.resolve(steps).then(async (step): Promise<StreamStep> => {
    if (!("d" in step)) {
      return { v: await renderLater(step.v, render), n: renderSteps(step.n, render) };
    }
    return step.v === undefined ? step : { d: 1, v: await renderLater(step.v, render) };
  });
}

setActionResultRenderer(renderResult);

/** Whether a response rendered for `request` leaves out values its browser holds. */
export function isPersonalized(request: Request): boolean {
  return parseHeldValues(request).size > 0;
}

export {
  IslandsProvider,
  createIsland,
  getClientReference,
  isolateIslands,
  setRenderStateResolver,
  withinClientRoot,
  type ClientReference,
  type IslandRenderState,
} from "./island";
export {
  Outlet,
  PAYLOAD_ONLY_ATTRIBUTE,
  renderServerTree,
  type ServerTreeRenderOptions,
} from "./tree";
