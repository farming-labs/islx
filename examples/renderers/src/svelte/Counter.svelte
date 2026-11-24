<script lang="ts">
  import type { CounterProps } from "../counter";

  let { label, start, since, tags }: CounterProps = $props();
  // svelte-ignore state_referenced_locally
  let count = $state(start);
</script>

<button type="button" data-testid={label} onclick={() => count++}>{label} {count}</button>
<output data-testid="{label}-props">{since.toISOString()} a={tags.get("a")}</output>
