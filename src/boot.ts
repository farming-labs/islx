/**
 * @farm.js/islx/boot: the first script of a page, in place of the browser entry. It loads the entry
 * (the runtime: the renderer, islx's hydration, navigation and forms) when the page first needs
 * it, so a page whose islands all wait loads only this script until one is used:
 *
 * - at once, when an island hydrates at load (`strategy="load"`, also one that streams in later)
 *   or a Suspense boundary is left for the browser to finish;
 * - otherwise on the first island trigger (`idle`; `visible`, with the scheduler's 200px margin;
 *   an interaction the inline pre-hydration script saw) or on intent to follow a link (a pointer
 *   over it, a press, a focus), or a focus in a form.
 *
 * The inline pre-hydration script holds the clicks and submits on waiting islands until then. A
 * same-site link clicked before the entry has run is held too, and clicked again once it has, so
 * navigation decides as for any click; if the entry fails to load, the link navigates natively.
 *
 * Renderer-neutral, and it imports nothing: a module it shared with the entry would change how the
 * entry splits into chunks. The server names the entry in `window.__islxRuntime`.
 */

/** Kept equal to the island element (protocol/wire.ts); a test compares them. */
export const BOOT_ISLAND_ELEMENT = "f-island";
/** Kept equal to HYDRATED_ATTRIBUTE (protocol/wire.ts). */
export const BOOT_HYDRATED_ATTRIBUTE = "hydrated";
/** Kept equal to INTERACTION_EVENT (client/prehydration.ts). */
export const BOOT_INTERACTION_EVENT = "f:island-interaction";
/** Kept equal to the scheduler's visibility margin (client/schedule.ts). */
export const BOOT_VISIBLE_MARGIN = "200px";
/** Where the server names the browser entry for the boot. */
export const RUNTIME_GLOBAL = "__islxRuntime";

function isModified(event: MouseEvent): boolean {
  return event.metaKey || event.altKey || event.ctrlKey || event.shiftKey;
}

/** A link islx navigation takes: the same checks as its click handler. */
function navigableLink(target: EventTarget | null): HTMLAnchorElement | null {
  const link = target instanceof Element ? target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return null;
  if (link.target && link.target !== "_self") return null;
  if (link.hasAttribute("download") || link.relList.contains("external")) return null;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return null;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) {
    return null;
  }
  return link;
}

/** Runs the browser entry the server named, as a module script: the same URL, so the same module. */
function loadRuntime(): Promise<void> {
  const src = (window as unknown as Record<string, unknown>)[RUNTIME_GLOBAL];
  if (typeof src !== "string" || src === "") {
    return Promise.reject(new Error(`islx: the page names no browser entry (${RUNTIME_GLOBAL}).`));
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = src;
    // A page under a content security policy gave its scripts a nonce.
    const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    if (nonce) script.nonce = nonce;
    // A module script's load event fires once it has run.
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`islx: ${src} failed to load.`)), {
      once: true,
    });
    document.head.append(script);
  });
}

/** Starts the runtime when the page first needs it. `load` runs it; it starts as it runs. */
export function startBoot(load: () => Promise<unknown> = loadRuntime): void {
  const cleanups: Array<() => void> = [];
  let loading: Promise<unknown> | undefined;

  // The runtime holds and replays from here on. A capture left in place would hold clicks it
  // never replays, and one left after a failed load would hold them forever.
  const release = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  const start = (): Promise<unknown> => {
    if (!loading) {
      loading = load().then(release, (error: unknown) => {
        release();
        throw error;
      });
      loading.catch((error: unknown) => console.error(error));
    }
    return loading;
  };
  const listen = (type: string, handler: (event: Event) => void, capture: boolean) => {
    document.addEventListener(type, handler, capture);
    cleanups.push(() => document.removeEventListener(type, handler, capture));
  };

  // An interaction on a waiting island, from the inline script (held clicks and submits included).
  listen(BOOT_INTERACTION_EVENT, () => void start(), false);
  // Intent: a pointer over a link, or a press or focus on one or in a form.
  const intent = (event: Event) => {
    if (navigableLink(event.target)) void start();
    else if (event.type !== "mouseover" && (event.target as Element | null)?.closest?.("form")) {
      void start();
    }
  };
  for (const type of ["pointerdown", "focusin", "mouseover"]) listen(type, intent, true);

  // A link clicked before the runtime runs: held, then clicked again once navigation listens.
  // Bubble phase, like navigation, so a handler that prevents the default first still wins.
  listen(
    "click",
    (event) => {
      const click = event as MouseEvent;
      if (click.defaultPrevented || click.button !== 0 || isModified(click)) return;
      const link = navigableLink(click.target);
      if (!link) return;
      click.preventDefault();
      start().then(
        () => {
          if (link.isConnected) {
            link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          } else location.assign(link.href);
        },
        () => location.assign(link.href),
      );
    },
    false,
  );

  // Each island's trigger. An island that hydrates at load, or a boundary the browser must finish,
  // starts the runtime at once.
  const visibility =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(
          (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) void start();
          },
          { rootMargin: BOOT_VISIBLE_MARGIN },
        )
      : null;
  if (visibility) cleanups.push(() => visibility.disconnect());
  let idle = false;
  const startWhenIdle = () => {
    if (idle) return;
    idle = true;
    const scope = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof scope.requestIdleCallback === "function") {
      const handle = scope.requestIdleCallback(() => void start(), { timeout: 2_000 });
      cleanups.push(() => scope.cancelIdleCallback?.(handle));
    } else {
      const handle = window.setTimeout(() => void start(), 1);
      cleanups.push(() => window.clearTimeout(handle));
    }
  };
  // Islands render with display:contents: observe their children, as the scheduler does. A
  // streamed island's children may arrive after it, so it is judged once the page is parsed.
  const parsedVisible: Element[] = [];
  const observeVisible = (island: Element) => {
    const targets = island.getClientRects().length > 0 ? [island] : Array.from(island.children);
    if (!visibility || targets.length === 0) void start();
    else for (const target of targets) visibility.observe(target);
  };
  const considerIsland = (island: Element) => {
    if (island.hasAttribute(BOOT_HYDRATED_ATTRIBUTE)) return;
    if (island.parentElement?.closest(BOOT_ISLAND_ELEMENT)) return;
    const strategy = island.getAttribute("strategy");
    if (strategy === "interaction") return;
    if (strategy === "idle") startWhenIdle();
    else if (strategy !== "visible") void start();
    else if (document.readyState === "loading") parsedVisible.push(island);
    else observeVisible(island);
  };
  const consider = (node: Node) => {
    if (loading) return;
    if (node.nodeType === Node.COMMENT_NODE) {
      // A boundary React gave up on during the server render: the browser renders it.
      if ((node as Comment).data === "$!") void start();
    } else if (node instanceof Element) {
      if (node.matches(BOOT_ISLAND_ELEMENT)) considerIsland(node);
      for (const island of Array.from(node.querySelectorAll(BOOT_ISLAND_ELEMENT))) {
        considerIsland(island);
      }
    }
  };
  const pendingBoundary = () => {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) if ((walker.currentNode as Comment).data === "$?") return true;
    return false;
  };
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  while (!loading && walker.nextNode()) consider(walker.currentNode);
  consider(document.documentElement);

  const parsed = () => {
    // The stream ended with a boundary it never completed: the runtime finishes it.
    if (pendingBoundary()) void start();
    for (const island of parsedVisible.splice(0)) if (!loading) observeVisible(island);
  };
  if (!loading && document.readyState === "loading") {
    // A page still streaming: islands and boundaries the parser adds later are judged as they come.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) consider(node);
      }
    });
    observer.observe(document, { childList: true, subtree: true });
    const done = () => {
      observer.disconnect();
      parsed();
    };
    document.addEventListener("DOMContentLoaded", done, { once: true });
    cleanups.push(() => {
      observer.disconnect();
      document.removeEventListener("DOMContentLoaded", done);
    });
  } else if (!loading) {
    parsed();
  }
}
