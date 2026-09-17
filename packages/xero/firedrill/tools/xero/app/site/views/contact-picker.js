// Contact typeahead: searches contacts.list as the user types (paged, 10 at a time with "Show more"); a new name
// becomes Contact { Name }, which Xero creates when the document is saved.
import { call, el } from "../ui.js";

export function contactPicker({ id, label, initial, onChange }) {
  let selected = initial?.ContactID ? { ContactID: initial.ContactID, Name: initial.Name } : null;
  const input = el("input", { class: "input", id, value: selected?.Name ?? "", autocomplete: "off", role: "combobox", "aria-expanded": "false", "aria-autocomplete": "list", "aria-controls": `${id}-list` });
  const list = el("div", { class: "typeahead-list", id: `${id}-list`, role: "listbox", hidden: true });
  let seq = 0;
  let page = 1;
  let rows = [];

  const choose = (value) => { selected = value; input.value = value.Name; close(); onChange(); };
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  async function search(more = false) {
    const term = input.value.trim();
    const mine = (seq += 1);
    page = more ? page + 1 : 1;
    if (!more) rows = [];
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    if (!more) list.replaceChildren(el("div", { class: "typeahead-note", text: "Searching…" }));
    let out;
    try {
      out = await call("contacts.list", { ...(term ? { searchTerm: term } : {}), page, pageSize: 10, summaryOnly: true });
    } catch (error) {
      if (mine === seq) list.replaceChildren(el("div", { class: "typeahead-note", text: error.message }));
      return;
    }
    if (mine !== seq) return;
    rows.push(...(out.Contacts ?? []));
    const opts = rows.map((c) => el("button", { type: "button", class: "typeahead-opt", role: "option", text: c.Name, onclick: () => choose({ ContactID: c.ContactID, Name: c.Name }) }));
    const kids = [...opts];
    if (out.pagination && out.pagination.page < out.pagination.pageCount) kids.push(el("button", { type: "button", class: "typeahead-opt", text: "Show more contacts", onclick: () => search(true) }));
    if (term && !rows.some((c) => c.Name.toLowerCase() === term.toLowerCase())) kids.push(el("button", { type: "button", class: "typeahead-opt", role: "option", text: `+ Add “${term}” as a new contact`, onclick: () => choose({ Name: term }) }));
    if (!kids.length) kids.push(el("div", { class: "typeahead-note", text: "No contacts yet. Type a name to add one." }));
    list.replaceChildren(...kids);
  }
  let timer;
  input.addEventListener("input", () => { selected = null; onChange(); clearTimeout(timer); timer = setTimeout(() => search(), 200); });
  input.addEventListener("focus", () => { if (!selected) search(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowDown") { list.querySelector(".typeahead-opt")?.focus(); e.preventDefault(); }
  });
  list.addEventListener("keydown", (e) => {
    const all = [...list.querySelectorAll(".typeahead-opt")];
    const i = all.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { all[Math.min(all.length - 1, i + 1)]?.focus(); e.preventDefault(); }
    if (e.key === "ArrowUp") { (i <= 0 ? input : all[i - 1]).focus(); e.preventDefault(); }
    if (e.key === "Escape") { close(); input.focus(); }
  });
  document.addEventListener("click", (e) => { if (!node.contains(e.target)) close(); });
  const node = el("div", { class: "field typeahead" }, [el("label", { for: id, text: label }), input, list]);
  return { node, value: () => selected ?? (input.value.trim() ? { Name: input.value.trim() } : null) };
}
