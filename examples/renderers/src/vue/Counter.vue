<script setup lang="ts">
import { ref } from "vue";

const props = defineProps<{ label: string; start: number; since: Date; tags: Map<string, number> }>();
const count = ref(props.start);
</script>

<template>
  <button type="button" :data-testid="label" @click="count++">{{ label }} {{ count }}</button>
  <output :data-testid="`${label}-props`">{{ since.toISOString() }} a={{ tags.get("a") }}</output>
</template>
