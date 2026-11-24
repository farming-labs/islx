import { SLOT_ELEMENT, SLOT_TEMPLATE_ELEMENT } from "../protocol/wire";

// The slots of an island carried over a refresh, found before it left the page it came in.
const capturedSlots = new WeakMap<Element, Map<string, Element>>();

/** Each slot `container` holds or names in its template, by name: the first one wins. */
function slotsOf(container: Element, name?: string): Map<string, Element> {
  const found = new Map<string, Element>();
  const add = (slot: Element) => {
    const slotName = slot.getAttribute("name");
    if (slotName !== null && !found.has(slotName) && (name === undefined || slotName === name)) {
      found.set(slotName, slot);
    }
    return name !== undefined && found.has(name);
  };
  for (const slot of container.querySelectorAll(SLOT_ELEMENT)) if (add(slot)) return found;
  const id = container.getAttribute("props");
  for (const template of container.ownerDocument.querySelectorAll<HTMLTemplateElement>(
    `${SLOT_TEMPLATE_ELEMENT}[for]`,
  )) {
    if (template.getAttribute("for") !== id) continue;
    for (const slot of template.content.querySelectorAll(SLOT_ELEMENT)) if (add(slot)) return found;
  }
  return found;
}

/**
 * A slot's server HTML: inside the island where it placed the slot, or in the template after its
 * props for a slot it had not placed.
 */
export function findSlot(container: Element, name: string): Element | null {
  const captured = capturedSlots.get(container);
  if (captured) return captured.get(name) ?? null;
  return slotsOf(container, name).get(name) ?? null;
}

/** Finds `container`'s slots now, for an island about to leave the page it came in. */
export function captureSlots(container: Element): void {
  capturedSlots.set(container, slotsOf(container));
}
