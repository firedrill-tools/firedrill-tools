// Comment composer toolbar (GitHub's markdown toolbar) and the discussion sidebar rows the Tool does not model.
// Toolbar buttons edit the textarea locally, exactly like github.com's markdown-toolbar-element: they wrap or
// prefix the selection with Markdown syntax. File attachments and saved replies are not simulated.
import { notSimulated, notSimulatedSidebarItem } from "./chrome.js";
import { button, clear, el, icon, markdown } from "./ui.js";

function surround(textarea, before, after = before, placeholder = "") {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end) || placeholder;
  textarea.value = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(start + before.length, start + before.length + selected.length);
}

function prefixLines(textarea, prefix) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  const block = value.slice(lineStart, end);
  const lines = block.split("\n");
  const next = lines.map((line, index) => `${typeof prefix === "function" ? prefix(index) : prefix}${line}`).join("\n");
  textarea.value = `${value.slice(0, lineStart)}${next}${value.slice(end)}`;
  textarea.focus();
  textarea.setSelectionRange(lineStart, lineStart + next.length);
}

/** Build the toolbar for `textarea`; every edit dispatches `input` so dependent buttons update. */
export function markdownToolbar(textarea) {
  const bar = el("div", { class: "markdown-toolbar", attrs: { role: "toolbar", "aria-label": "Formatting tools" } });
  const edit = (fn) => () => {
    fn();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const groups = [
    [
      ["heading", "Add heading text", edit(() => prefixLines(textarea, "### "))],
      ["bold", "Add bold text, <Cmd+b>", edit(() => surround(textarea, "**", "**"))],
      ["italic", "Add italic text, <Cmd+i>", edit(() => surround(textarea, "_", "_"))],
      ["quote", "Add a quote, <Cmd+Shift+.>", edit(() => prefixLines(textarea, "> "))],
      ["code", "Add code, <Cmd+e>", edit(() => surround(textarea, "`", "`"))],
      ["link", "Add a link, <Cmd+k>", edit(() => surround(textarea, "[", "](url)"))],
    ],
    [
      ["list-ordered", "Add a numbered list, <Cmd+Shift+7>", edit(() => prefixLines(textarea, (index) => `${index + 1}. `))],
      ["list-unordered", "Add a bulleted list, <Cmd+Shift+8>", edit(() => prefixLines(textarea, "- "))],
      ["tasklist", "Add a task list, <Cmd+Shift+l>", edit(() => prefixLines(textarea, "- [ ] "))],
    ],
    [
      ["mention", "Directly mention a user or team", edit(() => surround(textarea, "@", ""))],
      ["cross-reference", "Reference an issue, pull request, or discussion", edit(() => surround(textarea, "#", ""))],
      ["paperclip", "Attach files (not simulated)", () => notSimulated("File attachments")],
      ["reply", "Saved replies (not simulated)", () => notSimulated("Saved replies")],
    ],
  ];
  for (const group of groups) {
    const host = el("div", { class: "markdown-toolbar-group" });
    for (const [glyph, label, onClick] of group) {
      const item = el("button", { class: "toolbar-item", title: label, attrs: { type: "button", "aria-label": label } }, [icon(glyph)]);
      item.addEventListener("click", onClick);
      host.append(item);
    }
    bar.append(host);
  }
  textarea.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
    const map = { b: ["**", "**"], i: ["_", "_"], e: ["`", "`"], k: ["[", "](url)"] };
    const pair = map[event.key.toLowerCase()];
    if (!pair) return;
    event.preventDefault();
    edit(() => surround(textarea, pair[0], pair[1]))();
  });
  return bar;
}

/** Projects · Milestone · Relationships · Development · Notifications, rendered as not simulated. */
export function chromeSidebarItems(isIssue) {
  const items = [
    notSimulatedSidebarItem("Projects", "Projects", "Not simulated"),
    notSimulatedSidebarItem("Milestone", "Milestones", "Not simulated"),
  ];
  if (isIssue) items.push(notSimulatedSidebarItem("Relationships", "Issue relationships", "Not simulated"));
  items.push(notSimulatedSidebarItem("Development", "Linked branches and pull requests", "Not simulated"));
  const notifications = el("div", { class: "discussion-sidebar-item" });
  notifications.append(el("div", { class: "discussion-sidebar-heading" }, [el("span", { text: "Notifications" }), el("span", { class: "sidebar-customize", text: "Customize" })]));
  const subscribe = button("Subscribe", { icon: "bell", size: "sm", class: "btn-block", title: "Notifications (not simulated)", onClick: () => notSimulated("Notifications") });
  notifications.append(subscribe, el("p", { class: "sidebar-note", text: "Thread subscriptions are not simulated by this Tool." }));
  items.push(notifications);
  return items;
}

/**
 * Write / Preview tabs with the markdown toolbar around `textarea`, as on github.com's new issue page. Preview renders
 * locally with the same Markdown subset as posted comments.
 */
export function markdownEditor(textarea) {
  const form = el("div", { class: "comment-form" });
  const tabs = el("div", { class: "comment-form-tabs", attrs: { role: "tablist" } });
  const write = el("button", { class: "comment-form-tab", text: "Write", attrs: { type: "button", role: "tab", "aria-selected": "true" } });
  const preview = el("button", { class: "comment-form-tab", text: "Preview", attrs: { type: "button", role: "tab", "aria-selected": "false" } });
  const toolbar = markdownToolbar(textarea);
  tabs.append(write, preview, toolbar);
  const previewHost = el("div", { class: "comment-form-preview" });
  previewHost.hidden = true;
  const body = el("div", { class: "comment-form-body" }, [textarea, previewHost]);
  form.append(tabs, body);
  const select = (showPreview) => {
    write.setAttribute("aria-selected", String(!showPreview));
    preview.setAttribute("aria-selected", String(showPreview));
    if (showPreview) clear(previewHost).append(textarea.value.trim() ? markdown(textarea.value) : el("p", { class: "text-muted", text: "Nothing to preview" }));
    textarea.hidden = showPreview;
    toolbar.hidden = showPreview;
    previewHost.hidden = !showPreview;
  };
  write.addEventListener("click", () => select(false));
  preview.addEventListener("click", () => select(true));
  return form;
}
