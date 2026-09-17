// Inline text toolbar shown over a text selection inside an editable block, as in the product.
// Editing writes one plain rich-text run (see README), so marks, links, colors, AI and turn-into are shown in place and
// open a "Not simulated by this Tool" panel. Comment opens the block's discussions, which the Tool serves.
import { el, notSimulated } from "./ui.js";
import { icon } from "./icons.js";

const handlers = new WeakMap();
let bar;
let current;

/** Register an editable block element with its in-scope actions ({ openComments }). */
export function registerFormatTarget(element, actions) {
  handlers.set(element, actions);
  install();
}

const MARKS_TEXT = "Bold, italic, underline, strikethrough, inline code and colors are rich-text annotations. This app writes an edited block back as one plain text run, so formatting from the toolbar is not simulated by this Tool.";

function glyphButton(label, text, className, shortcut, note) {
  const button = el("button", { class: `format-btn ${className}`.trim(), title: shortcut ? `${label} ${shortcut}` : label, attrs: { type: "button", "aria-label": label } });
  if (text) button.append(el("span", { class: "format-glyph", text }));
  button.addEventListener("click", () => notSimulated(button, label, note ?? MARKS_TEXT));
  return button;
}

function build() {
  const element = el("div", { class: "format-bar", attrs: { role: "toolbar", "aria-label": "Text formatting" } });
  const ai = glyphButton("Ask AI", "", "format-ai", "", "Notion AI editing is not part of the API subset this Tool serves.");
  ai.append(icon("ai"), el("span", { class: "format-label", text: "Ask AI" }));
  const turn = glyphButton("Turn into", "", "format-turn", "", "Changing a block's type in place is not part of the API subset this Tool serves; use / to insert a new block.");
  turn.append(el("span", { class: "format-label", text: "Text" }), icon("chevron_down", "format-caret"));
  const link = glyphButton("Link", "", "", "⌘K", "Links are rich-text annotations; this app writes edited blocks as plain text, so adding a link is not simulated by this Tool.");
  link.append(icon("link"));
  const comment = el("button", { class: "format-btn format-comment", title: "Comment ⌘⇧M", attrs: { type: "button", "aria-label": "Comment" } }, [icon("comment"), el("span", { class: "format-label", text: "Comment" })]);
  comment.addEventListener("click", () => {
    const actions = current && handlers.get(current);
    hide();
    actions?.openComments?.();
  });
  const color = glyphButton("Text color", "", "format-color", "⌘⇧H");
  color.append(el("span", { class: "format-glyph", text: "A" }), icon("chevron_down", "format-caret"));
  const more = glyphButton("More", "", "", "", "Mentions, equations and the rest of the selection menu are not simulated by this Tool.");
  more.append(icon("more"));
  const divider = () => el("span", { class: "format-divider", attrs: { "aria-hidden": "true" } });
  element.append(
    ai, divider(), turn, divider(), link, comment, divider(),
    glyphButton("Bold", "B", "format-bold", "⌘B"),
    glyphButton("Italicize", "i", "format-italic", "⌘I"),
    glyphButton("Underline", "U", "format-underline", "⌘U"),
    glyphButton("Strike-through", "S", "format-strike", "⌘⇧S"),
    glyphButton("Mark as code", "<>", "format-code", "⌘E"),
    color, divider(), more,
  );
  // Keep the text selection while the toolbar is used.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.hidden = true;
  document.body.append(element);
  return element;
}

function hide() {
  if (bar) bar.hidden = true;
  current = undefined;
}

function update() {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    if (!bar?.contains(document.activeElement)) hide();
    return;
  }
  const range = selection.getRangeAt(0);
  const start = range.startContainer.parentElement?.closest?.(".block-text[contenteditable]") ?? (range.startContainer.nodeType === 1 ? range.startContainer.closest(".block-text[contenteditable]") : null);
  if (!start || !handlers.has(start) || !start.contains(range.endContainer) || range.toString().trim() === "") {
    hide();
    return;
  }
  bar ??= build();
  current = start;
  bar.hidden = false;
  const rect = range.getBoundingClientRect();
  const width = bar.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
  const top = rect.top - bar.offsetHeight - 8 < 8 ? rect.bottom + 8 : rect.top - bar.offsetHeight - 8;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  document.addEventListener("selectionchange", update);
  window.addEventListener("resize", hide);
  document.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
}
