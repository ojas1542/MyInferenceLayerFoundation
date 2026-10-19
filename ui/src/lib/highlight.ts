import type { Element, Root } from "hast";
import { toText } from "hast-util-to-text";
import { common, createLowlight } from "lowlight";
import { visit } from "unist-util-visit";

// One highlighter for the whole app. Creating it registers ~37 grammars,
// which is far too slow to repeat on every render of a streaming message.
const lowlight = createLowlight(common);

// rehypeHighlight highlights code blocks that name a known language.
// Blocks without one are left plain: guessing the language means running
// every grammar, and it would rerun on each streamed token.
export function rehypeHighlight() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, _index, parent) => {
      if (node.tagName !== "code" || parent?.type !== "element") return;
      if (parent.tagName !== "pre") return;
      const lang = language(node);
      if (!lang || !lowlight.registered(lang)) return;
      const result = lowlight.highlight(
        lang,
        toText(node, { whitespace: "pre" }),
      );
      node.children = result.children as Element["children"];
      const classes = node.properties.className;
      node.properties.className = [
        "hljs",
        ...(Array.isArray(classes) ? classes : []),
      ];
    });
  };
}

function language(node: Element): string | undefined {
  const classes = node.properties.className;
  if (!Array.isArray(classes)) return undefined;
  for (const c of classes) {
    const m = /^lang(?:uage)?-(.+)$/.exec(String(c));
    if (m) return m[1];
  }
  return undefined;
}
