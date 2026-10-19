"use client";

import {
  ChevronDown,
  CircleAlert,
  Brain,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { memo, useState } from "react";
import type { Message, Stats } from "@/lib/types";
import AttachmentChip from "./AttachmentChip";
import CopyButton from "./CopyButton";
import Markdown from "./Markdown";

const actionClass =
  "rounded-lg p-1.5 text-cream-muted transition hover:bg-moss-hover " +
  "hover:text-cream disabled:opacity-40";

function MessageItem({
  message,
  onRegenerate,
}: {
  message: Message;
  onRegenerate?: () => void;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end gap-2">
        {message.attachments?.length ? (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
            {message.attachments.map((a) => (
              <AttachmentChip key={a.id} name={a.name} size={a.size} />
            ))}
          </div>
        ) : null}
        {message.content && (
          // The copy button sits beside the bubble so it takes no
          // vertical space while hidden.
          <div className="flex max-w-[85%] items-center gap-1">
            <CopyButton
              text={() => message.content}
              className={`${actionClass} shrink-0 opacity-0
                group-hover:opacity-100 focus-visible:opacity-100`}
            />
            <div
              className="min-w-0 rounded-2xl rounded-br-md bg-peach px-4
                py-2.5 whitespace-pre-wrap text-ink"
            >
              {message.content}
            </div>
          </div>
        )}
      </div>
    );
  }

  const waiting = message.pending && !message.content && !message.reasoning;
  return (
    <div className="group flex flex-col gap-1.5">
      <div className="rounded-2xl rounded-bl-md bg-sage px-5 py-4 text-ink">
        {message.reasoning && (
          <Reasoning
            text={message.reasoning}
            thinking={!!message.pending && !message.content}
          />
        )}
        {waiting && <TypingDots />}
        {message.content && <Markdown content={message.content} />}
        {message.error && (
          <div
            className="mt-1 flex items-start gap-2 rounded-xl bg-rose px-3.5
              py-2.5 text-sm"
          >
            <CircleAlert size={17} className="mt-0.5 shrink-0" />
            <span>{message.error}</span>
          </div>
        )}
        {message.stopped && (
          <div className="mt-2 text-sm text-ink-muted italic">Stopped</div>
        )}
      </div>
      {!message.pending && (
        <div className="flex flex-wrap items-center gap-1">
          {message.content && (
            <CopyButton text={() => message.content} className={actionClass} />
          )}
          {onRegenerate && (
            <button
              type="button"
              onClick={onRegenerate}
              title="Regenerate"
              aria-label="Regenerate"
              className={actionClass}
            >
              <RefreshCw size={15} />
            </button>
          )}
          {message.stats && <StatsLine stats={message.stats} />}
        </div>
      )}
    </div>
  );
}

function Reasoning({ text, thinking }: { text: string; thinking: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 rounded-xl bg-lavender last:mb-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-sm
          font-semibold"
      >
        <Brain size={16} className={thinking ? "animate-pulse" : ""} />
        {thinking ? "Thinking…" : "Thoughts"}
        <ChevronDown
          size={16}
          className={`ml-auto transition ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div
          className="scroll-soft max-h-80 overflow-y-auto px-3.5 pb-3
            text-sm whitespace-pre-wrap text-ink-muted"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex gap-1.5 py-1.5" aria-label="Generating">
      {[0, 1, 2].map((i) => (
        <span key={i} className="typing-dot size-2 rounded-full bg-ink-muted" />
      ))}
    </div>
  );
}

function StatsLine({ stats }: { stats: Stats }) {
  if (stats.cached) {
    const match =
      stats.similarity !== undefined && stats.similarity < 1
        ? ` · ${Math.round(stats.similarity * 100)}% match`
        : "";
    return (
      <span
        className="ml-1 inline-flex items-center gap-1 rounded-full bg-butter
          px-2.5 py-0.5 text-xs font-semibold text-ink"
        title="Answered from the semantic cache"
      >
        <Sparkles size={12} />
        Cached{match}
      </span>
    );
  }
  return (
    <span className="ml-1 text-xs text-cream-muted">
      {stats.completionTokens} tokens
      {stats.tokensPerSecond
        ? ` · ${stats.tokensPerSecond.toFixed(1)} t/s`
        : ""}
    </span>
  );
}

export default memo(MessageItem);
