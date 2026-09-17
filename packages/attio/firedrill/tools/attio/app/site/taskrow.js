// Task rows and the task composer, shared by the Tasks page and the record page's Tasks tab.
import { icon } from "./icons.js";
import { formatDate, memberName, objectOfId, parseTime, refName, store } from "./store.js";
import { action, button, call, closePopover, confirmDialog, describe, el, iconButton, menu, newKey, popover, toast } from "./ui.js";
import { avatar, recordAvatar, recordPicker } from "./values.js";

export function dueChip(deadline) {
  if (!deadline) return null;
  const ms = parseTime(deadline);
  const now = store.nowMs;
  const day = (t) => Math.floor(t / 86_400_000);
  let kind = "";
  let text = formatDate(deadline);
  if (now !== undefined && ms !== undefined) {
    if (day(ms) === day(now)) { kind = "today"; text = "Today"; }
    else if (ms < now) kind = "overdue";
    else if (day(ms) === day(now) + 1) text = "Tomorrow";
  }
  return el("span", { class: `at-due ${kind}`.trim(), title: `Due ${formatDate(deadline)}` }, [icon("calendar", "", 12), el("span", { text })]);
}

export function taskGroup(task) {
  if (task.is_completed) return "Completed";
  if (!task.deadline_at) return "No due date";
  const ms = parseTime(task.deadline_at);
  const day = (t) => Math.floor(t / 86_400_000);
  if (day(ms) === day(store.nowMs)) return "Today";
  return ms < store.nowMs ? "Overdue" : "Upcoming";
}

/** One task row. `onChanged` reloads the owning view. */
export function taskRow(task, onChanged) {
  const id = task.id.task_id;
  const row = el("div", { class: `at-task${task.is_completed ? " done" : ""}` });
  const check = el("input", { class: "at-task-check", attrs: { type: "checkbox", "aria-label": `Mark "${task.content_plaintext}" as ${task.is_completed ? "not completed" : "completed"}` } });
  check.checked = task.is_completed;
  check.addEventListener("change", () => void action(async () => {
    await call("tasks.update", { task_id: id, data: { is_completed: check.checked } }, newKey());
    toast(check.checked ? "Task completed" : "Task reopened");
    onChanged();
  }, { onError: (error) => { check.checked = !check.checked; toast(describe(error), { error: true }); } }));
  const meta = el("span", { class: "at-task-meta" });
  for (const link of task.linked_records) {
    const object = objectOfId(link.target_object_id);
    if (!object) continue;
    const name = refName(link.target_record_id);
    meta.append(el("a", { class: "at-ref", title: name, attrs: { href: `#/${object.api_slug}/${link.target_record_id}` } }, [recordAvatar(object.api_slug, name, link.target_record_id, "tiny"), el("span", { text: name })]));
  }
  const due = dueChip(task.deadline_at);
  if (due) meta.append(due);
  const stack = el("span", { class: "at-stack" });
  for (const a of task.assignees) stack.append(Object.assign(avatar(memberName(a.referenced_actor_id), a.referenced_actor_id, { size: "small" }), { title: memberName(a.referenced_actor_id) }));
  meta.append(stack);
  const more = iconButton("more", "Task actions", () => menu(more, [
    { label: "Change due date", icon: "calendar", onSelect: () => editDeadline(more, task, onChanged) },
    "divider",
    { label: "Delete task", icon: "trash", danger: true, onSelect: async () => {
      if (!(await confirmDialog("Delete task?", `"${task.content_plaintext}" will be permanently deleted.`))) return;
      await action(async () => { await call("tasks.delete", { task_id: id }, newKey()); toast("Task deleted"); onChanged(); });
    } },
  ], { align: "end" }), "small");
  row.append(check, el("span", { class: "at-task-text", text: task.content_plaintext, title: task.content_plaintext }), meta, el("span", { class: "at-task-actions" }, more));
  return row;
}

function editDeadline(anchor, task, onChanged) {
  const form = el("form", { class: "at-editor-form" });
  const input = el("input", { class: "at-input", attrs: { type: "date", "aria-label": "Due date" } });
  input.value = task.deadline_at ? task.deadline_at.slice(0, 10) : "";
  const save = button("Save", { class: "primary small" });
  save.type = "submit";
  const error = el("div", { class: "at-field-error", attrs: { role: "alert" } });
  form.append(el("div", { class: "at-editor-head", text: "Due date (UTC)" }), input, error, el("div", { class: "at-editor-actions" }, [button("Clear", { class: "small ghost", onClick: () => submit(null) }), save]));
  const submit = (value) => void action(async () => {
    await call("tasks.update", { task_id: task.id.task_id, data: { deadline_at: value } }, newKey());
    closePopover();
    toast("Due date updated");
    onChanged();
  }, { onError: (err) => { error.textContent = describe(err); } });
  form.addEventListener("submit", (event) => { event.preventDefault(); submit(input.value ? `${input.value}T17:00:00.000000000Z` : null); });
  popover(anchor, el("div", { class: "at-editor" }, form), { width: 260, align: "end" });
}

/** Inline composer. `fixedLink` = { object, record_id } pre-links the task (record page). */
export function taskComposer(onCreated, fixedLink) {
  const form = el("form", { class: "at-task" });
  const text = el("input", { class: "at-input", attrs: { type: "text", placeholder: "Add a task…", "aria-label": "Task description", maxlength: "2000" } });
  text.style.flex = "1";
  const date = el("input", { class: "at-input", attrs: { type: "date", "aria-label": "Due date" } });
  date.style.width = "150px";
  const assignee = el("select", { class: "at-select", attrs: { "aria-label": "Assignee" } });
  assignee.style.width = "170px";
  assignee.append(el("option", { text: "No assignee", attrs: { value: "" } }));
  for (const m of store.members.filter((x) => x.access_level !== "suspended")) assignee.append(el("option", { text: `${m.first_name} ${m.last_name}`, attrs: { value: m.id.workspace_member_id } }));
  assignee.value = store.self?.authorized_by_workspace_member_id ?? "";
  const links = fixedLink ? [fixedLink] : [];
  const linkSlot = el("span", { class: "at-task-meta" });
  const drawLinks = () => {
    linkSlot.replaceChildren(...links.map((l) => el("span", { class: "at-ref" }, [recordAvatar(l.object, l.name, l.record_id, "tiny"), el("span", { text: l.name })])));
    if (!fixedLink) linkSlot.append(linkButton);
  };
  const linkButton = iconButton("link", "Link a record", () => popover(linkButton, recordPicker({ objects: store.objects.map((o) => o.api_slug), onPick: (hit) => { closePopover(); links.splice(0, links.length, { object: hit.object_slug, record_id: hit.id.record_id, name: hit.record_text }); drawLinks(); } }), { width: 320, align: "end" }), "small");
  const add = button("Add task", { class: "primary small" });
  add.type = "submit";
  drawLinks();
  form.append(icon("plus"), text, linkSlot, date, assignee, add);
  let key = newKey();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!text.value.trim()) return text.focus();
    void action(async () => {
      await call("tasks.create", { data: {
        content: text.value.trim(), format: "plaintext", is_completed: false,
        deadline_at: date.value ? `${date.value}T17:00:00.000000000Z` : null,
        linked_records: links.map((l) => ({ target_object: l.object, target_record_id: l.record_id })),
        assignees: assignee.value ? [{ referenced_actor_type: "workspace-member", referenced_actor_id: assignee.value }] : [],
      } }, key);
      key = newKey();
      text.value = "";
      date.value = "";
      if (!fixedLink) { links.length = 0; drawLinks(); }
      toast("Task created");
      onCreated();
    });
  });
  return { form, unsaved: () => text.value.trim() !== "" };
}
