// Record page: header, tabs, and the right-hand "Record details" panel with list memberships.
import { icon, typeIcon } from "./icons.js";
import { attributes, loadNames, recordTitle, resolveNames, store } from "./store.js";
import { action, button, call, confirmDialog, el, iconButton, menu, newKey, toast } from "./ui.js";
import { editValue, recordAvatar, renderValues } from "./values.js";
import { errorState, nsButton, objectCrumb, pageHeader, stateBox } from "./shell.js";
import { addToList, listSection } from "./recordlists.js";
import { tabBody } from "./recordtabs.js";

const TABS = [
  ["overview", "Overview", "overview"],
  ["activity", "Activity", "activity", "The activity timeline (field changes, emails and calls) is not simulated."],
  ["emails", "Emails", "mail", "Mailbox sync is not simulated; no email is read or sent."],
  ["calls", "Calls", "phone", "Call recordings are not simulated."],
  ["team", "Team", "users"],
  ["notes", "Notes", "note"],
  ["tasks", "Tasks", "tasks"],
  ["files", "Files", "file", "File attachments are not simulated."],
];

export async function renderRecord(main, { alive, slug, recordId, tab = "overview" }) {
  const object = store.objectsBySlug.get(slug);
  main.replaceChildren(pageHeader([objectCrumb(object), { label: "Loading…", muted: true }]), el("div", { class: "at-state" }, el("span", { class: "at-hint", text: "Loading record…" })));
  let record;
  let defs;
  try {
    [record, defs] = await Promise.all([call("records.get", { object: slug, record_id: recordId }).then((r) => r.data), attributes("objects", slug), loadNames()]);
    await resolveNames(record);
  } catch (error) {
    if (!alive()) return undefined;
    const missing = error?.is?.("NOT_FOUND");
    main.replaceChildren(pageHeader([objectCrumb(object)]), missing ? stateBox({ iconName: "search", title: "Record not found", text: "This record may have been deleted or merged.", action: button(`Back to ${object.plural_noun}`, { onClick: () => { location.hash = `#/${slug}`; } }) }) : errorState(error, () => void renderRecord(main, { alive, slug, recordId, tab })));
    return undefined;
  }
  if (!alive()) return undefined;
  defs = defs.filter((d) => !d.is_archived);
  const name = recordTitle(record);
  const reload = () => renderRecord(main, { alive, slug, recordId, tab });
  const tabs = TABS.filter(([id]) => id !== "team" || slug === "companies");
  if (!tabs.some(([id, , , ns]) => id === tab && !ns)) tab = "overview";

  const more = iconButton("more", "Record actions", () => menu(more, [
    { label: "Copy record ID", icon: "link", onSelect: () => { void navigator.clipboard?.writeText(recordId).then(() => toast("Record ID copied"), () => toast(recordId)); } },
    "divider",
    { label: `Delete ${object.singular_noun.toLowerCase()}`, icon: "trash", danger: true, onSelect: () => void deleteRecord() },
  ], { align: "end" }));
  const star = nsButton("Add to favorites", "Favorites are not simulated.", { icon: "star", iconOnly: true, class: "ghost" });
  const header = pageHeader([objectCrumb(object), { label: name }], [star, nsButton("Compose email", "Sending email is not simulated.", { icon: "mail", iconOnly: true, class: "ghost" }), more]);

  const sub = el("div", { class: "at-record-sub" });
  const firstEmail = record.values.email_addresses?.[0]?.email_address;
  const firstDomain = record.values.domains?.[0]?.domain;
  if (firstEmail || firstDomain) sub.append(icon(firstEmail ? "at" : "globe", "", 12), el("span", { text: firstEmail ?? firstDomain }));
  else sub.append(el("span", { text: object.singular_noun }));
  const head = el("div", { class: "at-record-head" }, [recordAvatar(slug, name, recordId, "large"), el("div", { class: "grow" }, [el("h1", { class: "at-record-title", text: name }), sub])]);

  const tabBar = el("div", { class: "at-tabs", attrs: { role: "tablist", "aria-label": "Record tabs" } });
  const body = el("div", { class: "at-tab-body", attrs: { role: "tabpanel" } });
  for (const [id, label, glyph, ns] of tabs) {
    const t = el("button", { class: `at-tab${ns ? " ns" : ""}`, attrs: { type: "button", role: "tab", "aria-selected": String(id === tab) } }, [icon(glyph), el("span", { text: label })]);
    if (id === "notes" || id === "tasks") t.append(el("span", { class: "at-tab-count", attrs: { "data-count": id } }));
    t.addEventListener("click", () => {
      if (ns) return void import("./ui.js").then((m) => m.notSimulated(t, label, ns));
      location.hash = `#/${slug}/${recordId}/${id}`;
    });
    tabBar.append(t);
  }

  const side = el("aside", { class: "at-side", attrs: { "aria-label": "Record details" } });
  const sideTabs = el("div", { class: "at-side-tabs" }, [
    el("button", { class: "at-tab", attrs: { type: "button", "aria-selected": "true" } }, [el("span", { text: "Details" })]),
    nsTab("Comments", "Comments on records are not simulated."),
  ]);
  side.append(sideTabs, detailsSection(), el("div", { class: "at-side-section" }, el("div", { class: "at-hint", text: "Loading lists…" })));

  main.replaceChildren(header, el("div", { class: "at-record" }, [el("div", { class: "at-record-main" }, [head, tabBar, body]), side]));
  const lists = side.lastElementChild;
  void listSection({ record, slug, alive, onChanged: reload, addButton: () => button("Add to list", { class: "small", icon: "plus", onClick: (event) => addToList(event.currentTarget, record, slug, reload) }) }).then((section) => { if (alive() && section) lists.replaceWith(section); });
  const result = await tabBody(body, { tab, record, slug, defs, name, alive, onChanged: reload, counts: (id, n) => { const c = tabBar.querySelector(`[data-count="${id}"]`); if (c) c.textContent = String(n); } });
  return result;

  function nsTab(label, detail) {
    const t = el("button", { class: "at-tab ns", attrs: { type: "button" } }, el("span", { text: label }));
    t.addEventListener("click", () => void import("./ui.js").then((m) => m.notSimulated(t, label, detail)));
    return t;
  }

  function detailsSection() {
    const section = el("section", { class: "at-side-section" }, el("div", { class: "at-side-head" }, [icon("list"), el("span", { text: "Record Details" })]));
    for (const def of defs.filter((d) => d.api_slug !== "record_id")) {
      const values = record.values[def.api_slug] ?? [];
      const valueNode = def.is_writable ? el("button", { class: "at-attr-value", attrs: { type: "button", "aria-label": `Edit ${def.title}` } }, renderValues(def, values, "detail")) : el("div", { class: "at-attr-value" }, renderValues(def, values, "detail"));
      if (def.is_writable) {
        valueNode.addEventListener("click", () => editValue(valueNode, { target: "objects", slug, def, values, save: async (next) => {
          await call("records.update", { object: slug, record_id: recordId, mode: "overwrite", data: { values: { [def.api_slug]: next } } }, newKey());
          toast(`${def.title} updated`);
          void reload();
        } }));
      }
      section.append(el("div", { class: "at-attr-row" }, [el("span", { class: "at-attr-label", title: def.title }, [icon(typeIcon(def.type)), el("span", { text: def.title })]), valueNode]));
    }
    return section;
  }

  async function deleteRecord() {
    const ok = await confirmDialog(`Delete ${name}?`, `This ${object.singular_noun.toLowerCase()} is removed from every list, its notes and tasks links are removed, and references to it are cleared. This cannot be undone.`);
    if (!ok) return;
    await action(async () => {
      await call("records.delete", { object: slug, record_id: recordId }, newKey());
      toast(`${object.singular_noun} deleted`);
      location.hash = `#/${slug}`;
    });
  }
}
