"use client";

import { useEffect, useMemo, useState } from "react";
import { countContext, toApiMessages, type ContextUsage } from "./api";
import type { Attachment, Message } from "./types";

const DEBOUNCE_MS = 350;

// useContextUsage counts the tokens the next request would use: the
// conversation so far plus the message being written. Counting waits
// until typing pauses, and is skipped while a reply streams in, since
// the conversation is still changing.
export function useContextUsage(
  messages: Message[],
  draft: string,
  attachments: Attachment[],
  paused: boolean,
): ContextUsage | null {
  const [usage, setUsage] = useState<ContextUsage | null>(null);

  const body = useMemo(() => {
    const history = toApiMessages(messages);
    if (draft.trim() || attachments.length) {
      history.push(
        ...toApiMessages([
          {
            id: "draft",
            role: "user",
            content: draft.trim(),
            attachments,
            createdAt: 0,
          },
        ]),
      );
    }
    return history;
  }, [messages, draft, attachments]);

  useEffect(() => {
    if (paused) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      countContext(body, controller.signal).then(setUsage, () => {
        // Leave the last count in place; the API may be restarting.
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [body, paused]);

  return usage;
}
