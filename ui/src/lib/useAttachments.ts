"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { AttachmentError, readAttachment } from "./files";
import type { Attachment } from "./types";

export type PendingAttachment = {
  id: string;
  name: string;
  size: number;
  attachment?: Attachment; // set once the file has been read
};

export type Notice = { id: string; text: string };

// useAttachments tracks files added to the composer while they are read,
// and collects notices for files that can't be attached.
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  // Lets a file that finishes reading after removal be dropped.
  const removed = useRef(new Set<string>());

  const dismiss = useCallback((id: string) => {
    setNotices((ns) => ns.filter((n) => n.id !== id));
  }, []);

  const notify = useCallback(
    (text: string) => {
      const id = crypto.randomUUID();
      setNotices((ns) => [...ns, { id, text }]);
      setTimeout(() => dismiss(id), 7000);
    },
    [dismiss],
  );

  const add = useCallback(
    (files: Iterable<File>) => {
      for (const file of files) {
        const id = crypto.randomUUID();
        setItems((xs) => [...xs, { id, name: file.name, size: file.size }]);
        readAttachment(file).then(
          (attachment) => {
            if (removed.current.has(id)) return;
            setItems((xs) =>
              xs.map((x) => (x.id === id ? { ...x, attachment } : x)),
            );
          },
          (err: unknown) => {
            setItems((xs) => xs.filter((x) => x.id !== id));
            notify(
              err instanceof AttachmentError
                ? err.message
                : `${file.name} couldn't be read.`,
            );
          },
        );
      }
    },
    [notify],
  );

  const remove = useCallback((id: string) => {
    removed.current.add(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const loading = items.some((x) => !x.attachment);
  // Memoized so consumers can depend on it without re-running each render.
  const ready = useMemo(
    () => items.flatMap((x) => (x.attachment ? [x.attachment] : [])),
    [items],
  );

  return { items, ready, loading, notices, add, remove, clear, dismiss };
}
