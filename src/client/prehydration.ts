/**
 * Holding interactions that happen before the islx script has run. An inline script in the page
 * captures a click or a submit on an island that has not hydrated (it is prevented and queued),
 * and announces a pointerdown or a focus (which go through). The runtime then hydrates those
 * islands first and replays what was held.
 *
 * The script is inlined into every page, so it stays hand-minified and imports nothing.
 */

/** Where the inline script queues held interactions: `{ target, kind }`. */
export const PENDING_INTERACTIONS = "__islxPending";
/** The DOM event the script dispatches for each interaction it sees. */
export const INTERACTION_EVENT = "f:island-interaction";
/** Elements whose click is held and replayed rather than merely observed. */
export const REPLAYABLE_SELECTOR =
  'button,[role="button"],input[type="button"],input[type="submit"],input[type="reset"]';

export interface PendingInteraction {
  target: Element;
  kind: "click" | "submit" | null;
}

/** The inline script's source (no `<script>` tag): pass it to the page's head or bootstrap. */
export const PREHYDRATION_SCRIPT = `(function(){if(window.${PENDING_INTERACTIONS})return;var q=window.${PENDING_INTERACTIONS}=[];function island(n){var i=n&&n.closest&&n.closest("f-island");return i&&!i.hasAttribute("hydrated")?i:null}function tell(t,k){document.dispatchEvent(new CustomEvent("${INTERACTION_EVENT}",{detail:{target:t,kind:k}}))}function hold(e,t,k){if(!q.some(function(p){return p.target===t})){q.push({target:t,kind:k});tell(t,k)}e.preventDefault();e.stopImmediatePropagation()}document.addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.altKey||e.ctrlKey||e.shiftKey)return;var t=e.target&&e.target.closest&&e.target.closest(${JSON.stringify(REPLAYABLE_SELECTOR)});if(!t||t.closest("a[href]")||!island(t))return;hold(e,t,"click")},true);document.addEventListener("submit",function(e){var f=e.target;if(e.defaultPrevented||!f||f.nodeName!=="FORM"||!island(f))return;hold(e,f,"submit")},true);function seen(e){if(island(e.target))tell(e.target,null)}document.addEventListener("pointerdown",seen,true);document.addEventListener("focusin",seen,true)})();`;

/** Takes the interactions the inline script held inside `container`, oldest first. */
export function takePendingInteractions(container: Element): PendingInteraction[] {
  const queue = (globalThis as unknown as Record<string, PendingInteraction[] | undefined>)[
    PENDING_INTERACTIONS
  ];
  if (!Array.isArray(queue)) return [];
  const taken: PendingInteraction[] = [];
  for (let index = queue.length - 1; index >= 0; index--) {
    const item = queue[index];
    if (!(item?.target instanceof Element) || !container.contains(item.target)) continue;
    queue.splice(index, 1);
    taken.unshift(item);
  }
  return taken;
}

/** Whether the inline script holds an interaction inside `container`. */
export function hasPendingInteraction(container: Element): boolean {
  const queue = (globalThis as unknown as Record<string, PendingInteraction[] | undefined>)[
    PENDING_INTERACTIONS
  ];
  return (
    Array.isArray(queue) &&
    queue.some((item) => item?.target instanceof Element && container.contains(item.target))
  );
}
