"use client";

import { memo, useMemo, useRef, type ComponentProps } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import { rehypeHighlight } from "@/lib/highlight";
import { splitBlocks } from "@/lib/markdownBlocks";
import remarkGfm from "remark-gfm";
import CopyButton from "./CopyButton";

// react-markdown passes its AST node as a prop; it must not reach the DOM.
type Props<T extends "pre" | "a"> = ComponentProps<T> & ExtraProps;

function Link({ node: _node, ...props }: Props<"a">) {
  return <a {...props} target="_blank" rel="noreferrer" />;
}

function CodeBlock({ children, node: _node, ...props }: Props<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const code = Array.isArray(children) ? children[0] : children;
  const className: string =
    (code as { props?: { className?: string } })?.props?.className ?? "";
  const language = /language-([\w-]+)/.exec(className)?.[1] ?? "text";

  return (
    <div className="my-3 overflow-hidden rounded-xl bg-code">
      <div
        className="flex items-center justify-between px-3.5 py-1.5
          text-xs text-cream-muted"
      >
        <span className="font-mono">{language}</span>
        <CopyButton
          text={() => ref.current?.textContent ?? ""}
          label="Copy code"
          className="rounded-md p-1 transition hover:bg-white/10
            hover:text-cream"
        />
      </div>
      <pre
        ref={ref}
        {...props}
        className="scroll-soft overflow-x-auto px-3.5 pb-3.5 font-mono
          text-[0.84rem] leading-relaxed"
      >
        {children}
      </pre>
    </div>
  );
}

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
const components = { pre: CodeBlock, a: Link };

// Block is memoized on its text, so unchanged blocks skip re-parsing.
const Block = memo(function Block({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
});

function Markdown({ content }: { content: string }) {
  const blocks = useMemo(() => splitBlocks(content), [content]);
  return (
    <div className="prose-chat">
      {blocks.map((text, i) => (
        <Block key={i} text={text} />
      ))}
    </div>
  );
}

export default memo(Markdown);
