/**
 * Forms written in server components submit without reloading the page once JavaScript runs.
 * No island owns them, so nothing else would: a submit of a form that posts an action is sent as
 * a call, and the page refreshes as after any action, keeping island state. Forms inside islands
 * are React's, which handles them first.
 */
import { readPostedAction, stripRuntimeFields } from "../protocol/wire";
import { createServerReference } from "./actions";

let enhanced = false;

/** A server form's submission, as React's `useFormStatus` reports a form's. */
export interface ServerFormStatus {
  pending: boolean;
  data: FormData | null;
  method: string | null;
  action: ((data: FormData) => unknown) | null;
}

/** No submission in flight. */
export const IDLE_FORM_STATUS: ServerFormStatus = Object.freeze({
  pending: false,
  data: null,
  method: null,
  action: null,
});

const statuses = new WeakMap<HTMLFormElement, ServerFormStatus>();
const listeners = new Set<() => void>();

function setStatus(form: HTMLFormElement, status: ServerFormStatus | null): void {
  if (status) statuses.set(form, status);
  else statuses.delete(form);
  for (const listener of listeners) listener();
}

/** The submission in flight for a server form, or the idle status. */
export function getServerFormStatus(form: HTMLFormElement): ServerFormStatus {
  return statuses.get(form) ?? IDLE_FORM_STATUS;
}

/** Calls `listener` whenever a server form starts or settles a submission. */
export function subscribeServerForms(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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
    const action = createServerReference(posted.id, posted.token);
    setStatus(form, { pending: true, data, method: form.method || "get", action });
    action(data)
      .then(() => form.reset())
      .catch((error: unknown) => console.error("[islx] The form's action failed:", error))
      .finally(() => {
        form.removeAttribute("aria-busy");
        setStatus(form, null);
      });
  });
}
