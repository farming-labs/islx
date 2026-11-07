/**
 * `useFormStatus` for islands. React reports the status of the React `<form>` around a component,
 * but a form written in a server component is server HTML: an island inside it is a React root of
 * its own, with no form above it, so React's hook never sees the form submit. The compiler points
 * client modules' `useFormStatus` from `react-dom` here.
 *
 * Forms do not nest, so an island inside a `<form>` element has no React form of its own around
 * its components: that server form is the one, and `enhanceForms` reports its submissions.
 * Anywhere else this is React's hook.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import { IDLE_FORM_STATUS, getServerFormStatus, subscribeServerForms } from "../client/forms";
import { getContexts } from "./island";

export function useFormStatus(): ReactDOM.FormStatus {
  const status = ReactDOM.useFormStatus();
  const container = React.useContext(getContexts().container);
  const form = container?.parentElement?.closest("form") ?? null;
  const server = React.useSyncExternalStore(
    subscribeServerForms,
    () => (form ? getServerFormStatus(form) : IDLE_FORM_STATUS),
    () => IDLE_FORM_STATUS,
  );
  return (form ? server : status) as ReactDOM.FormStatus;
}
