// Plain-text partitioning: form feeds separate pages, blank lines separate blocks, blocks are classified by rule.
import { classifyBlock, stripListMarker } from "./elements.mjs";

export const MAX_BLOCKS = 100000;

/** Splits text into blocks on blank lines (any whitespace-only line). Returns null when the block bound is exceeded. */
export function blocksOf(text) {
  const blocks = [];
  let current = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
        if (blocks.length > MAX_BLOCKS) return null;
      }
    } else current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks.length > MAX_BLOCKS ? null : blocks;
}

/** Emits the elements of one page of plain text into the builder; returns false when the block bound is exceeded. */
export function emitPlainBlocks(builder, text) {
  const blocks = blocksOf(text);
  if (blocks === null) return false;
  for (const block of blocks) {
    // Once the builder has overflowed (element or byte bound) nothing more can be added; stop instead of classifying the rest.
    if (builder.overflow) return true;
    const type = classifyBlock(block);
    if (type === "ListItem") {
      for (const line of block.split("\n")) {
        if (builder.overflow) return true;
        builder.add("ListItem", stripListMarker(line).trim());
      }
    } else if (type === "Title") builder.add("Title", block.trim(), { category_depth: 0 });
    else if (type === "Address") builder.add("Address", block.split("\n").map((l) => l.trim()).join("\n"));
    else builder.add(type, block.split("\n").map((l) => l.trim()).join("\n"));
  }
  return true;
}

/** Whole plain-text document: pages separated by U+000C. */
export function partitionText(builder, text) {
  const pages = text.split("\f");
  for (let index = 0; index < pages.length; index += 1) {
    if (builder.overflow) return { ok: true };
    if (index > 0) builder.pageBreak();
    if (!emitPlainBlocks(builder, pages[index])) return { ok: false, message: "File has too many text blocks" };
  }
  return { ok: true };
}
