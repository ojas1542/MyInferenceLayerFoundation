"use client";

import { ArrowUp, CircleAlert, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { Notice, PendingAttachment } from "@/lib/useAttachments";
import AttachmentChip from "./AttachmentChip";

export default function Composer({
  value,
  onChange,
  attachments,
  notices,
  onAddFiles,
  onRemoveAttachment,
  onDismissNotice,
  onSend,
  onStop,
  streaming,
  canSend,
  autoFocus,
  tools,
}: {
  value: string;
  onChange: (v: string) => void;
  attachments: PendingAttachment[];
  notices: Notice[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onDismissNotice: (id: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  canSend: boolean;
  autoFocus?: boolean;
  // Extra controls shown next to the attach button.
  tools?: ReactNode;
}) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // Grow with the text, up to a limit after which the box scrolls.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }

  return (
    <div className="w-full">
      {notices.length > 0 && (
        <div className="mb-2 flex flex-col gap-1.5">
          {notices.map((n) => (
            <div
              key={n.id}
              role="alert"
              className="flex items-start gap-2 rounded-xl bg-rose px-3.5
                py-2 text-sm text-ink"
            >
              <CircleAlert size={16} className="mt-0.5 shrink-0" />
              <span className="flex-1">{n.text}</span>
              <button
                type="button"
                onClick={() => onDismissNotice(n.id)}
                aria-label="Dismiss"
                className="rounded-md p-0.5 hover:bg-white/60"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className="rounded-3xl bg-cream p-2.5 text-ink shadow-lg
          shadow-black/10 ring-1 ring-black/5 transition
          focus-within:ring-2 focus-within:ring-mint-deep"
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-1 pt-1 pb-2">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                name={a.name}
                size={a.size}
                loading={!a.attachment}
                onRemove={() => onRemoveAttachment(a.id)}
              />
            ))}
          </div>
        )}

        <textarea
          ref={textarea}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              onAddFiles(files);
            }
          }}
          rows={1}
          placeholder="Ask anything, or attach a file…"
          aria-label="Message"
          className="scroll-soft block w-full resize-none bg-transparent
            px-2.5 py-1.5 text-[0.975rem] leading-relaxed outline-none
            placeholder:text-ink-muted/80"
        />

        <div className="mt-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            title="Attach files"
            aria-label="Attach files"
            className="flex size-9 items-center justify-center rounded-full
              text-ink-muted transition hover:bg-sage-deep hover:text-ink"
          >
            <Paperclip size={18} />
          </button>
          {tools}
          <div className="flex-1" />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) onAddFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />

          {streaming ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop"
              aria-label="Stop generating"
              className="flex size-9 items-center justify-center rounded-full
                bg-peach text-ink transition hover:brightness-95"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={!canSend}
              title="Send"
              aria-label="Send message"
              className="flex size-9 items-center justify-center rounded-full
                bg-mint-deep text-ink transition hover:brightness-95
                disabled:bg-sage-deep disabled:text-ink-muted/70"
            >
              <ArrowUp size={19} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
