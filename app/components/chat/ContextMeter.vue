<script setup lang="ts">
import type { ContextUsage } from "~/composables/chat/useChatSession";

const props = defineProps<{
  usage?: Readonly<ContextUsage>;
}>();

// Share of the window above which replies may run out of room.
const WARN_AT = 0.7;
const DANGER_AT = 0.9;

const contextSize = useRuntimeConfig().public.contextWindowTokens;

// The next call sees the last prompt plus the reply it produced.
const tokens = computed(() =>
  props.usage ? props.usage.inputTokens + props.usage.outputTokens : 0,
);
const share = computed(() => Math.min(tokens.value / contextSize, 1));
const percent = computed(() => Math.round((tokens.value / contextSize) * 100));
const room = computed(() => Math.max(contextSize - tokens.value, 0));
const level = computed(() => {
  if (share.value >= DANGER_AT) return "danger";
  if (share.value >= WARN_AT) return "warn";
  return "ok";
});
const stroke = computed(() => ({
  ok: "stroke-leaf",
  warn: "stroke-honey",
  danger: "stroke-clay",
})[level.value]);
const fill = computed(() => ({
  ok: "bg-leaf",
  warn: "bg-honey",
  danger: "bg-clay",
})[level.value]);

const rows = computed(() => {
  const usage = props.usage;
  if (!usage) return [];
  return [
    { label: "Prompt (last model call)", value: usage.inputTokens },
    ...(usage.cacheReadTokens
      ? [{ label: "Reused from cache", value: usage.cacheReadTokens }]
      : []),
    { label: "Last reply", value: usage.outputTokens },
    { label: "Room left", value: room.value },
  ];
});

// A small ring that fills up with the share of the window in use.
const radius = 7;
const circumference = 2 * Math.PI * radius;

// 834 -> "834", 2134 -> "2.1k", 24369 -> "24k". Window sizes are powers of
// two, named the way llama.cpp's -c values are: 65536 -> "64k".
function compact(n: number) {
  if (n < 1000) return String(n);
  if (n % 1024 === 0) return `${n / 1024}k`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

const format = (n: number) => n.toLocaleString("en-US");
</script>

<template>
  <UPopover
    :content="{ side: 'top', align: 'start', sideOffset: 8 }"
    :ui="{ content: 'w-76 rounded-2xl p-4 shadow-xl ring-black/5' }"
  >
    <button
      type="button"
      class="flex h-7 items-center gap-2 rounded-full px-2 text-xs text-muted transition-colors hover:bg-elevated hover:text-highlighted"
      :aria-label="usage
        ? `Context window: ${percent}% used`
        : 'Context window'"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 18 18"
        aria-hidden="true"
      >
        <circle
          cx="9"
          cy="9"
          :r="radius"
          fill="none"
          stroke-width="2.5"
          class="stroke-current opacity-25"
        />
        <circle
          cx="9"
          cy="9"
          :r="radius"
          fill="none"
          stroke-width="2.5"
          stroke-linecap="round"
          :stroke-dasharray="circumference"
          :stroke-dashoffset="circumference * (1 - share)"
          transform="rotate(-90 9 9)"
          class="transition-[stroke-dashoffset]"
          :class="stroke"
        />
      </svg>
      <span class="tabular-nums">
        {{ usage ? compact(tokens) : "–" }} / {{ compact(contextSize) }}
      </span>
    </button>

    <template #content>
      <p class="text-sm font-bold text-highlighted">
        Context window
      </p>

      <template v-if="usage">
        <p class="mt-1 text-sm text-muted">
          <span class="font-semibold text-highlighted tabular-nums">
            {{ format(tokens) }}
          </span>
          of {{ format(contextSize) }} tokens used ({{ percent }}%)
        </p>

        <div class="mt-3 h-2 overflow-hidden rounded-full bg-accented">
          <div
            class="h-full rounded-full transition-[width]"
            :class="fill"
            :style="{ width: `${share * 100}%` }"
          />
        </div>

        <dl class="mt-3 space-y-1.5 text-sm">
          <div
            v-for="row in rows"
            :key="row.label"
            class="flex justify-between gap-4"
          >
            <dt class="text-muted">
              {{ row.label }}
            </dt>
            <dd class="font-semibold text-highlighted tabular-nums">
              {{ format(row.value) }}
            </dd>
          </div>
        </dl>

        <p class="mt-3 border-t border-default pt-3 text-xs leading-relaxed text-muted">
          <template v-if="level === 'danger'">
            Almost full: the agent will summarize older messages to make room.
            Start a new chat to keep full detail.
          </template>
          <template v-else>
            Includes the agent's instructions, tools and memory, not just
            this chat. The last turn took
            {{ usage.turnSteps }} model {{ usage.turnSteps === 1 ? "call" : "calls" }}{{
              usage.modelId ? ` to ${usage.modelId}` : "" }}.
          </template>
        </p>
      </template>

      <p
        v-else
        class="mt-1 text-sm leading-relaxed text-muted"
      >
        {{ format(contextSize) }} tokens available. Usage appears after the
        agent's first reply in this chat.
      </p>
    </template>
  </UPopover>
</template>
