<script setup lang="ts">
import { authClient } from "~/lib/auth-client";

definePageMeta({
  layout: false,
  prerender: true,
});

const site = useSite();

const route = useRoute();
const mode = ref<"sign-in" | "sign-up">("sign-in");
const email = ref("");
const password = ref("");
const name = ref("");
const error = ref("");
const loading = ref(false);

const highlights = [
  { icon: "i-lucide-message-square", label: "Web chat" },
  { icon: "i-lucide-smartphone", label: "iMessage" },
  { icon: "i-lucide-brain", label: "Long-term memory" },
  { icon: "i-lucide-cpu", label: "Local model" },
];

const redirectTo = computed(() => {
  const value = route.query.redirect;
  return typeof value === "string" && value.startsWith("/") ? value : "/";
});

async function handleSubmit() {
  error.value = "";
  loading.value = true;

  try {
    if (mode.value === "sign-up") {
      const result = await authClient.signUp.email({
        email: email.value,
        password: password.value,
        name: name.value || email.value.split("@")[0] || "User",
      });

      if (result.error) {
        error.value = result.error.message ?? "Sign up failed.";
        return;
      }
    }
    else {
      const result = await authClient.signIn.email({
        email: email.value,
        password: password.value,
      });

      if (result.error) {
        error.value = result.error.message ?? "Sign in failed.";
        return;
      }
    }

    await navigateTo(redirectTo.value);
  }
  finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-svh flex-col-reverse text-default lg:flex-row">
    <section class="flex flex-1 items-center justify-center px-6 py-10 lg:px-12 lg:py-8">
      <div class="w-full max-w-sm">
        <UCard class="w-full rounded-2xl shadow-xl ring-white/15">
          <template #header>
            <h2 class="text-lg font-semibold text-highlighted">
              {{ mode === "sign-in" ? "Sign in" : "Create account" }}
            </h2>
          </template>

          <form
            class="space-y-4"
            @submit.prevent="handleSubmit"
          >
            <UFormField
              v-if="mode === 'sign-up'"
              label="Name"
            >
              <UInput
                v-model="name"
                class="w-full"
                autocomplete="name"
                placeholder="Your name"
              />
            </UFormField>

            <UFormField label="Email">
              <UInput
                v-model="email"
                class="w-full"
                type="email"
                autocomplete="email"
                required
                placeholder="you@example.com"
              />
            </UFormField>

            <UFormField label="Password">
              <UInput
                v-model="password"
                class="w-full"
                type="password"
                autocomplete="current-password"
                required
                minlength="8"
                placeholder="••••••••"
              />
            </UFormField>

            <p
              v-if="error"
              class="text-sm text-error"
            >
              {{ error }}
            </p>

            <UButton
              type="submit"
              block
              color="neutral"
              :loading="loading"
            >
              {{ mode === "sign-in" ? "Sign in" : "Create account" }}
            </UButton>
          </form>

          <template #footer>
            <p class="text-center text-sm text-muted">
              <button
                type="button"
                class="text-highlighted hover:underline"
                @click="mode = mode === 'sign-in' ? 'sign-up' : 'sign-in'"
              >
                {{
                  mode === "sign-in"
                    ? "Need an account? Sign up"
                    : "Already have an account? Sign in"
                }}
              </button>
            </p>
          </template>
        </UCard>
      </div>
    </section>

    <section class="on-photo relative flex flex-1 flex-col px-6 py-6 sm:px-8 lg:px-12 lg:py-8">
      <header class="flex items-center">
        <AppLogo />
      </header>

      <div class="flex flex-1 flex-col justify-center py-10 lg:py-16">
        <div class="max-w-md space-y-5">
          <div class="space-y-3">
            <h1 class="text-3xl font-bold tracking-tight text-highlighted sm:text-4xl">
              {{ site.name }}
            </h1>
            <p class="text-sm leading-relaxed text-toned sm:text-base">
              {{ site.description }}
            </p>
          </div>

          <ul class="flex flex-wrap gap-x-5 gap-y-2">
            <li
              v-for="item in highlights"
              :key="item.label"
              class="flex items-center gap-1.5 text-xs text-toned"
            >
              <UIcon
                :name="item.icon"
                class="size-3.5 shrink-0"
              />
              {{ item.label }}
            </li>
          </ul>
        </div>
      </div>

      <footer class="flex flex-wrap items-center gap-x-4 gap-y-3 pt-6">
        <p class="text-xs text-dimmed">
          Built with
          <NuxtLink
            to="https://vercel.com/eve"
            target="_blank"
            class="text-muted underline-offset-2 hover:text-highlighted hover:underline"
          >
            Eve
          </NuxtLink>
          on Vercel
        </p>
      </footer>
    </section>
  </div>
</template>
