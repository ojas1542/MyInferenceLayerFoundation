<script setup lang="ts">
import { startNewChat } from "~/composables/chat/navigation";
import { useThreadList } from "~/composables/chat/useThreads";

const site = useSite();

const sidebarOpen = ref(false);
const searchOpen = ref(false);

const { threads, pending, refresh } = useThreadList();

const searchGroups = computed(() => [
  {
    id: "actions",
    label: "Actions",
    items: [
      {
        label: "New chat",
        to: "/",
        icon: "i-lucide-circle-plus",
        kbds: ["meta", "o"],
        onSelect: () => startNewChat(),
      },
    ],
  },
  ...(threads.value.length
    ? [{
        id: "threads",
        label: "Recent chats",
        items: threads.value.map(thread => ({
          label: thread.title,
          to: `/chat/${thread.id}`,
          icon: "i-lucide-message-square",
        })),
      }]
    : []),
]);

defineShortcuts({
  meta_o: () => startNewChat(),
  meta_k: () => {
    searchOpen.value = true;
  },
});
</script>

<template>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      v-model:open="sidebarOpen"
      :min-size="12"
      collapsible
      resizable
      :menu="{ inset: true }"
      class="on-photo border-r-0 py-4"
    >
      <template #header="{ collapsed }">
        <NuxtLink
          to="/"
          class="flex min-w-0 items-center gap-2.5"
          :class="collapsed ? 'mx-auto' : 'px-1'"
        >
          <AppLogo />
          <span
            v-if="!collapsed"
            class="truncate font-bold tracking-tight text-highlighted"
          >
            {{ site.name }}
          </span>
        </NuxtLink>

        <UDashboardSidebarCollapse
          v-if="!collapsed"
          class="ms-auto"
        />
      </template>

      <template #default="{ collapsed }">
        <UNavigationMenu
          :items="[
            {
              label: 'New chat',
              icon: 'i-lucide-circle-plus',
              kbds: ['meta', 'o'],
              onSelect: () => startNewChat(),
            },
            {
              label: 'Search',
              icon: 'i-lucide-search',
              kbds: ['meta', 'k'],
              onSelect: () => {
                searchOpen = true;
              },
            },
          ]"
          :collapsed="collapsed"
          orientation="vertical"
        >
          <template #item-trailing="{ item }">
            <div
              v-if="item.kbds?.length"
              class="flex items-center gap-px opacity-0 transition-opacity group-hover:opacity-100"
            >
              <UKbd
                v-for="kbd in item.kbds"
                :key="kbd"
                :value="kbd"
                size="sm"
                variant="soft"
                class="bg-accented/50"
              />
            </div>
          </template>
        </UNavigationMenu>

        <ChatThreadList
          v-if="!collapsed"
          class="mt-4 min-h-0 flex-1"
          :threads="threads"
          :pending="pending"
          @refresh="refresh()"
        />
      </template>

      <template #footer />
    </UDashboardSidebar>

    <UDashboardSearch
      v-model:open="searchOpen"
      placeholder="Search chats and actions..."
      :groups="searchGroups"
    />

    <div
      class="m-2 flex min-w-0 flex-1 overflow-hidden glass rounded-2xl shadow-xl lg:ml-0"
    >
      <slot />
    </div>
  </UDashboardGroup>
</template>
