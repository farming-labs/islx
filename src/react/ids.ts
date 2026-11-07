/**
 * `useId` in islands. React derives an id from the component's position in its root: every array
 * of children on the way pushes a fork, `(slot << length) | bits`. The server renders a page as one
 * root and the browser hydrates each island as a root of its own, so without help an island's ids
 * start again in the browser, differ from its HTML, and repeat across islands.
 *
 * The server renders `[<IdProbe/>, <Component/>]` inside the island. The probe's id is the island's
 * position with one more fork, slot 1 of 2: `(1 << length) | bits`, so its highest bit gives the
 * position's length and the rest its bits. The browser rebuilds the same position with nested
 * arrays (`null` in the slots before) and renders `[null, <Component/>]` there: React then computes
 * the ids the server did, with the server's identifier prefix.
 */
import * as React from "react";

/** Where `IdProbe` writes the id it got. */
export interface IdRecord {
  id?: string;
}

/** Renders nothing; records the id React gives its position. */
export function IdProbe({ record }: { record: IdRecord }): null {
  record.id = React.useId();
  return null;
}

export interface IdPosition {
  /** The root's `identifierPrefix`. */
  prefix: string;
  bits: number;
  length: number;
}

// React moves bits past 30 into an overflow string the browser cannot rebuild with forks.
const MAX_BITS = 30;
// A run of zero bits needs an array of 2^run slots; past this, ids stay as React makes them.
const MAX_FORK_WIDTH = 11;

/** The island's position, from the probe's id (`_<prefix>R_<tree id>_`), or null to skip. */
export function parseIdPosition(id: string | null | undefined): IdPosition | null {
  const match = id ? /^_(.*)R_([0-9a-v]+)_$/.exec(id) : null;
  if (!match) return null;
  const probe = Number.parseInt(match[2]!, 32);
  if (!Number.isSafeInteger(probe) || probe < 1) return null;
  let length = 0;
  while (2 ** (length + 1) <= probe) length++;
  // The probe's own fork adds 2 bits; past the limit React overflowed and the id is not plain bits.
  if (length + 2 > MAX_BITS) return null;
  return { prefix: match[1]!, bits: probe - 2 ** length, length };
}

/**
 * `content` at `position`, as the second of two children, where the server rendered the island's
 * component. Null when the position cannot be rebuilt.
 */
export function atIdPosition(
  position: IdPosition,
  content: React.ReactNode,
): React.ReactElement | null {
  const { bits, length } = position;
  // Forks from the outermost (lowest bits) in: each run of bits ending in a one is one fork, and
  // zeros above the last one widen it.
  const forks: Array<{ start: number; width: number }> = [];
  let start = 0;
  for (let bit = 0; bit < length; bit++) {
    if (Math.floor(bits / 2 ** bit) % 2 === 1) {
      forks.push({ start, width: bit - start + 1 });
      start = bit + 1;
    }
  }
  if (start < length) {
    const last = forks.at(-1);
    if (!last) return null;
    last.width += length - start;
  }
  let node: React.ReactElement = React.createElement(React.Fragment, { key: "island" }, [
    null,
    React.createElement(React.Fragment, { key: "component" }, content),
  ]);
  for (let index = forks.length - 1; index >= 0; index--) {
    const { start: from, width } = forks[index]!;
    if (width > MAX_FORK_WIDTH) return null;
    const slot = Math.floor(bits / 2 ** from) % 2 ** width;
    // An array of 2^(width-1) children forks with `width` bits; the node sits at slot - 1.
    const children: React.ReactNode[] = Array.from({ length: 2 ** (width - 1) }, () => null);
    children[slot - 1] = node;
    node = React.createElement(React.Fragment, { key: `fork${index}` }, children);
  }
  return node;
}
