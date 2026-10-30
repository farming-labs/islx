// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from "vitest";
import { startNavigation } from "@farm.js/islx/client";

const page = (title: string, entry = "/assets/entry.js") =>
  `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><script type="module" src="${entry}" async=""></script></body></html>`;

function setup(respond: (url: string) => Response) {
  const assign = vi.fn();
  // The document's own origin, so links resolve against it.
  vi.stubGlobal("location", Object.assign(new URL(document.URL), { assign, reload: vi.fn() }));
  document.documentElement.innerHTML = page("Home").replace(
    /^<!doctype html><html>|<\/html>$/g,
    "",
  );
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      fetched.push(String(url));
      return respond(String(url));
    }),
  );
  vi.spyOn(history, "pushState").mockImplementation(() => {});
  vi.spyOn(history, "replaceState").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const swap = vi.fn(async (next: Document) => {
    document.body.replaceChildren(...Array.from(document.importNode(next.body, true).childNodes));
  });
  return { assign, fetched, swap, navigation: startNavigation({ swap }) };
}

function click(html: string, init: MouseEventInit = {}) {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  document.body.append(holder);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  holder.firstElementChild!.dispatchEvent(event);
  return event;
}

afterAll(() => vi.unstubAllGlobals());

const html = (body: string, type = "text/html; charset=utf-8") =>
  new Response(body, { headers: { "content-type": type } });

describe("navigation", () => {
  // startNavigation runs once per page: one setup for every case.
  const state = setup((url) =>
    url.endsWith("/file.json")
      ? html("{}", "application/json")
      : url.endsWith("/other-deploy")
        ? html(page("Other", "/assets/entry-new.js"))
        : html(page("Next")),
  );

  it("takes same-site link clicks, and swaps the fetched page in", async () => {
    const event = click('<a href="/next">next</a>');
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(state.swap).toHaveBeenCalledTimes(1));
    expect(document.title).toBe("Next");
    expect(history.pushState).toHaveBeenCalled();
  });

  it("leaves links the browser should load", () => {
    for (const [link, init] of [
      ['<a href="https://elsewhere.test/">x</a>', {}],
      ['<a href="/next" target="_blank">x</a>', {}],
      ['<a href="/report.pdf" download>x</a>', {}],
      ['<a href="/next" rel="external">x</a>', {}],
      ['<a href="/next">x</a>', { metaKey: true }],
      ['<a href="/next">x</a>', { button: 1 }],
      ['<a href="#section">x</a>', {}],
      ['<a href="mailto:a@b.test">x</a>', {}],
    ] as const) {
      expect(click(link, init).defaultPrevented, link).toBe(false);
    }
  });

  it("loads the page normally for a non-HTML answer, or a page from another deploy", async () => {
    await state.navigation.navigate("/file.json");
    expect(state.assign).toHaveBeenCalledWith(new URL("/file.json", document.URL).href);
    await state.navigation.navigate("/other-deploy");
    expect(state.assign).toHaveBeenCalledWith(new URL("/other-deploy", document.URL).href);
  });

  it("asks the server for the whole page, naming what it holds", async () => {
    await state.navigation.navigate("/again");
    const call = vi.mocked(fetch).mock.calls.at(-1) as unknown as [
      URL,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(call[1].headers["F-Render"]).toBe("document");
  });
});
