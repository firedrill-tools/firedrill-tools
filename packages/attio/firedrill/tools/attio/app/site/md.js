// Minimal, safe Markdown renderer for note bodies: builds DOM nodes (textContent only), never innerHTML.
import { el } from "./ui.js";

function inline(text) {
  const out = document.createDocumentFragment();
  let i = 0;
  let buffer = "";
  const flush = () => { if (buffer) { out.append(document.createTextNode(buffer)); buffer = ""; } };
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) { buffer += text[i + 1]; i += 2; continue; }
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) { flush(); out.append(el("strong", {}, inline(text.slice(i + 2, end)))); i = end + 2; continue; }
    }
    if ((c === "*" || c === "_") && text[i + 1] !== c) {
      const end = text.indexOf(c, i + 1);
      if (end > i + 1) { flush(); out.append(el("em", {}, inline(text.slice(i + 1, end)))); i = end + 1; continue; }
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) { flush(); out.append(el("code", { text: text.slice(i + 1, end) })); i = end + 1; continue; }
    }
    if (c === "[") {
      const close = text.indexOf("](", i);
      const end = close === -1 ? -1 : text.indexOf(")", close + 2);
      if (close > i && end > close) {
        const href = text.slice(close + 2, end);
        flush();
        const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
        out.append(safe ? el("a", { text: text.slice(i + 1, close), title: href, attrs: { href, target: "_blank", rel: "noopener noreferrer" } }) : el("span", { text: text.slice(i + 1, close) }));
        i = end + 1;
        continue;
      }
    }
    buffer += c;
    i += 1;
  }
  flush();
  return out;
}

export function renderMarkdown(source) {
  const root = el("div", { class: "at-md" });
  const lines = String(source ?? "").split("\n");
  let list;
  let paragraph = [];
  const endParagraph = () => { if (paragraph.length) { root.append(el("p", {}, inline(paragraph.join(" ")))); paragraph = []; } };
  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (bullet || numbered) {
      endParagraph();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag); root.append(list); }
      list.append(el("li", {}, inline((bullet ?? numbered)[1])));
      continue;
    }
    list = undefined;
    if (line.trim() === "") { endParagraph(); continue; }
    if (heading) { endParagraph(); root.append(el(`h${heading[1].length}`, {}, inline(heading[2]))); continue; }
    if (quote) { endParagraph(); root.append(el("blockquote", {}, inline(quote[1]))); continue; }
    paragraph.push(line);
  }
  endParagraph();
  return root;
}
