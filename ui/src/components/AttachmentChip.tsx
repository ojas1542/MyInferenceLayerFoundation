import { FileText, LoaderCircle, X } from "lucide-react";
import { formatBytes } from "@/lib/files";

export default function AttachmentChip({
  name,
  size,
  loading = false,
  onRemove,
}: {
  name: string;
  size: number;
  loading?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div
      className="flex max-w-60 items-center gap-2 rounded-xl bg-sky py-1.5
        pr-2 pl-2.5 text-ink"
    >
      {loading ? (
        <LoaderCircle size={16} className="shrink-0 animate-spin" />
      ) : (
        <FileText size={16} className="shrink-0" />
      )}
      <div className="min-w-0 leading-tight">
        <div className="truncate text-sm font-semibold" title={name}>
          {name}
        </div>
        <div className="text-xs text-ink-muted">
          {loading ? "Reading…" : formatBytes(size)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          className="ml-1 shrink-0 rounded-md p-0.5 text-ink-muted
            transition hover:bg-white/60 hover:text-ink"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
