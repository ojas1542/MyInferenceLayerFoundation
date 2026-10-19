"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

export default function CopyButton({
  text,
  className = "",
  label = "Copy",
}: {
  text: () => string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; there is nothing useful to do.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      className={className}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}
