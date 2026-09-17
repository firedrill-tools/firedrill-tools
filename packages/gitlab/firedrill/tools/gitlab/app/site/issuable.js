// Building blocks shared by issues and merge requests: list rows, markdown editor, activity timeline,
// comment form and right-sidebar blocks, all in GitLab's issuable layout.
import { $, action, avatar, badge, button, call, clear, confirmModal, copyText, el, icon, iconButton, labelPill, markdown, newKey, openListbox, openMenu, plural, timeAgo, timeElement, toast, readPreference, writePreference } from "./ui.js";
import { ROLE, hrefs, loadLabels, loadPeople, notSimulated, rememberPeople, state, userLink } from "./shell.js";

// ---------------------------------------------------------------------------------------------
// List rows
// ---------------------------------------------------------------------------------------------

/** One row of an issue or merge request list. labelsByName maps name → label (for colours). */
export function issuableRow(item, kind, project, labelsByName, { showProject = false } = {}) {
  rememberPeople(item.author, item.assignees ?? [], item.reviewers ?? []);
  const projectPath = project?.path_with_namespace ?? item.references?.full?.replace(/[#!]\d+$/, "");
  const href = kind === "issue" ? hrefs.issue(projectPath, item.iid) : hrefs.mr(projectPath, item.iid);
  const li = el("li", { class: `issue gl-issuable-row ${item.state === "closed" || item.state === "merged" ? "closed" : ""}`.trim() });
  const main = el("div", { class: "issuable-main" });
  const title = el("div", { class: "issuable-title" });
  if (item.confidential) title.append(el("span", { class: "issuable-confidential", title: "Confidential" }, [icon("eye-slash")]));
  if (item.discussion_locked) title.append(el("span", { class: "issuable-locked", title: "Locked" }, [icon("lock")]));
  title.append(el("a", { class: "issue-title-text", href, text: item.title }));
  if (kind === "mr" && item.has_conflicts && item.state === "opened") title.append(el("span", { class: "issuable-conflict", title: "Merge conflicts" }, [icon("warning-solid")]));
  const meta = el("div", { class: "issuable-info" });
  const reference = showProject ? item.references?.full ?? `${kind === "issue" ? "#" : "!"}${item.iid}` : `${kind === "issue" ? "#" : "!"}${item.iid}`;
  meta.append(el("span", { class: "issuable-reference", text: reference }), el("span", { class: "issuable-separator", text: " · " }), el("span", { text: "created " }), timeElement(item.created_at), el("span", { text: " by " }), userLink(item.author));
  if (kind === "mr") {
    meta.append(el("span", { class: "project-ref-path" }, [icon("branch", "", 12), el("span", { class: "ref-name", text: item.target_branch })]));
  }
  if (item.labels?.length) {
    const labels = el("span", { class: "issuable-labels" });
    for (const name of item.labels) labels.append(labelPill(labelsByName?.get(name) ?? { name, color: "#6699cc" }, { href: kind === "issue" ? hrefs.issues(projectPath, { label_name: name }) : hrefs.mrs(projectPath, { label_name: name }) }));
    meta.append(labels);
  }
  if (item.task_completion_status?.count > 0) meta.append(el("span", { class: "task-status" }, [icon("list-task", "", 12), el("span", { text: ` ${item.task_completion_status.completed_count} of ${item.task_completion_status.count} checklist items completed` })]));
  main.append(title, meta);
  const aside = el("div", { class: "issuable-meta" });
  const top = el("ul", { class: "controls" });
  if (item.state === "closed") top.append(el("li", { class: "issuable-status", text: kind === "issue" ? "Closed" : "Closed" }));
  if (item.state === "merged") top.append(el("li", { class: "issuable-status", text: "Merged" }));
  if (item.assignees?.length) {
    const stack = el("li", { class: "avatar-stack", title: `Assigned to ${item.assignees.map((user) => user.name).join(", ")}` });
    for (const user of item.assignees.slice(0, 3)) stack.append(avatar(user, 16));
    top.append(stack);
  }
  if (kind === "mr" && item.reviewers?.length) {
    const stack = el("li", { class: "avatar-stack", title: `Review requested from ${item.reviewers.map((user) => user.name).join(", ")}` });
    for (const user of item.reviewers.slice(0, 3)) stack.append(avatar(user, 16));
    top.append(stack);
  }
  const notes = el("li", { class: `issuable-comments ${item.user_notes_count ? "" : "no-comments"}`, title: plural(item.user_notes_count ?? 0, "comment") }, [icon("comments", "", 16), el("span", { text: String(item.user_notes_count ?? 0) })]);
  top.append(notes);
  aside.append(top, el("div", { class: "issuable-updated-at" }, [el("span", { text: "updated " }), timeElement(item.updated_at)]));
  li.append(main, aside);
  return li;
}

// ---------------------------------------------------------------------------------------------
// Filtered-search tokens backed by real records
// ---------------------------------------------------------------------------------------------

export function userTokenOptions(project, { includeNone = false } = {}) {
  return async () => {
    const people = await loadPeople(project);
    const options = people.map((user) => ({ value: user.username, label: user.name, description: `@${user.username}`, avatar: avatar(user, 16) }));
    options.notice = people.notice;
    if (includeNone) options.unshift({ value: "None", label: "None" }, { value: "Any", label: "Any" });
    return options;
  };
}

export function labelTokenOptions(project) {
  return async () => (await loadLabels(project)).map((label) => ({ value: label.name, label: label.name, swatch: label.color, description: label.description ?? "" }));
}

// ---------------------------------------------------------------------------------------------
// Markdown field (GitLab's plain-text editor with Write / Preview tabs and toolbar)
// ---------------------------------------------------------------------------------------------

export function markdownField({ value = "", placeholder = "Write a comment or drag your files here…", label = "Description", rows = 6, onInput, refHref } = {}) {
  const wrap = el("div", { class: "md-area" });
  const header = el("div", { class: "md-header" });
  const tabs = el("div", { class: "md-header-tabs", attrs: { role: "tablist" } });
  const writeTab = el("button", { class: "md-header-tab active", text: "Write", attrs: { type: "button", role: "tab", "aria-selected": "true" } });
  const previewTab = el("button", { class: "md-header-tab", text: "Preview", attrs: { type: "button", role: "tab", "aria-selected": "false" } });
  tabs.append(writeTab, previewTab);
  const textarea = el("textarea", { class: "note-textarea markdown-area", attrs: { placeholder, "aria-label": label, rows: String(rows), dir: "auto" } });
  textarea.value = value;
  const preview = el("div", { class: "md-preview-holder md" });
  preview.hidden = true;
  const toolbar = el("div", { class: "md-header-toolbar", attrs: { role: "toolbar", "aria-label": "Markdown formatting" } });
  const wrapSelection = (before, after = before, placeholderText = "") => {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || placeholderText;
    textarea.setRangeText(`${before}${selected}${after}`, start, end, "select");
    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
  };
  const linePrefix = (prefix) => {
    const start = textarea.value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
    textarea.setRangeText(prefix, start, start, "end");
    textarea.focus();
    textarea.dispatchEvent(new Event("input"));
  };
  const tools = [
    ["bold", "Add bold text (⌘B)", () => wrapSelection("**")],
    ["italic", "Add italic text (⌘I)", () => wrapSelection("_")],
    ["strikethrough", "Add strikethrough text", () => wrapSelection("~~"), "dash"],
    ["quote", "Insert a quote", () => linePrefix("> ")],
    ["code", "Insert code", () => wrapSelection("`")],
    ["link", "Add a link (⌘K)", () => wrapSelection("[", "](url)", "text")],
    ["list-bulleted", "Add a bullet list", () => linePrefix("- ")],
    ["list-numbered", "Add a numbered list", () => linePrefix("1. ")],
    ["list-task", "Add a checklist", () => linePrefix("- [ ] ")],
    ["table", "Add a table", () => wrapSelection("\n| header | header |\n| ------ | ------ |\n| cell | cell |\n", "", "")],
    ["paperclip", "Attach a file or image", () => notSimulated("File attachments")],
  ];
  for (const [name, title, run, glyph] of tools) toolbar.append(iconButton(glyph ?? name, title, { size: "sm", onClick: run }));
  header.append(tabs, toolbar);
  const showPreview = (on) => {
    writeTab.classList.toggle("active", !on);
    previewTab.classList.toggle("active", on);
    writeTab.setAttribute("aria-selected", String(!on));
    previewTab.setAttribute("aria-selected", String(on));
    textarea.hidden = on;
    toolbar.hidden = on;
    preview.hidden = !on;
    if (on) {
      clear(preview);
      if (textarea.value.trim()) preview.append(...markdown(textarea.value, { refHref }).childNodes);
      else preview.append(el("p", { class: "gl-text-subtle", text: "Nothing to preview." }));
    }
  };
  writeTab.addEventListener("click", () => showPreview(false));
  previewTab.addEventListener("click", () => showPreview(true));
  textarea.addEventListener("input", () => onInput?.(textarea.value));
  const footer = el("div", { class: "md-footer" }, [icon("markdown-mark", "", 16), el("span", { text: "Supports Markdown. For quick actions, type /." })]);
  wrap.append(header, textarea, preview, footer);
  return { element: wrap, textarea, get value() { return textarea.value; }, set value(text) { textarea.value = text; }, reset: () => { textarea.value = ""; showPreview(false); } };
}

// ---------------------------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------------------------

function systemNoteIcon(body) {
  if (/label/.test(body)) return "label";
  if (/^closed|^merged/.test(body)) return body.startsWith("merged") ? "merge" : "issue-close";
  if (/^reopened/.test(body)) return "status_open";
  if (/assigned|review/.test(body)) return "user";
  if (/confidential/.test(body)) return "eye-slash";
  if (/locked/.test(body)) return "lock";
  if (/title|description/.test(body)) return "pencil";
  if (/commit/.test(body)) return "commit";
  return "comment-dots";
}

export function timeline(notes, { project, refHref: linkRef, noteableAuthorId, labelsByName } = {}) {
  const list = el("ul", { class: "notes main-notes-list timeline" });
  const options = { refHref: linkRef, labelFor: (name) => labelsByName?.get(name) };
  for (const note of notes) {
    rememberPeople(note.author);
    if (note.system) {
      const li = el("li", { class: "note system-note timeline-entry", attrs: { id: `note_${note.id}` } });
      li.append(el("div", { class: "timeline-icon" }, [icon(systemNoteIcon(note.body), "", 14)]));
      const body = el("div", { class: "note-header-info" });
      body.append(userLink(note.author), el("span", { class: "system-note-message" }, [" ", ...markdown(note.body, options).firstChild?.childNodes ?? []]), el("span", { class: "system-note-separator", text: " · " }), timeElement(note.created_at, "note-timestamp"));
      li.append(el("div", { class: "timeline-content" }, [body]));
      list.append(li);
      continue;
    }
    const li = el("li", { class: `note timeline-entry note-wrapper ${note.internal ? "internal-note" : ""}`.trim(), attrs: { id: `note_${note.id}` } });
    li.append(el("div", { class: "timeline-avatar" }, [el("a", { href: hrefs.user(note.author.username) }, [avatar(note.author, 32)])]));
    const content = el("div", { class: "timeline-content" });
    const header = el("div", { class: "note-header" });
    const info = el("div", { class: "note-header-info" }, [
      el("a", { class: "note-author-name", href: hrefs.user(note.author.username), text: note.author.name }),
      el("span", { class: "note-headline-light", text: ` @${note.author.username}` }),
      el("span", { class: "note-headline-light", text: " · " }),
      el("a", { class: "note-timestamp", href: `#note_${note.id}` }, [timeElement(note.created_at)]),
    ]);
    if (note.internal) info.append(badge("Internal note", "warning", { icon: "eye-slash", size: "sm" }));
    const actions = el("div", { class: "note-actions" });
    if (noteableAuthorId !== undefined && note.author.id === noteableAuthorId) actions.append(badge("Author", "neutral", { size: "sm" }));
    if (state.user && note.author.id === state.user.id && project) {
      const level = project.permissions?.project_access?.access_level;
      if (level) actions.append(badge(ROLE[level] ?? "Member", "neutral", { size: "sm" }));
    }
    actions.append(iconButton("thumb-up", "Add reaction", { size: "sm", onClick: () => notSimulated("Emoji reactions") }), iconButton("ellipsis_v", "More actions", { size: "sm", onClick: () => notSimulated("Editing, deleting and threading comments") }));
    header.append(info, actions);
    content.append(header, el("div", { class: "note-body" }, [markdown(note.body, options)]));
    li.append(content);
    list.append(li);
  }
  return list;
}

/** "Sort or filter" dropdown above the activity stream. */
export function activityControls({ sort, filter, onChange, filters = true }) {
  const wrap = el("div", { class: "discussion-filter-container" });
  const label = sort === "desc" ? "Newest first" : "Oldest first";
  const trigger = button(filters ? `Sort or filter` : label, { trailingIcon: "chevron-down", size: "sm" });
  trigger.addEventListener("click", () => {
    const items = [{ header: "Sort" }, { label: "Oldest first", checked: sort === "asc", onSelect: () => onChange({ sort: "asc", filter }) }, { label: "Newest first", checked: sort === "desc", onSelect: () => onChange({ sort: "desc", filter }) }];
    if (filters) items.push("divider", { header: "Filter" }, { label: "Show all activity", checked: filter === "all_notes", onSelect: () => onChange({ sort, filter: "all_notes" }) }, { label: "Show comments only", checked: filter === "only_comments", onSelect: () => onChange({ sort, filter: "only_comments" }) }, { label: "Show history only", checked: filter === "only_activity", onSelect: () => onChange({ sort, filter: "only_activity" }) });
    openMenu(trigger, items, { align: "end", width: 220 });
  });
  wrap.append(trigger);
  return wrap;
}

export function activityPreference(kind) {
  return { sort: readPreference(`${kind}:sort`, "asc") === "desc" ? "desc" : "asc", filter: ["all_notes", "only_comments", "only_activity"].includes(readPreference(`${kind}:filter`, "all_notes")) ? readPreference(`${kind}:filter`, "all_notes") : "all_notes" };
}
export function saveActivityPreference(kind, value) {
  writePreference(`${kind}:sort`, value.sort);
  writePreference(`${kind}:filter`, value.filter);
}

// ---------------------------------------------------------------------------------------------
// Comment form
// ---------------------------------------------------------------------------------------------

/**
 * onSubmit(body, { internal }) must perform the write and throw on failure. closeLabel adds GitLab's
 * "Close issue" / "Comment & close issue" button (onClose(body?) performs it).
 */
export function commentForm({ canComment, lockedMessage, canInternal, onSubmit, closeLabel, onClose, refHref, onDirty }) {
  const wrap = el("div", { class: "timeline-entry note-form" });
  if (!canComment) {
    wrap.append(el("div", { class: "disabled-comment" }, [icon("lock"), el("span", { text: lockedMessage })]));
    return wrap;
  }
  wrap.append(el("div", { class: "timeline-avatar" }, [state.user ? avatar(state.user, 32) : ""]));
  const content = el("div", { class: "timeline-content timeline-content-form" });
  const field = markdownField({ placeholder: "Write a comment or drag your files here…", label: "Comment", rows: 4, refHref, onInput: (value) => {
    onDirty?.(value.trim().length > 0);
    if (closeButton) closeButton.querySelector(".gl-button-text").textContent = value.trim() ? `Comment & ${closeLabel.charAt(0).toLowerCase()}${closeLabel.slice(1)}` : closeLabel;
  } });
  const errorHost = el("div");
  const internal = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: `internal-${Math.round(performance.now())}` } });
  const footer = el("div", { class: "note-form-actions" });
  if (canInternal) footer.append(el("div", { class: "gl-form-checkbox confidential-note" }, [internal, el("label", { attrs: { for: internal.id } }, [el("span", { text: "Make this an internal note" }), el("span", { class: "gl-text-subtle", text: " · Internal notes are only visible to members with the Planner role or higher" })])]));
  const buttons = el("div", { class: "note-form-buttons" });
  const submitGroup = el("div", { class: "gl-button-group split-button" });
  const submit = button("Comment", { variant: "confirm", type: "submit" });
  const split = iconButton("chevron-down", "Comment options", { variant: "confirm", class: "split-toggle", onClick: (event) => openMenu(event.currentTarget, [{ label: "Comment", description: "Add a general comment to this item.", checked: true }, { label: "Start thread", description: "Discuss a specific suggestion or question that needs to be resolved.", checked: false, onSelect: () => notSimulated("Threads") }], { align: "end", width: 300 }) });
  submitGroup.append(submit, split);
  buttons.append(submitGroup);
  let closeButton;
  const form = el("form", { class: "new-note" }, [field.element, errorHost, footer]);
  if (closeLabel) {
    closeButton = button(closeLabel, { onClick: async () => {
      const body = field.value.trim();
      await action(async () => {
        clear(errorHost);
        if (body) await onSubmit(body, { internal: internal.checked });
        await onClose();
        field.reset();
        onDirty?.(false);
      }, { onError: (error) => showFormError(errorHost, error) });
    } });
    buttons.append(closeButton);
  }
  footer.append(buttons);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = field.value.trim();
    if (!body) {
      field.textarea.focus();
      return;
    }
    submit.disabled = true;
    await action(async () => {
      clear(errorHost);
      await onSubmit(body, { internal: internal.checked });
      field.reset();
      internal.checked = false;
      onDirty?.(false);
    }, { onError: (error) => showFormError(errorHost, error) });
    submit.disabled = false;
  });
  content.append(form);
  wrap.append(content);
  return wrap;
}

export function showFormError(host, error) {
  clear(host);
  host.append(errorAlert(error));
  host.scrollIntoView({ block: "nearest" });
}

function errorAlert(error) {
  const message = error?.status === "denied" ? "You don't have permission to do that." : error?.message ?? String(error);
  const box = el("div", { class: "gl-alert gl-alert-danger", attrs: { role: "alert" } }, [icon("warning", "gl-alert-icon")]);
  box.append(el("div", { class: "gl-alert-content" }, [el("div", { class: "gl-alert-body", text: message })]));
  return box;
}

// ---------------------------------------------------------------------------------------------
// Right sidebar blocks
// ---------------------------------------------------------------------------------------------

export function sidebarBlock(title, { canEdit = false, onEdit, content, editLabel = "Edit" }) {
  const block = el("div", { class: "block" });
  const head = el("div", { class: "block-title" }, [el("span", { class: "block-title-text", text: title })]);
  if (canEdit) {
    const edit = el("button", { class: "gl-button btn-link btn-sm sidebar-edit", text: editLabel, attrs: { type: "button", "aria-expanded": "false" } });
    edit.addEventListener("click", (event) => onEdit(event.currentTarget));
    head.append(edit);
  }
  block.append(head, el("div", { class: "block-value" }, Array.isArray(content) ? content : [content]));
  return block;
}

export function peopleValue(users, { emptyText = "None", assignYourself } = {}) {
  if (!users?.length) {
    const wrap = el("span", { class: "no-value" }, [el("span", { text: emptyText })]);
    if (assignYourself) {
      const self = el("button", { class: "gl-button btn-link btn-sm assign-yourself", text: "assign yourself", attrs: { type: "button" } });
      self.addEventListener("click", assignYourself);
      wrap.append(el("span", { text: " - " }), self);
    }
    return wrap;
  }
  const list = el("div", { class: "sidebar-people" });
  for (const user of users) list.append(el("a", { class: "sidebar-person", href: hrefs.user(user.username) }, [avatar(user, 24), el("span", { class: "sidebar-person-text" }, [el("span", { class: "sidebar-person-name", text: user.name }), el("span", { class: "sidebar-person-username", text: `@${user.username}` })])]));
  return list;
}

export function labelsValue(names, labelsByName, { onRemove } = {}) {
  if (!names?.length) return el("span", { class: "no-value", text: "None" });
  const wrap = el("div", { class: "sidebar-labels" });
  for (const name of names) wrap.append(labelPill(labelsByName.get(name) ?? { name, color: "#6699cc" }, onRemove ? { onRemove: () => onRemove(name) } : {}));
  return wrap;
}

export async function pickUsers(anchor, project, { title, selectedIds, multiple = true, onApply }) {
  const people = await loadPeople(project);
  openListbox(anchor, {
    title,
    placeholder: "Search users",
    multiple,
    options: people.map((user) => ({ id: user.id, label: user.name, description: `@${user.username}`, avatar: avatar(user, 24), selected: selectedIds.includes(user.id) })),
    onApply: (ids) => onApply(ids.map(Number)),
    footer: el("span", { class: `gl-text-sm ${people.notice ? "people-scan-notice" : "gl-text-subtle"}`, attrs: people.notice ? { role: "status" } : {}, text: people.notice ?? "Shows people who appear on this project's issues and merge requests." }),
  });
}

export async function pickLabels(anchor, project, { selected, onApply }) {
  const labels = await loadLabels(project);
  openListbox(anchor, {
    title: "Select labels",
    placeholder: "Search labels",
    multiple: true,
    options: labels.map((label) => ({ id: label.name, label: label.name, swatch: label.color, description: label.description ?? "", selected: selected.includes(label.name) })),
    onApply,
    footer: el("a", { class: "gl-link gl-text-sm", href: hrefs.labels(project.path_with_namespace), text: "Manage project labels" }),
  });
}

export function participantsBlock(users) {
  const unique = [...new Map(users.filter(Boolean).map((user) => [user.id, user])).values()];
  const list = el("div", { class: "participants-list" });
  for (const user of unique) list.append(el("a", { href: hrefs.user(user.username), title: user.name, class: "participants-author" }, [avatar(user, 24)]));
  const block = el("div", { class: "block participants" }, [el("div", { class: "block-title" }, [el("span", { class: "block-title-text", text: plural(unique.length, "Participant") })]), list]);
  return block;
}

export function referenceBlock(reference, label = "Reference") {
  const copy = iconButton("copy-to-clipboard", `Copy reference`, { size: "sm", onClick: () => copyText(reference, "Reference copied") });
  return el("div", { class: "block reference" }, [el("div", { class: "block-title" }, [el("span", { class: "block-title-text", text: `${label}: ` }), el("span", { class: "reference-value", text: reference }), copy])]);
}

export function mutedBlock(title, value, feature) {
  const edit = el("button", { class: "gl-button btn-link btn-sm sidebar-edit", text: "Edit", attrs: { type: "button" } });
  edit.addEventListener("click", () => notSimulated(feature));
  return el("div", { class: "block" }, [el("div", { class: "block-title" }, [el("span", { class: "block-title-text", text: title }), edit]), el("div", { class: "block-value no-value", text: value })]);
}

/** Run a mutation with a fresh idempotency key, toast on success, and re-render. */
export async function mutate(operationId, args, { success, rerender, onError } = {}) {
  return action(async () => {
    const value = await call(operationId, args, newKey());
    if (success) toast(success);
    await rerender?.(value);
    return value;
  }, onError ? { onError } : undefined);
}

export async function confirmThen(title, text, okLabel, run, { danger = false } = {}) {
  if (await confirmModal(title, text, okLabel, { danger })) await run();
}

export { timeAgo, copyText, $ };
