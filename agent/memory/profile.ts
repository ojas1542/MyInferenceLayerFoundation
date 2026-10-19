import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";
import { internalMemoryBackend } from "../lib/memory-internal.js";

export default defineMemory({
  description: "Stable facts and preferences about the person you are talking to.",
  // eve's default namespace hashes the app root, which `eve dev` points at a
  // fresh snapshot directory on every restart, so memories saved before a
  // restart would no longer be recalled. A fixed name keeps one memory per
  // user across restarts and deploys.
  namespace: "personal-agent/profile",
  provider: fileMemory({ backend: internalMemoryBackend }),
  scope: byPrincipal,
});
