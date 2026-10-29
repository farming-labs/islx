/**
 * Forms written in server components submit without reloading the page once JavaScript runs.
 * No island owns them, so nothing else would: a submit of a form that posts an action is sent as
 * a call, and the page refreshes as after any action, keeping island state. Forms inside islands
 * are React's, which handles them first.
 */
import { readPostedAction, stripRuntimeFields } from "../protocol/wire";
import { createServerReference } from "./actions";

let enhanced = false;

/** Starts handling server-component forms on this page. Safe to call more than once. */
export function enhanceForms(): void {
  if (enhanced) return;
  enhanced = true;
  // Bubble phase: React's handlers in hydrated islands run first and prevent the default.
  document.addEventListener("submit", (event) => {
    if (event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
    const form = event.target;
    const submitter = (event as SubmitEvent).submitter ?? null;
    const data = new FormData(form, submitter);
    const posted = readPostedAction(data);
    if (!posted) return;
    event.preventDefault();
    stripRuntimeFields(data);
    form.setAttribute("aria-busy", "true");
    createServerReference(
      posted.id,
      posted.token,
    )(data)
      .then(() => form.reset())
      .catch((error: unknown) => console.error("[islx] The form's action failed:", error))
      .finally(() => form.removeAttribute("aria-busy"));
  });
}
