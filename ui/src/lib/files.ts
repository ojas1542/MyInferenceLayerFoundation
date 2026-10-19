import type { Attachment } from "./types";

// The model's context window is 16k tokens, roughly 64 KB of text, so
// larger files are rejected up front rather than failing on send.
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class AttachmentError extends Error {}

// readAttachment turns a file into text the model can read. Text and
// code files are used as is; PDFs have their text extracted.
export async function readAttachment(file: File): Promise<Attachment> {
  if (file.type.startsWith("image/")) {
    throw new AttachmentError(
      `${file.name}: images aren't supported, the model only reads text.`,
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AttachmentError(
      `${file.name} is ${formatBytes(file.size)}; the limit is ` +
        `${formatBytes(MAX_FILE_BYTES)}.`,
    );
  }

  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  const content = isPdf
    ? await extractPdfText(file)
    : decodeText(file.name, await file.arrayBuffer());
  if (!content.trim()) {
    throw new AttachmentError(
      isPdf
        ? `${file.name} has no extractable text (is it a scanned PDF?).`
        : `${file.name} is empty.`,
    );
  }
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    content,
  };
}

function decodeText(name: string, buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.subarray(0, 8192).includes(0)) {
    throw new AttachmentError(`${name} looks like a binary file.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentError(`${name} isn't valid UTF-8 text.`);
  }
}

async function extractPdfText(file: File): Promise<string> {
  // pdf.js needs browser APIs, so it is only loaded when a PDF is added.
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch {
      throw new AttachmentError(`${file.name} couldn't be read as a PDF.`);
    }
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const text = await page.getTextContent();
      pages.push(
        text.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "",
          )
          .join(""),
      );
    }
    return pages.join("\n\n");
  } finally {
    await task.destroy();
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
