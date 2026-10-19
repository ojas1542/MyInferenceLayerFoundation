"use client";

import { useEffect, useRef, useState } from "react";
import type { ContextUsage } from "@/lib/api";

// Share of the window above which the reply may run out of room.
const WARN_AT = 0.7;
const DANGER_AT = 0.9;

// ContextMeter shows how much of the model's context window the next
// request would use, with details in a popover.
export default function ContextMeter({
  usage,
}: {
  usage: ContextUsage | null;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!usage) return null;
  const { tokens, contextSize } = usage;
  const share = Math.min(tokens / contextSize, 1);
  const level =
    share >= DANGER_AT ? "danger" : share >= WARN_AT ? "warn" : "ok";
  const stroke = {
    ok: "stroke-leaf",
    warn: "stroke-honey",
    danger: "stroke-clay",
  }[level];
  const fill = { ok: "bg-leaf", warn: "bg-honey", danger: "bg-clay" }[level];
  const room = Math.max(contextSize - tokens, 0);
  // Unlike the bar, the percentage shows how far over the window it is.
  const percent = Math.round((tokens / contextSize) * 100);

  // A small ring that fills up with the share of the window in use.
  const r = 7;
  const circumference = 2 * Math.PI * r;

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Context window: ${percent}% used`}
        className="flex h-9 items-center gap-2 rounded-full px-2.5 text-sm
          text-ink-muted transition hover:bg-sage-deep hover:text-ink"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            strokeWidth="2.5"
            className="stroke-sage-deep"
          />
          <circle
            cx="9"
            cy="9"
            r={r}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - share)}
            transform="rotate(-90 9 9)"
            className={`${stroke} transition-[stroke-dashoffset]`}
          />
        </svg>
        <span className="tabular-nums">
          {compact(tokens)} / {compact(contextSize)}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Context window usage"
          className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-2xl
            bg-cream p-4 text-ink shadow-xl shadow-black/15 ring-1
            ring-black/5"
        >
          <div className="text-sm font-bold">Context window</div>
          <div className="mt-1 text-sm text-ink-muted">
            <span className="font-semibold text-ink tabular-nums">
              {tokens.toLocaleString("en-US")}
            </span>{" "}
            of {contextSize.toLocaleString("en-US")} tokens used ({percent}%)
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sage-deep">
            <div
              className={`h-full rounded-full ${fill} transition-[width]`}
              style={{ width: `${share * 100}%` }}
            />
          </div>
          <dl className="mt-3 flex justify-between text-sm">
            <dt className="text-ink-muted">Room left for the reply</dt>
            <dd className="font-semibold tabular-nums">
              {room.toLocaleString("en-US")}
            </dd>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-ink-muted">
            {level === "danger"
              ? tokens >= contextSize
                ? "This is too long to send. Remove an attachment or " +
                  "start a new chat."
                : "Almost full: the reply may be cut short. Consider " +
                  "starting a new chat."
              : "Counts this chat's history, attached files and your " +
                "draft, as the model sees them."}
          </p>
        </div>
      )}
    </div>
  );
}

// 834 -> "834", 2134 -> "2.1k", 16384 -> "16k"
function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n >= 10000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}
