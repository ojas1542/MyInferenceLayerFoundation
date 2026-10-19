import { createStore, del, set, values } from "idb-keyval";
import type { Conversation } from "./types";

// Conversations live in IndexedDB rather than localStorage, which is too
// small for attached files.
const store =
  typeof indexedDB === "undefined"
    ? undefined
    : createStore("inference-ui", "conversations");

export async function loadConversations(): Promise<Conversation[]> {
  if (!store) return [];
  const all = await values<Conversation>(store);
  // A generation cut short by a page reload is no longer running.
  for (const c of all) {
    for (const m of c.messages) {
      if (m.pending) {
        m.pending = false;
        m.stopped = true;
      }
    }
  }
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(c: Conversation): Promise<void> {
  if (store) await set(c.id, c, store);
}

export async function deleteConversation(id: string): Promise<void> {
  if (store) await del(id, store);
}
