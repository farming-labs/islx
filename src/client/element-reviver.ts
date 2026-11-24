/** Elements an action returned, as the server rendered them (`ELEMENT_TAG`). */
export interface RenderedElementsPayload {
  /** The scope of their server tree. */
  s: string;
  /** Their server HTML, with the tree. */
  h: string;
}

type ElementReviver = (payload: RenderedElementsPayload) => Promise<unknown>;

const ELEMENT_REVIVER = Symbol.for("islx.client.element-reviver");

/**
 * @internal Rebuilds the elements an action returned. The React hydration runtime installs it,
 * with the module loader it hydrates islands with.
 */
export function setActionElementReviver(revive: ElementReviver): void {
  (globalThis as Record<symbol, unknown>)[ELEMENT_REVIVER] = revive;
}

/** @internal The installed reviver, if a hydration runtime started. */
export function getActionElementReviver(): ElementReviver | undefined {
  return (globalThis as Record<symbol, unknown>)[ELEMENT_REVIVER] as ElementReviver | undefined;
}
