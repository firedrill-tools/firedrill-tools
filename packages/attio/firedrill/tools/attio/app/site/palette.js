// ⌘K command palette: jump to pages and search records across objects (records.search).
import { icon } from "./icons.js";
import { store } from "./store.js";
import { $, call, describe, el } from "./ui.js";
import { objectBadge, recordAvatar } from "./values.js";

let seq = 0;
let items = [];
let active = 0;

function pages() {
  const list = [
    { label: "Tasks", sub: "Page", href: "#/tasks", leading: icon("tasks") },
    { label: "Notes", sub: "Page", href: "#/notes", leading: icon("note") },
    ...store.objects.map((o) => ({ label: o.plural_noun, sub: "Object", href: `#/${o.api_slug}`, leading: objectBadge(o.api_slug) })),
    ...store.lists.map((l) => ({ label: l.name, sub: "List", href: `#/lists/${l.api_slug}`, leading: el("span", { class: "at-list-icon" }, icon("list", "", 12)) })),
  ];
  return list;
}

function draw(groups) {
  const host = $("#palette-results");
  host.replaceChildren();
  items = [];
  for (const [title, entries] of groups) {
    if (entries.length === 0) continue;
    host.append(el("div", { class: "at-palette-group", text: title }));
    for (const entry of entries) {
      const index = items.length;
      const row = el("button", { class: "at-palette-item", attrs: { type: "button", role: "option", id: `palette-item-${index}`, "aria-selected": String(index === active) } }, [entry.leading, el("span", { text: entry.label }), el("span", { class: "sub", text: entry.sub })]);
      row.addEventListener("click", () => go(entry));
      row.addEventListener("mousemove", () => select(index));
      items.push({ entry, row });
      host.append(row);
    }
  }
  if (items.length === 0) host.append(el("div", { class: "at-hint pad", text: "No results" }));
  select(Math.min(active, Math.max(0, items.length - 1)));
}

function select(index) {
  active = index;
  items.forEach(({ row }, i) => row.setAttribute("aria-selected", String(i === index)));
  const current = items[index]?.row;
  if (current) {
    current.scrollIntoView({ block: "nearest" });
    $("#palette-input").setAttribute("aria-activedescendant", current.id);
  }
}

function go(entry) {
  $("#palette").close();
  location.hash = entry.href;
}

async function run(query) {
  const mine = ++seq;
  const q = query.trim().toLowerCase();
  const matchingPages = pages().filter((p) => q === "" || p.label.toLowerCase().includes(q));
  active = 0;
  draw([["Pages", matchingPages]]);
  if (q === "") return;
  try {
    const hits = (await call("records.search", { query: query.trim(), objects: store.objects.map((o) => o.api_slug), request_as: { type: "workspace" }, limit: 8 })).data;
    if (mine !== seq) return;
    draw([["Records", hits.map((h) => ({ label: h.record_text || "Unnamed", sub: store.objectsBySlug.get(h.object_slug)?.singular_noun ?? h.object_slug, href: `#/${h.object_slug}/${h.id.record_id}`, leading: recordAvatar(h.object_slug, h.record_text, h.id.record_id, "tiny") }))], ["Pages", matchingPages]]);
  } catch (error) {
    if (mine !== seq) return;
    draw([["Pages", matchingPages]]);
    $("#palette-results").prepend(el("div", { class: "at-field-error pad", text: describe(error) }));
  }
}

let wired = false;
export function openPalette() {
  const dialog = $("#palette");
  if (dialog.open) return;
  const input = $("#palette-input");
  if (!wired) {
    wired = true;
    let timer;
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => void run(input.value), 150); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (items.length) select((active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
      } else if (event.key === "Enter" && items[active]) {
        event.preventDefault();
        go(items[active].entry);
      }
    });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }
  input.value = "";
  dialog.showModal();
  input.focus();
  void run("");
}
