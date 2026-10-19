import {
  MemoryDocumentConflictError,
  type MemoryDocument,
  type MemoryDocumentBackend,
} from "eve/memory/file";
import { appOrigin, internalHeaders } from "./internal-api.js";

/**
 * fileMemory() backend that keeps memory documents in the app's Postgres
 * database through the internal API, so memory persists without Vercel
 * Blob, both locally and when deployed.
 */
export const internalMemoryBackend: MemoryDocumentBackend = {
  async read({ key, signal }) {
    const response = await fetch(
      `${appOrigin()}/api/internal/memory?key=${encodeURIComponent(key)}`,
      { headers: internalHeaders(), signal },
    );
    if (!response.ok) {
      throw new Error(`Memory read failed: ${response.status}`);
    }

    const { document } = await response.json() as { document: MemoryDocument | null };
    return document;
  },

  async write({ key, content, expectedVersion, signal }) {
    const response = await fetch(`${appOrigin()}/api/internal/memory`, {
      method: "PUT",
      headers: internalHeaders(),
      body: JSON.stringify({ key, content, expectedVersion }),
      signal,
    });
    if (response.status === 409) {
      throw new MemoryDocumentConflictError(key);
    }
    if (!response.ok) {
      throw new Error(`Memory write failed: ${response.status}`);
    }

    const { document } = await response.json() as { document: MemoryDocument };
    return document;
  },
};
