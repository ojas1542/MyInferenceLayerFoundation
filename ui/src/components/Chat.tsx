"use client";

import { PanelLeftOpen, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStatus,
  streamGenerate,
  toApiMessages,
  type Status,
} from "@/lib/api";
import {
  deleteConversation,
  loadConversations,
  saveConversation,
} from "@/lib/store";
import type { Attachment, Conversation, Message } from "@/lib/types";
import { useAttachments } from "@/lib/useAttachments";
import { APP_NAME } from "@/lib/brand";
import { useContextUsage } from "@/lib/useContextUsage";
import Composer from "./Composer";
import ContextMeter from "./ContextMeter";
import MessageItem from "./MessageItem";
import Sidebar from "./Sidebar";

const MOBILE_QUERY = "(max-width: 767px)";

export default function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // null follows the screen size: open on desktop, closed on mobile.
  const [sidebarOpen, setSidebarOpen] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState(false);
  const status = useStatus();
  const files = useAttachments();
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const dragDepth = useRef(0);

  useEffect(() => {
    loadConversations().then(setConversations);
  }, []);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const messages = useMemo(() => active?.messages ?? [], [active]);
  const streaming = streamingId !== null;

  // Follow new output, unless the user has scrolled up to read.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const put = useCallback((c: Conversation) => {
    setConversations((prev) => [c, ...prev.filter((x) => x.id !== c.id)]);
  }, []);

  // generate streams an assistant reply onto the end of conv.
  const generate = useCallback(
    async (conv: Conversation, refreshCache = false) => {
      const history = toApiMessages(conv.messages);
      let current: Conversation = {
        ...conv,
        updatedAt: Date.now(),
        messages: [
          ...conv.messages,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            pending: true,
            createdAt: Date.now(),
          },
        ],
      };
      // Tokens can arrive faster than the page can re-render, so streamed
      // text is rendered at most once per frame.
      let frame = 0;
      const render = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        put(current);
      };
      const update = (fn: (m: Message) => Message, nextFrame = false) => {
        const msgs = current.messages.slice();
        msgs[msgs.length - 1] = fn(msgs[msgs.length - 1]);
        current = { ...current, messages: msgs };
        if (!nextFrame) render();
        else if (!frame) frame = requestAnimationFrame(render);
      };
      put(current);
      void saveConversation(current);

      const controller = new AbortController();
      abortRef.current = controller;
      setStreamingId(conv.id);
      stickToBottom.current = true;
      try {
        const done = await streamGenerate(
          history,
          controller.signal,
          ({ text = "", reasoning = "" }) => {
            update(
              (m) => ({
                ...m,
                content: m.content + text,
                reasoning: (m.reasoning ?? "") + reasoning,
              }),
              true,
            );
          },
          refreshCache,
        );
        update((m) => ({
          ...m,
          pending: false,
          stats: {
            promptTokens: done.usage.prompt_tokens,
            completionTokens: done.usage.completion_tokens,
            tokensPerSecond: done.timings?.predicted_per_second,
            cached: done.cached,
            similarity: done.similarity,
          },
        }));
      } catch (err) {
        if (controller.signal.aborted) {
          update((m) => ({ ...m, pending: false, stopped: true }));
        } else {
          const error =
            err instanceof Error ? err.message : "Something went wrong.";
          update((m) => ({ ...m, pending: false, error }));
        }
      } finally {
        abortRef.current = null;
        setStreamingId(null);
        await saveConversation(current);
      }
    },
    [put],
  );

  function send() {
    const text = draft.trim();
    if (streaming || files.loading) return;
    if (!text && files.ready.length === 0) return;

    const message = newUserMessage(text, files.ready);
    const conv: Conversation = active
      ? { ...active, messages: [...active.messages, message] }
      : newConversation(message);
    setActiveId(conv.id);
    setDraft("");
    files.clear();
    void generate(conv);
  }

  function regenerate() {
    if (!active || streaming) return;
    const msgs = active.messages;
    if (msgs.at(-1)?.role !== "assistant") return;
    // A regenerated answer should be new, not the cached one again.
    void generate({ ...active, messages: msgs.slice(0, -1) }, true);
  }

  function newChat() {
    setActiveId(null);
    setDraft("");
    files.clear();
    if (window.matchMedia(MOBILE_QUERY).matches) setSidebarOpen(false);
  }

  function select(id: string) {
    setActiveId(id);
    stickToBottom.current = true;
    if (window.matchMedia(MOBILE_QUERY).matches) setSidebarOpen(false);
  }

  async function remove(id: string) {
    const c = conversations.find((x) => x.id === id);
    if (!c || !window.confirm(`Delete "${c.title}"?`)) return;
    setConversations((prev) => prev.filter((x) => x.id !== id));
    if (activeId === id) setActiveId(null);
    await deleteConversation(id);
  }

  const usage = useContextUsage(messages, draft, files.ready, streaming);
  const tooLong = usage !== null && usage.tokens >= usage.contextSize;
  const canSend =
    !streaming &&
    !files.loading &&
    !tooLong &&
    (draft.trim().length > 0 || files.ready.length > 0);

  const composer = (
    <Composer
      value={draft}
      onChange={setDraft}
      attachments={files.items}
      notices={files.notices}
      onAddFiles={files.add}
      onRemoveAttachment={files.remove}
      onDismissNotice={files.dismiss}
      onSend={send}
      onStop={() => abortRef.current?.abort()}
      streaming={streaming}
      canSend={canSend}
      autoFocus={!active}
      tools={<ContextMeter usage={usage} />}
    />
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {sidebarOpen !== false && (
        <>
          {sidebarOpen && (
            <div
              className="fixed inset-0 z-20 bg-black/30 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
          )}
          <div
            className={`fixed inset-y-0 left-0 z-30 md:static ${
              sidebarOpen === null ? "hidden md:block" : ""
            }`}
          >
            <Sidebar
              conversations={conversations}
              activeId={activeId}
              streamingId={streamingId}
              onSelect={select}
              onNew={newChat}
              onDelete={remove}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </>
      )}

      <main
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (e.dataTransfer.files.length) {
            files.add(Array.from(e.dataTransfer.files));
          }
        }}
      >
        <header className="flex h-14 shrink-0 items-center gap-2 px-3">
          {/* With the sidebar hidden, its controls and the app name move
              up here. */}
          {!sidebarOpen && (
            <div
              className={`flex min-w-0 items-center gap-1 ${
                sidebarOpen === null ? "md:hidden" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                title="Open sidebar"
                aria-label="Open sidebar"
                className="rounded-lg p-2 text-cream-muted transition
                  hover:bg-moss-hover hover:text-cream"
              >
                <PanelLeftOpen size={19} />
              </button>
              <button
                type="button"
                onClick={newChat}
                title="New chat"
                aria-label="New chat"
                className="rounded-lg p-2 text-cream-muted transition
                  hover:bg-moss-hover hover:text-cream"
              >
                <Plus size={19} />
              </button>
              <span className="ml-1.5 truncate font-bold tracking-tight">
                {APP_NAME}
              </span>
            </div>
          )}
          <ModelBadge status={status} />
        </header>

        {messages.length === 0 ? (
          <div
            className="flex flex-1 flex-col items-center justify-center
              px-4 pb-[12vh]"
          >
            <h1
              className="mb-2 text-center text-3xl font-bold tracking-tight
                sm:text-4xl"
            >
              What can I help with?
            </h1>
            <p className="mb-8 text-center text-cream-muted">
              Running locally on your own machine. Attach text files, code or
              PDFs.
            </p>
            <div className="w-full max-w-3xl">{composer}</div>
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className="scroll-soft flex-1 overflow-y-auto"
            >
              <div
                className="mx-auto flex w-full max-w-3xl flex-col gap-6
                  px-4 pt-4 pb-8"
              >
                {messages.map((m, i) => (
                  <MessageItem
                    key={m.id}
                    message={m}
                    // Only the last answer can be regenerated. Leaving the
                    // prop unset elsewhere keeps earlier messages memoized,
                    // so they are not re-rendered on every streamed token.
                    onRegenerate={
                      !streaming &&
                      m.role === "assistant" &&
                      i === messages.length - 1
                        ? regenerate
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
            {/* The gradient fades messages out as they scroll under the
                composer instead of cutting them off. */}
            <div
              className="relative mx-auto w-full max-w-3xl px-4 pb-4
                before:pointer-events-none before:absolute before:inset-x-0
                before:-top-8 before:h-8 before:bg-linear-to-t
                before:from-moss before:to-transparent"
            >
              {composer}
              <p
                className="mt-2 hidden text-center text-xs text-cream-muted
                  sm:block"
              >
                Enter to send · Shift+Enter for a new line
              </p>
            </div>
          </>
        )}

        {dragging && (
          <div
            className="pointer-events-none absolute inset-3 z-10 flex
              flex-col items-center justify-center gap-3 rounded-3xl border-2
              border-dashed border-mint bg-moss-deep/85 text-lg
              font-semibold"
          >
            <Upload size={30} />
            Drop files to attach
          </div>
        )}
      </main>
    </div>
  );
}

function ModelBadge({ status }: { status: Status | null }) {
  const label = !status
    ? "Connecting…"
    : status.healthy
      ? (status.model ?? "Ready")
      : "Offline";
  const dot = !status ? "bg-butter" : status.healthy ? "bg-mint" : "bg-rose";
  return (
    <div
      className="ml-auto flex min-w-0 shrink-0 items-center gap-2
        rounded-full bg-moss-deep px-3 py-1.5 text-sm font-semibold
        sm:shrink"
      title={
        status && !status.healthy
          ? "The inference API or one of its workers isn't reachable"
          : (status?.model ?? undefined)
      }
    >
      <span className={`size-2 shrink-0 rounded-full ${dot}`} />
      {/* On phones only the status dot fits next to the app name. */}
      <span className="hidden truncate sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </div>
  );
}

// useStatus polls the inference API's health so the badge stays current.
function useStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = () =>
      fetchStatus().then((s) => {
        if (alive) setStatus(s);
      });
    poll();
    const id = setInterval(poll, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return status;
}

function newUserMessage(text: string, attachments: Attachment[]): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content: text,
    attachments: attachments.length ? attachments : undefined,
    createdAt: Date.now(),
  };
}

function newConversation(first: Message): Conversation {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: titleFor(first.content, first.attachments ?? []),
    createdAt: now,
    updatedAt: now,
    messages: [first],
  };
}

function titleFor(text: string, attachments: Attachment[]): string {
  const source = text || attachments[0]?.name || "New chat";
  const line = source.split("\n")[0].trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
