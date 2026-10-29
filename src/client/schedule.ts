/**
 * When an island hydrates. Renderer-neutral: every adapter schedules through this.
 *
 * - `load`: as soon as the runtime starts (the default).
 * - `idle`: when the browser is idle, or after 2 seconds.
 * - `visible`: when the island comes within 200px of the viewport.
 * - `interaction`: on the first click, submit, pointerdown or focus inside it. A click or a
 *   submit is held while the island's code loads, then replayed on the hydrated island, so the
 *   user's first action is not lost.
 *
 * Until it hydrates, an island is its server HTML: links and native forms keep working.
 */
export type IslandStrategy = "load" | "idle" | "visible" | "interaction";

export const ISLAND_STRATEGIES: readonly IslandStrategy[] = [
  "load",
  "idle",
  "visible",
  "interaction",
];

export function isIslandStrategy(value: unknown): value is IslandStrategy {
  return ISLAND_STRATEGIES.includes(value as IslandStrategy);
}

/** Set on an island once it hydrated (and its held interaction was replayed). */
export const HYDRATED_ATTRIBUTE = "hydrated";

type ReplayKind = "click" | "submit";
interface Interaction {
  target: Element;
  kind: ReplayKind;
}

/** Elements whose click is held and replayed rather than merely observed. */
const REPLAYABLE =
  'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]';

function whenIdle(callback: () => void): () => void {
  const scope = window as typeof window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof scope.requestIdleCallback === "function") {
    const handle = scope.requestIdleCallback(callback, { timeout: 2_000 });
    return () => scope.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 1);
  return () => window.clearTimeout(handle);
}

interface VisibilityRegistry {
  observer: IntersectionObserver;
  targets: Map<Element, Set<() => void>>;
}
const visibility = new WeakMap<Document, VisibilityRegistry>();

/** One observer per document, shared by every island; targets are released once they fire. */
function whenVisible(document: Document, targets: Element[], start: () => void): () => void {
  let registry = visibility.get(document);
  if (!registry) {
    const subscriptions = new Map<Element, Set<() => void>>();
    const observer = new IntersectionObserver(
      (entries) => {
        const pending = new Set<() => void>();
        for (const entry of entries) {
          if (entry.isIntersecting) {
            for (const callback of subscriptions.get(entry.target) ?? []) pending.add(callback);
          }
        }
        for (const callback of pending) callback();
      },
      { rootMargin: "200px" },
    );
    registry = { observer, targets: subscriptions };
    visibility.set(document, registry);
  }
  const current = registry;
  for (const target of targets) {
    let callbacks = current.targets.get(target);
    if (!callbacks) {
      callbacks = new Set();
      current.targets.set(target, callbacks);
      current.observer.observe(target);
    }
    callbacks.add(start);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const target of targets) {
      const callbacks = current.targets.get(target);
      callbacks?.delete(start);
      if (callbacks?.size === 0) {
        current.targets.delete(target);
        current.observer.unobserve(target);
      }
    }
    if (current.targets.size === 0) {
      current.observer.disconnect();
      visibility.delete(document);
    }
  };
}

/**
 * Replays a held interaction. `requestSubmit()` dispatches a real submit event, so handlers bound
 * during hydration see it and validation runs; `form.submit()` would bypass both.
 */
function replay({ target, kind }: Interaction): void {
  if (kind === "submit") {
    const form = target as Element & { requestSubmit?: () => void };
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else target.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    return;
  }
  const clickable = target as Element & { click?: () => void };
  if (typeof clickable.click === "function") clickable.click();
  else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function finish(container: Element, held: Interaction | null): void {
  if (!container.isConnected) return;
  container.setAttribute(HYDRATED_ATTRIBUTE, "");
  if (!held || !held.target.isConnected) return;
  // After React has attached its handlers in this task.
  window.setTimeout(() => {
    if (container.isConnected && held.target.isConnected && container.contains(held.target)) {
      replay(held);
    }
  }, 0);
}

export interface ScheduleOptions<T> {
  container: Element;
  strategy?: IslandStrategy | null;
  signal?: AbortSignal;
  hydrate(): T | Promise<T>;
}

/** Runs `hydrate` when the island's strategy says; resolves with its result, or undefined if aborted. */
export function scheduleHydration<T>({
  container,
  strategy,
  signal,
  hydrate,
}: ScheduleOptions<T>): Promise<T | undefined> {
  const resolved = strategy ?? "load";
  if (signal?.aborted) return Promise.resolve(undefined);
  if (resolved === "load") {
    return Promise.resolve()
      .then(() => (signal?.aborted ? undefined : hydrate()))
      .then((value) => {
        if (signal?.aborted) return undefined;
        finish(container, null);
        return value;
      });
  }

  return new Promise<T | undefined>((resolve, reject) => {
    let started = false;
    let cancelled = false;
    let held: Interaction | null = null;
    // One-shot triggers, dropped as soon as hydration starts.
    const triggers = new Set<() => void>();
    // Interaction capture, kept until hydration finishes: a pointerdown starts it, and the click
    // the user is making arrives a moment later, still before the code has loaded.
    const captures = new Set<() => void>();
    let removeAbort: (() => void) | null = null;
    const cleanupTriggers = () => {
      for (const dispose of triggers) dispose();
      triggers.clear();
    };
    const cleanup = () => {
      cleanupTriggers();
      for (const dispose of captures) dispose();
      captures.clear();
      removeAbort?.();
      removeAbort = null;
    };
    const start = () => {
      if (started || cancelled) return;
      started = true;
      cleanupTriggers();
      Promise.resolve()
        .then(hydrate)
        .then(
          (value) => {
            cleanup();
            if (cancelled || signal?.aborted) return;
            finish(container, held);
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
    };

    if (signal) {
      const abort = () => {
        cancelled = true;
        cleanup();
        resolve(undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }

    if (resolved === "idle") {
      triggers.add(whenIdle(start));
      return;
    }
    if (resolved === "visible") {
      if (typeof IntersectionObserver !== "function") return start();
      // Islands render with display: contents and have no box: observe their children.
      const targets =
        container.getClientRects().length > 0 ? [container] : Array.from(container.children);
      if (targets.length === 0) return start();
      triggers.add(whenVisible(container.ownerDocument, targets, start));
      return;
    }

    const hold = (event: Event, target: Element, kind: ReplayKind) => {
      held ??= { target, kind };
      event.preventDefault();
      event.stopImmediatePropagation();
      start();
    };
    const onClick = (event: Event) => {
      const mouse = event as MouseEvent;
      const target = event.target instanceof Element ? event.target.closest(REPLAYABLE) : null;
      if (
        !target ||
        !container.contains(target) ||
        target.closest("a[href]") ||
        mouse.button !== 0 ||
        mouse.metaKey ||
        mouse.altKey ||
        mouse.ctrlKey ||
        mouse.shiftKey
      ) {
        return;
      }
      hold(event, target, "click");
    };
    // A form whose only control is a text field has no button: Enter submits it.
    const onSubmit = (event: Event) => {
      const form = event.target;
      if (!(form instanceof Element) || form.nodeName !== "FORM") return;
      if (!container.contains(form) || event.defaultPrevented) return;
      hold(event, form, "submit");
    };
    // Observed, not held: a keystroke or a toggle goes through, and hydration starts early.
    const onActivate = (event: Event) => {
      if (event.target instanceof Element && container.contains(event.target)) start();
    };
    const listen = (type: string, handler: (event: Event) => void) => {
      document.addEventListener(type, handler, true);
      captures.add(() => document.removeEventListener(type, handler, true));
    };
    listen("click", onClick);
    listen("submit", onSubmit);
    listen("pointerdown", onActivate);
    listen("focusin", onActivate);
  });
}
