// splitBlocks splits markdown at blank lines that are outside fenced code,
// so each top-level block can be parsed and rendered on its own. While a
// reply streams in, only its last block changes; the earlier ones can
// then skip re-parsing, which keeps rendering cost flat as replies grow.
export function splitBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;

  for (const line of markdown.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    }
    if (fence === null && line.trim() === "") {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}
