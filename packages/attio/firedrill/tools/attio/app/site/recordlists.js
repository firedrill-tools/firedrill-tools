// "Lists" section of the record details panel: the record's entries in each visible list, editable in place.
import { icon, typeIcon } from "./icons.js";
import { attributes, resolveNames, store } from "./store.js";
import { action, call, closePopover, confirmDialog, describe, el, iconButton, menu, newKey, toast } from "./ui.js";
import { editValue, renderValues } from "./values.js";

function levelFor(list) {
  if (store.me?.access_level === "admin") return "full-access";
  const me = store.self.authorized_by_workspace_member_id;
  const levels = [list.workspace_access, ...list.workspace_member_access.filter((a) => a.workspace_member_id === me).map((a) => a.level)];
  return levels.includes("full-access") ? "full-access" : levels.includes("read-and-write") ? "read-and-write" : "read-only";
}

const ENTRY_PAGE = 500;
export const ENTRY_CAP = 1000;

/** Every entry of the record in each visible list, paged; a list holding more than ENTRY_CAP entries for the record is
 * reported in `truncated` so the panel can say so. */
export async function entriesOf(record, slug) {
  const out = [];
  const truncated = [];
  for (const list of store.lists.filter((l) => l.parent_object.includes(slug))) {
    const filter = { path: [[list.api_slug, "parent_record"], [slug, "record_id"]], constraints: { value: record.id.record_id } };
    for (let offset = 0; ; offset += ENTRY_PAGE) {
      if (offset >= ENTRY_CAP) {
        // One single-row read tells exactly ENTRY_CAP entries apart from more than that.
        if ((await call("entries.query", { list: list.api_slug, filter, limit: 1, offset })).data.length > 0) truncated.push(list);
        break;
      }
      const entries = (await call("entries.query", { list: list.api_slug, filter, limit: ENTRY_PAGE, offset })).data;
      for (const entry of entries) out.push({ list, entry });
      if (entries.length < ENTRY_PAGE) break;
    }
  }
  return { found: out, truncated };
}

export function addToList(anchor, record, slug, onChanged) {
  const candidates = store.lists.filter((l) => l.parent_object.includes(slug) && levelFor(l) !== "read-only");
  if (candidates.length === 0) return void menu(anchor, [{ label: "No lists you can add to", disabled: true }]);
  menu(anchor, [{ header: "Add to list" }, ...candidates.map((list) => ({
    label: list.name,
    leading: el("span", { class: "at-list-icon" }, icon("list", "", 12)),
    onSelect: () => void action(async () => {
      await call("entries.create", { list: list.api_slug, data: { parent_record_id: record.id.record_id, parent_object: slug, entry_values: {} } }, newKey());
      toast(`Added to ${list.name}`);
      onChanged();
    }),
  }))], { width: 260 });
}

export async function listSection({ record, slug, alive, onChanged, addButton }) {
  const section = el("section", { class: "at-side-section" });
  const head = el("div", { class: "at-side-head" }, [icon("list"), el("span", { text: "Lists" }), el("span", { class: "grow" }), addButton()]);
  section.append(head);
  if (store.listsDenied) {
    section.append(el("div", { class: "at-hint", text: "You don't have access to lists." }));
    return section;
  }
  try {
    const { found, truncated } = await entriesOf(record, slug);
    await resolveNames(found.map((f) => f.entry));
    if (!alive()) return undefined;
    if (found.length === 0) section.append(el("div", { class: "at-hint", text: "This record has not been added to any lists." }));
    for (const { list, entry } of found) {
      const readOnly = levelFor(list) === "read-only";
      const defs = (await attributes("lists", list.api_slug)).filter((d) => !d.is_archived);
      const more = iconButton("more", `${list.name} entry actions`, () => menu(more, [
        { label: "Open list", icon: "arrowUpRight", onSelect: () => { location.hash = `#/lists/${list.api_slug}`; } },
        { label: "Remove from list", icon: "trash", danger: true, disabled: readOnly, onSelect: async () => {
          if (!(await confirmDialog("Remove from list?", `This record will be removed from ${list.name}.`, "Remove"))) return;
          await action(async () => { await call("entries.delete", { list: list.api_slug, entry_id: entry.id.entry_id }, newKey()); toast(`Removed from ${list.name}`); onChanged(); });
        } },
      ], { align: "end" }), "small");
      const card = el("div", { class: "at-card at-entry-card" }, el("div", { class: "at-entry-card-head" }, [el("span", { class: "at-list-icon" }, icon("list", "", 12)), el("span", { text: list.name }), readOnly ? el("span", { class: "at-lock-badge" }, [icon("lock", "", 12), el("span", { text: "Read only" })]) : null, el("span", { class: "grow" }), more]));
      for (const def of defs) {
        const values = entry.entry_values[def.api_slug] ?? [];
        const editable = def.is_writable && !readOnly;
        const node = el(editable ? "button" : "div", { class: "at-attr-value", attrs: editable ? { type: "button", "aria-label": `Edit ${def.title} in ${list.name}` } : {} }, renderValues(def, values, "detail"));
        if (editable) node.addEventListener("click", () => editValue(node, { target: "lists", slug: list.api_slug, def, values, save: async (next) => {
          await call("entries.update", { list: list.api_slug, entry_id: entry.id.entry_id, mode: "overwrite", data: { entry_values: { [def.api_slug]: next } } }, newKey());
          closePopover();
          toast(`${def.title} updated`);
          onChanged();
        } }));
        card.append(el("div", { class: "at-attr-row" }, [el("span", { class: "at-attr-label" }, [icon(typeIcon(def.type)), el("span", { text: def.title })]), node]));
      }
      section.append(card);
    }
    for (const list of truncated) section.append(el("div", { class: "at-hint", text: `Showing the first ${ENTRY_CAP.toLocaleString("en-US")} entries in ${list.name}. Open the list to see the rest.` }));
  } catch (error) {
    section.append(el("div", { class: "at-field-error", text: describe(error) }));
  }
  return section;
}
