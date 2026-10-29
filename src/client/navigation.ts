/**
 * Moving between pages without loading a new document. A click on a same-site link fetches the
 * next page (naming the values the browser holds, so the server leaves them out), and the
 * renderer swaps it in: the runtime, its loaded code and its values stay.
 *
 * Renderer-neutral: the adapter passes `swap`. Anything unusual loads the page the ordinary way:
 * a link to another site, `target`, `download`, `rel="external"`, a modifier key, a non-HTML or
 * failed response, or a page built by another deploy.
 */
import { RENDER_HEADER } from "../protocol/wire";
import { emit } from "./hooks";
import { valueHeaders } from "./value-store";

export interface NavigationOptions {
  /** Puts the fetched page in place of the current one. */
  swap(next: Document, url: URL): void | Promise<void>;
  /** Animates the change with `document.startViewTransition`, where the browser has it. */
  viewTransition?: boolean;
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
}

interface HistoryState {
  islx: true;
  scroll: [number, number];
}

/** The `F-Render` value of a navigation: the server renders the whole page before sending it. */
export const NAVIGATION_RENDER = "document";

let started: { navigate(href: string, options?: NavigateOptions): Promise<void> } | null = null;
/** Set by the click handler for the navigation it starts, so hooks see `kind: "link"`. */
let clicking = false;

/** The URL of the page's browser entry: a page from another deploy names another one. */
function entryOf(document: Document): string | null {
  return document.querySelector('script[type="module"][src][async]')?.getAttribute("src") ?? null;
}

function isOurs(state: unknown): state is HistoryState {
  return !!state && typeof state === "object" && (state as HistoryState).islx === true;
}

function rememberScroll(): void {
  const state: HistoryState = { islx: true, scroll: [window.scrollX, window.scrollY] };
  history.replaceState({ ...history.state, ...state }, "");
}

let announcer: HTMLElement | null = null;
/** Tells screen readers the page changed, as a document load would. */
function announce(title: string): void {
  if (!announcer || !announcer.isConnected) {
    announcer = document.createElement("div");
    announcer.setAttribute("aria-live", "assertive");
    announcer.setAttribute("role", "status");
    announcer.style.cssText =
      "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);border:0";
    document.body.append(announcer);
  }
  announcer.textContent = title;
}

/** Adds stylesheets the next page uses that this one has not loaded. */
function mergeStyles(next: Document): void {
  const loaded = new Set(
    Array.from(
      document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      (link) => link.href,
    ),
  );
  for (const link of next.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const href = new URL(link.getAttribute("href") ?? "", next.baseURI || location.href).href;
    if (!loaded.has(href)) document.head.append(document.importNode(link, true));
  }
}

/**
 * Handles same-site link clicks and history from now on. Returns `navigate` for navigations the
 * app starts itself. Safe to call more than once.
 */
export function startNavigation(options: NavigationOptions): {
  navigate(href: string, options?: NavigateOptions): Promise<void>;
} {
  if (started) return started;
  let current: AbortController | null = null;
  /** The page on screen: where a cancelled back or forward returns to. */
  let here = new URL(location.href);
  history.scrollRestoration = "manual";
  rememberScroll();

  async function go(
    url: URL,
    push: "push" | "replace" | "none",
    scroll: [number, number] | null,
  ): Promise<void> {
    const kind =
      push === "none"
        ? "history"
        : push === "push" && scroll === null && clicking
          ? "link"
          : "code";
    clicking = false;
    if (!emit("navigate", { url, from: here, kind })) {
      // History has already moved: put the address back to the page that stays.
      if (push === "none")
        history.pushState({ islx: true, scroll: [window.scrollX, window.scrollY] }, "", here);
      return;
    }
    const startedAt = performance.now();
    current?.abort();
    const controller = new AbortController();
    current = controller;
    let next: Document;
    let finalUrl: URL;
    try {
      const response = await fetch(url, {
        headers: { accept: "text/html", [RENDER_HEADER]: NAVIGATION_RENDER, ...valueHeaders() },
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.headers.get("content-type")?.includes("text/html"))
        throw new Error("not a page");
      finalUrl = new URL(response.url || url.href);
      if (finalUrl.origin !== location.origin) throw new Error("redirected to another site");
      finalUrl.hash = url.hash;
      next = new DOMParser().parseFromString(await response.text(), "text/html");
      if (entryOf(next) !== entryOf(document)) throw new Error("built by another deploy");
    } catch (error) {
      if (controller.signal.aborted) return;
      emit("navigateError", {
        url,
        reason: error instanceof Error ? error.message : String(error),
      });
      // Let the browser load it: it shows whatever the server answers.
      if (push === "none") location.reload();
      else location.assign(url.href);
      return;
    }
    if (controller.signal.aborted) return;
    if (push === "push")
      history.pushState({ islx: true, scroll: [0, 0] } satisfies HistoryState, "", finalUrl);
    else if (push === "replace")
      history.replaceState({ islx: true, scroll: [0, 0] } satisfies HistoryState, "", finalUrl);
    mergeStyles(next);
    document.title = next.title;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const swap = () => options.swap(next, finalUrl);
    const transition = (
      document as Document & {
        startViewTransition?: (update: () => Promise<void> | void) => {
          updateCallbackDone: Promise<void>;
        };
      }
    ).startViewTransition;
    if (options.viewTransition && typeof transition === "function") {
      await transition.call(document, swap).updateCallbackDone;
    } else {
      await swap();
    }
    here = new URL(location.href);
    if (scroll) window.scrollTo(scroll[0], scroll[1]);
    else if (finalUrl.hash)
      document.getElementById(decodeURIComponent(finalUrl.hash.slice(1)))?.scrollIntoView();
    else window.scrollTo(0, 0);
    announce(next.title || finalUrl.pathname);
    if (current === controller) current = null;
    emit("navigated", { url: finalUrl, duration: performance.now() - startedAt });
  }

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;
    if (link.target && link.target !== "_self") return;
    if (link.hasAttribute("download") || link.relList.contains("external")) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return;
    // A link within this page: the browser scrolls to it.
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    event.preventDefault();
    rememberScroll();
    clicking = true;
    void go(url, "push", null);
  });

  window.addEventListener("popstate", (event) => {
    if (!isOurs(event.state)) return;
    void go(new URL(location.href), "none", event.state.scroll);
  });

  started = {
    navigate(href, navigateOptions = {}) {
      rememberScroll();
      return go(new URL(href, location.href), navigateOptions.replace ? "replace" : "push", null);
    },
  };
  return started;
}

/** Navigates within the site, through `startNavigation` when it runs, or by loading the page. */
export function navigate(href: string, options: NavigateOptions = {}): Promise<void> {
  if (started) return started.navigate(href, options);
  if (options.replace) location.replace(href);
  else location.assign(href);
  return Promise.resolve();
}
