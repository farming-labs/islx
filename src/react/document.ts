/**
 * Rendering the current page again without a router: after an action, the browser fetches the
 * page, keeps the live islands that render again (with their state), and swaps in the rest.
 * Frameworks with a router refresh through it instead.
 */
import { valueHeaders } from "../client/value-store";
import type { HydrationRuntime } from "./hydrate";

/** Fetches the current page and puts its new content in place, keeping island state. */
export async function refreshDocument(runtime: HydrationRuntime): Promise<void> {
  const response = await fetch(location.href, {
    headers: { accept: "text/html", ...valueHeaders() },
    credentials: "same-origin",
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
    location.reload();
    return;
  }
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  if (next.title) document.title = next.title;
  // Brought into this document first: live islands move into it without changing documents.
  const body = document.importNode(next.body, true);
  runtime.carryOver(document.body, body);
  // Islands that were not carried over are still in the old body.
  runtime.dispose(document.body);
  document.body.replaceChildren(...Array.from(body.childNodes));
  await runtime.hydrate(document);
}
