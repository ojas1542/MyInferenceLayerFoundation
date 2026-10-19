"use client";

import { Leaf, PanelLeftClose, Plus, Trash2 } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import type { Conversation } from "@/lib/types";

export default function Sidebar({
  conversations,
  activeId,
  streamingId,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  conversations: Conversation[];
  activeId: string | null;
  streamingId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <aside
      className="flex h-full w-72 flex-col border-r border-moss-line/60
        bg-moss-deep"
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <div
          className="flex size-8 shrink-0 items-center justify-center
            rounded-xl bg-mint text-ink"
        >
          <Leaf size={17} />
        </div>
        <span className="leading-tight font-bold tracking-tight">
          {APP_NAME}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="Close sidebar"
          aria-label="Close sidebar"
          className="ml-auto shrink-0 rounded-lg p-1.5 text-cream-muted
            transition hover:bg-moss-hover hover:text-cream"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>

      <div className="px-3 pb-3">
        <button
          type="button"
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2
            rounded-xl bg-mint py-2.5 font-semibold text-ink transition
            hover:bg-mint-deep"
        >
          <Plus size={18} strokeWidth={2.4} />
          New chat
        </button>
      </div>

      <nav
        aria-label="Conversations"
        className="scroll-soft flex-1 overflow-y-auto px-3 pb-4"
      >
        {conversations.length === 0 ? (
          <p className="px-2 pt-2 text-sm text-cream-muted">
            No conversations yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? "page" : undefined}
                    className={`flex w-full items-center gap-2 rounded-xl
                      py-2 pr-9 pl-3 text-left text-[0.925rem] transition
                      ${
                        active
                          ? "bg-sage text-ink"
                          : "text-cream hover:bg-moss-hover"
                      }`}
                  >
                    {c.id === streamingId && (
                      <span
                        className={`size-2 shrink-0 animate-pulse
                          rounded-full ${active ? "bg-moss" : "bg-mint"}`}
                        aria-label="Generating"
                      />
                    )}
                    <span className="truncate">{c.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c.id)}
                    disabled={c.id === streamingId}
                    title="Delete conversation"
                    aria-label={`Delete ${c.title}`}
                    className={`absolute top-1/2 right-1.5 -translate-y-1/2
                      rounded-lg p-1.5 opacity-0 transition
                      group-hover:opacity-100 focus:opacity-100
                      disabled:hidden ${
                        active
                          ? "text-ink-muted hover:bg-sage-deep hover:text-ink"
                          : "text-cream-muted hover:bg-moss-line/60 " +
                            "hover:text-cream"
                      }`}
                  >
                    <Trash2 size={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </aside>
  );
}
