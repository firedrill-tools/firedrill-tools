// Record page tab bodies: Overview (highlights, tasks, notes), Team, Notes and Tasks.
import { icon, typeIcon } from "./icons.js";
import { relative, resolveNames, store } from "./store.js";
import { button, call, describe, el, toast } from "./ui.js";

// notes.list allows at most 50 notes per call; tasks use the same page size. Tabs page with "Load more".
const PAGE = 50;
const OVERVIEW_TASKS = 5;
const countLabel = (items, more) => (more ? `${items.length}+` : items.length);
import { recordAvatar, renderValues } from "./values.js";
import { errorState, stateBox } from "./shell.js";
import { noteReader, openNoteEditor } from "./notes.js";
import { taskComposer, taskRow } from "./taskrow.js";

export async function tabBody(body, ctx) {
  const { tab, record, slug, alive, counts } = ctx;
  const recordId = record.id.record_id;
  body.replaceChildren(el("div", { class: "at-hint", text: "Loading…" }));
  try {
    const notesPager = pager(ctx, "notes", (offset) => call("notes.list", { parent_object: slug, parent_record_id: recordId, limit: PAGE, offset }).then((r) => r.data));
    // Open tasks are paged first and completed ones after, so an open task is never hidden behind older completed ones.
    const taskPhase = (isCompleted) => async (offset) => {
      const page = (await call("tasks.list", { linked_object: slug, linked_record_id: recordId, is_completed: isCompleted, limit: PAGE, offset })).data;
      await resolveNames(page);
      return page;
    };
    const tasksPager = pager(ctx, "tasks", taskPhase(false), taskPhase(true));
    await Promise.all([notesPager.next(), tasksPager.next()]);
    if (!alive()) return undefined;
    const notes = notesPager.items;
    body.replaceChildren();
    if (tab === "notes") return notesTab(body, ctx, notesPager);
    if (tab === "tasks") return tasksTab(body, ctx, tasksPager);
    if (tab === "team") return teamTab(body, ctx);
    // The Overview asks the server for open tasks directly instead of filtering a page of all tasks.
    const open = (await call("tasks.list", { linked_object: slug, linked_record_id: recordId, is_completed: false, limit: OVERVIEW_TASKS })).data;
    await resolveNames(open);
    if (!alive()) return undefined;
    return overview(body, ctx, notes, open);
  } catch (error) {
    if (alive()) body.replaceChildren(errorState(error, ctx.onChanged));
    return undefined;
  }
}

/** Offset pager over one of the record's collections, read as consecutive phases (each its own offset sequence); keeps
 * the tab counter at "N+" until the last page of the last phase is read. One click reads at most one request per phase. */
function pager(ctx, kind, ...phases) {
  const state = { items: [], more: true, phase: 0, offset: 0 };
  state.next = async () => {
    while (state.phase < phases.length) {
      const page = await phases[state.phase](state.offset);
      state.items.push(...page);
      if (page.length === PAGE) { state.offset += PAGE; break; }
      state.phase += 1;
      state.offset = 0;
    }
    if (kind === "notes") state.items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    state.more = state.phase < phases.length;
    ctx.counts(kind, countLabel(state.items, state.more));
  };
  return state;
}

function loadMoreButton(label, source, redraw) {
  const more = button(label, { class: "ghost small", onClick: async () => {
    more.disabled = true;
    try {
      await source.next();
      if (ctx_alive(more)) redraw();
    } catch (error) {
      more.disabled = false;
      toast(describe(error), { error: true });
    }
  } });
  return more;
}
const ctx_alive = (node) => node.isConnected;

function overview(body, ctx, notes, open) {
  const { record, defs, slug } = ctx;
  const highlights = el("div", { class: "at-highlights" });
  const picks = defs.filter((d) => !["name", "record_id"].includes(d.api_slug) && d.type !== "personal-name").slice(0, 6);
  for (const d of picks) {
    highlights.append(el("div", { class: "at-card at-highlight" }, [el("span", { class: "at-highlight-label" }, [icon(typeIcon(d.type), "", 14), el("span", { text: d.title })]), renderValues(d, record.values[d.api_slug] ?? [], "detail")]));
  }
  body.append(el("h2", { class: "at-panel-title", text: "Highlights" }), highlights);
  body.append(el("h2", { class: "at-panel-title" }, [el("span", { text: "Tasks" }), el("span", { class: "grow" }), button("View all", { class: "small ghost", onClick: () => { location.hash = `#/${slug}/${record.id.record_id}/tasks`; } })]));
  const taskCard = el("div", { class: "at-card" });
  taskCard.style.marginBottom = "24px";
  if (open.length === 0) taskCard.append(el("div", { class: "at-hint pad", text: "No open tasks" }));
  for (const t of open) taskCard.append(taskRow(t, ctx.onChanged));
  body.append(taskCard);
  body.append(el("h2", { class: "at-panel-title" }, [el("span", { text: "Notes" }), el("span", { class: "grow" }), button("View all", { class: "small ghost", onClick: () => { location.hash = `#/${slug}/${record.id.record_id}/notes`; } })]));
  body.append(noteCards(notes.slice(0, 4), ctx));
  return undefined;
}

function noteCards(notes, ctx, onPick) {
  const grid = el("div", { class: "at-note-cards" });
  if (notes.length === 0) grid.append(el("div", { class: "at-hint", text: "No notes yet" }));
  for (const n of notes) {
    const author = n.created_by_actor?.type === "workspace-member" ? n.created_by_actor.id : undefined;
    const c = el("button", { class: "at-card at-note-card", attrs: { type: "button" } }, [
      el("span", { class: "at-note-item-title", text: n.title || "Untitled note" }),
      el("span", { class: "at-note-item-snippet", text: n.content_plaintext || "No content" }),
      el("span", { class: "at-note-item-meta" }, [el("span", { text: author ? store.membersById.get(author)?.first_name ?? "Member" : "API" }), el("span", { text: `· ${relative(n.created_at)}` })]),
    ]);
    c.addEventListener("click", () => {
      focusNote = n.id.note_id;
      if (onPick) onPick(n);
      else location.hash = `#/${ctx.slug}/${ctx.record.id.record_id}/notes`;
    });
    grid.append(c);
  }
  return grid;
}

let focusNote;

function notesTab(body, ctx, pager) {
  let editor;
  const parent = { object: ctx.slug, record_id: ctx.record.id.record_id, name: ctx.name };
  const add = button("Add note", { class: "small", icon: "plus", onClick: () => { editor = openNoteEditor(parent, () => ctx.onChanged()); } });
  const draw = () => {
    const notes = pager.items;
    body.replaceChildren(el("h2", { class: "at-panel-title" }, [el("span", { text: "Notes" }), el("span", { class: "grow" }), add]));
    if (notes.length === 0) {
      body.append(stateBox({ iconName: "note", title: "No notes", text: `Capture meeting notes and context about ${ctx.name}.`, action: button("Add note", { icon: "plus", onClick: () => add.click() }) }));
      return;
    }
    const readerFor = (note) => {
      const r = noteReader(note, () => ctx.onChanged());
      r.classList.add("at-card");
      r.style.cssText = "margin-top:16px;padding:20px 24px;overflow:visible";
      return r;
    };
    let reader = readerFor(notes.find((n) => n.id.note_id === focusNote) ?? notes[0]);
    const cards = noteCards(notes, ctx, (note) => { focusNote = note.id.note_id; const next = readerFor(note); reader.replaceWith(next); reader = next; });
    body.append(cards);
    if (pager.more) body.append(el("div", { class: "at-load-more" }, loadMoreButton("Load more notes", pager, draw)));
    body.append(reader);
  };
  draw();
  return { unsaved: () => Boolean(editor?.unsaved()) };
}

function tasksTab(body, ctx, pager) {
  const composer = taskComposer(() => ctx.onChanged(), { object: ctx.slug, record_id: ctx.record.id.record_id, name: ctx.name });
  const card = el("div", { class: "at-card" });
  const draw = () => {
    const tasks = pager.items;
    card.replaceChildren(composer.form);
    if (tasks.length === 0) card.append(el("div", { class: "at-hint pad", text: "No tasks" }));
    const ordered = [...tasks].sort((a, b) => Number(a.is_completed) - Number(b.is_completed));
    for (const t of ordered) card.append(taskRow(t, ctx.onChanged));
    if (pager.more) card.append(el("div", { class: "at-load-more pad" }, loadMoreButton("Load more tasks", pager, draw)));
  };
  body.append(el("h2", { class: "at-panel-title", text: "Tasks" }), card);
  draw();
  return { unsaved: composer.unsaved };
}

async function teamTab(body, ctx) {
  const people = (ctx.record.values.team ?? []).filter((v) => v.target_object === "people");
  body.append(el("h2", { class: "at-panel-title" }, [el("span", { text: "Team" }), el("span", { class: "at-tab-count", text: String(people.length) })]));
  if (people.length === 0) {
    body.append(stateBox({ iconName: "users", title: "No team members", text: "People linked to this company through the Team attribute appear here." }));
    return undefined;
  }
  const card = el("div", { class: "at-card" });
  const records = await Promise.all(people.map((p) => call("records.get", { object: "people", record_id: p.target_record_id }).then((r) => r.data, () => undefined)));
  for (const person of records.filter(Boolean)) {
    const name = person.values.name?.[0]?.full_name ?? "Unnamed";
    const row = el("a", { class: "at-task", attrs: { href: `#/people/${person.id.record_id}` } }, [recordAvatar("people", name, person.id.record_id), el("span", { class: "at-task-text", text: name }), el("span", { class: "at-hint", text: person.values.job_title?.[0]?.value ?? "" }), el("span", { class: "at-hint", text: person.values.email_addresses?.[0]?.email_address ?? "" })]);
    card.append(row);
  }
  body.append(card);
  return undefined;
}
