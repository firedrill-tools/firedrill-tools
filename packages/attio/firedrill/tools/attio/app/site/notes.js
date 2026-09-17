// Notes: the workspace-wide notes page, the note reader and the note editor modal.
import { icon } from "./icons.js";
import { formatDateTime, loadNames, memberName, refName, relative, resolveNames, store } from "./store.js";
import { action, button, call, closePopover, confirmDialog, describe, el, iconButton, menu, newKey, openModal, popover, toast } from "./ui.js";
import { avatar, recordAvatar, recordPicker } from "./values.js";
import { errorState, pageHeader, stateBox } from "./shell.js";
import { renderMarkdown } from "./md.js";

const PAGE = 50;

/** Note editor modal. `parent` = { object, record_id, name } or undefined to choose one. */
export function openNoteEditor(parent, onCreated) {
  let dirty = false;
  const promise = openModal({
    title: "New note",
    iconElement: icon("note"),
    wide: true,
    render(body, foot, close) {
      let chosen = parent;
      const parentSlot = el("span", { class: "at-picked" });
      const drawParent = () => {
        parentSlot.replaceChildren();
        if (chosen) parentSlot.append(el("span", { class: "at-ref" }, [recordAvatar(chosen.object, chosen.name, chosen.record_id, "tiny"), el("span", { text: chosen.name })]));
        if (!parent) {
          const pick = button(chosen ? "Change" : "Choose record", { class: "small", icon: "link", onClick: () => popover(pick, recordPicker({ objects: store.objects.map((o) => o.api_slug), onPick: (hit) => { closePopover(); chosen = { object: hit.object_slug, record_id: hit.id.record_id, name: hit.record_text }; drawParent(); } }), { width: 320 }) });
          parentSlot.append(pick);
        }
      };
      drawParent();
      const title = el("input", { class: "at-input", attrs: { id: "note-title", type: "text", placeholder: "Untitled note", maxlength: "1000" } });
      title.style.cssText = "height:40px;font-size:18px;font-weight:600;border-color:transparent;padding:0";
      const content = el("textarea", { class: "at-textarea", attrs: { id: "note-content", placeholder: "Start writing… Markdown headings, lists, **bold** and links are supported.", "aria-label": "Note content" } });
      content.style.minHeight = "260px";
      for (const control of [title, content]) control.addEventListener("input", () => { dirty = true; });
      const error = el("div", { class: "at-banner", attrs: { role: "alert" } });
      error.hidden = true;
      body.append(error, el("div", { class: "at-form-row" }, [el("span", { class: "at-hint", text: "Record" }), parentSlot]), el("label", { class: "visually-hidden", text: "Note title", attrs: { for: "note-title" } }), title, content);
      const save = button("Create note", { class: "primary" });
      let key = newKey();
      save.addEventListener("click", () => {
        if (!chosen) { error.hidden = false; error.textContent = "Choose the record this note belongs to."; return; }
        save.disabled = true;
        void action(async () => {
          const created = await call("notes.create", { data: { parent_object: chosen.object, parent_record_id: chosen.record_id, title: title.value.trim(), format: "markdown", content: content.value } }, key);
          key = newKey();
          dirty = false;
          toast("Note created");
          close();
          onCreated(created.data);
        }, { onError: (err) => { error.hidden = false; error.textContent = describe(err); } }).finally(() => { save.disabled = false; });
      });
      foot.append(el("span", { class: "at-hint", text: "Notes are saved in Markdown" }), el("span", { class: "grow" }), button("Cancel", { onClick: close }), save);
    },
  });
  return { promise, unsaved: () => dirty };
}

/** The reading pane for one note; `onDeleted` runs after deletion. */
export function noteReader(note, onDeleted) {
  const id = note.id.note_id;
  const author = note.created_by_actor?.type === "workspace-member" ? note.created_by_actor.id : undefined;
  const more = iconButton("more", "Note actions", () => menu(more, [
    { label: "Delete note", icon: "trash", danger: true, onSelect: async () => {
      if (!(await confirmDialog("Delete note?", `"${note.title || "Untitled note"}" will be permanently deleted.`))) return;
      await action(async () => { await call("notes.delete", { note_id: id }, newKey()); toast("Note deleted"); onDeleted(); });
    } },
  ], { align: "end" }));
  const byline = el("div", { class: "at-note-byline" }, [
    author ? avatar(memberName(author), author, { size: "small" }) : null,
    el("span", { text: author ? memberName(author) : "API" }),
    el("span", { text: "·" }),
    el("span", { text: formatDateTime(note.created_at), title: note.created_at }),
    el("span", { text: "·" }),
    el("a", { class: "at-ref", attrs: { href: `#/${note.parent_object}/${note.parent_record_id}` } }, [recordAvatar(note.parent_object, refName(note.parent_record_id), note.parent_record_id, "tiny"), el("span", { text: refName(note.parent_record_id) })]),
  ]);
  const head = el("div", { class: "at-panel-title" }, [el("h1", { class: "at-note-title", text: note.title || "Untitled note" }), el("span", { class: "grow" }), more]);
  return el("article", { class: "at-note-reader" }, [head, byline, note.content_markdown ? renderMarkdown(note.content_markdown) : el("p", { class: "at-empty-value", text: "This note is empty." })]);
}

let selectedId;

export async function renderNotes(main, { alive, noteId }) {
  if (noteId) selectedId = noteId;
  let editor;
  const newNote = button("New note", { class: "primary", icon: "plus", onClick: () => { editor = openNoteEditor(undefined, (n) => { selectedId = n.id.note_id; void load(); }); } });
  const header = pageHeader([{ label: "Notes", leading: icon("note") }], [newNote]);
  const list = el("nav", { class: "at-note-list", attrs: { "aria-label": "Notes" } });
  let reader = el("div", { class: "at-note-reader" });
  main.replaceChildren(header, el("div", { class: "at-notes" }, [list, reader]));
  let notes = [];
  let hasMore = false;

  async function load(append = false) {
    if (!append) list.replaceChildren(el("div", { class: "at-hint pad", text: "Loading notes…" }));
    try {
      const [page] = await Promise.all([call("notes.list", { limit: PAGE, offset: append ? notes.length : 0 }), loadNames()]);
      await resolveNames(page.data);
      if (!alive()) return;
      notes = append ? [...notes, ...page.data] : page.data;
      hasMore = page.data.length === PAGE;
      draw();
    } catch (error) {
      if (alive()) list.replaceChildren(errorState(error, () => void load()));
    }
  }

  function draw() {
    list.replaceChildren();
    if (notes.length === 0) {
      reader.replaceChildren(stateBox({ iconName: "note", title: "No notes", text: "Notes you write on people, companies and deals appear here.", action: button("New note", { icon: "plus", onClick: () => newNote.click() }) }));
      return;
    }
    const sorted = [...notes].sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (!sorted.some((n) => n.id.note_id === selectedId)) selectedId = sorted[0].id.note_id;
    for (const note of sorted) {
      const item = el("button", { class: "at-note-item", attrs: { type: "button", "aria-current": String(note.id.note_id === selectedId) } }, [
        el("span", { class: "at-note-item-title", text: note.title || "Untitled note" }),
        el("span", { class: "at-note-item-snippet", text: note.content_plaintext || "No content" }),
        el("span", { class: "at-note-item-meta" }, [recordAvatar(note.parent_object, refName(note.parent_record_id), note.parent_record_id, "tiny"), el("span", { text: refName(note.parent_record_id) }), el("span", { text: `· ${relative(note.created_at)}` })]),
      ]);
      item.addEventListener("click", () => { selectedId = note.id.note_id; draw(); });
      list.append(item);
    }
    if (hasMore) list.append(button("Load more notes", { class: "ghost", onClick: () => void load(true) }));
    const current = sorted.find((n) => n.id.note_id === selectedId);
    const next = noteReader(current, () => { selectedId = undefined; void load(); });
    reader.replaceWith(next);
    reader = next;
  }

  await load();
  return { unsaved: () => Boolean(editor?.unsaved()) };
}
