// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { PENDING_INTERACTIONS, PREHYDRATION_SCRIPT } from "../src/client/prehydration";

// The inline script, run as the page runs it.
new Function(PREHYDRATION_SCRIPT)();

function click(target: Element): boolean {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  // jsdom cannot navigate: stop a click the script let through, once its outcome is read.
  let prevented: boolean | undefined;
  const read = (seen: Event) => {
    prevented = seen.defaultPrevented;
    seen.preventDefault();
  };
  window.addEventListener("click", read);
  target.dispatchEvent(event);
  window.removeEventListener("click", read);
  return prevented ?? event.defaultPrevented;
}

const queue = () =>
  (window as unknown as Record<string, Array<{ target: Element }>>)[PENDING_INTERACTIONS]!;

afterEach(() => {
  queue().splice(0);
  document.body.innerHTML = "";
});

describe("the pre-hydration script", () => {
  it("holds a click on a same-page link in a waiting island, and lets other links go", () => {
    document.body.innerHTML =
      '<f-island strategy="interaction"><a href="#usage">Usage</a><a href="/next">Next</a></f-island>';
    const [hash, page] = Array.from(document.querySelectorAll("a"));
    expect(click(hash!)).toBe(true);
    expect(queue().map((item) => item.target)).toEqual([hash]);
    expect(click(page!)).toBe(false);
    expect(queue()).toHaveLength(1);
  });

  it("holds every click on a control in a waiting island, in order", () => {
    document.body.innerHTML =
      '<f-island strategy="interaction"><button type="button">Add</button><button type="button">Undo</button></f-island>';
    const [add, undo] = Array.from(document.querySelectorAll("button"));
    expect(click(add!)).toBe(true);
    expect(click(add!)).toBe(true);
    expect(click(undo!)).toBe(true);
    expect(queue().map((item) => item.target)).toEqual([add, add, undo]);
  });

  it("holds a repeated click on a submit button, and queues it once", () => {
    document.body.innerHTML =
      '<f-island strategy="interaction"><form><button>Save</button></form></f-island>';
    const save = document.querySelector("button")!;
    expect(click(save)).toBe(true);
    expect(click(save)).toBe(true);
    expect(queue().map((item) => item.target)).toEqual([save]);
  });

  it("lets a click in a hydrated island through", () => {
    document.body.innerHTML =
      '<f-island strategy="interaction" hydrated><a href="#a">A</a></f-island>';
    expect(click(document.querySelector("a")!)).toBe(false);
  });
});
