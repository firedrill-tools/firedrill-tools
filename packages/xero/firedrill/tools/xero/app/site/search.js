// Header search: contacts by name (contacts.list searchTerm) and invoices/bills by number or reference (invoices.list where).
import { go } from "./store.js";
import { $, call, el, lit } from "./ui.js";

let seq = 0;
async function run(text) {
  const box = $("#xsearch-results");
  const q = text.trim();
  const mine = (seq += 1);
  if (!q) { box.replaceChildren(el("div", { class: "res-empty", text: "Type a contact name or an invoice number" })); return; }
  box.replaceChildren(el("div", { class: "res-empty", text: "Searching…" }));
  const [contacts, invoices] = await Promise.all([
    call("contacts.list", { searchTerm: q, page: 1, pageSize: 5, summaryOnly: true }).then((o) => o.Contacts ?? []).catch((e) => e),
    call("invoices.list", { where: `InvoiceNumber.Contains(${lit(q)})||Reference.Contains(${lit(q)})`, page: 1, pageSize: 6, summaryOnly: true, order: "Date DESC" }).then((o) => o.Invoices ?? []).catch((e) => e),
  ]);
  if (mine !== seq) return;
  const rows = [];
  const pick = (hash) => () => { close(); go(hash); };
  if (Array.isArray(contacts) && contacts.length) {
    rows.push(el("div", { class: "res-head", text: "Contacts" }));
    for (const c of contacts) rows.push(el("button", { type: "button", class: "res", role: "option", onclick: pick(`#/contacts/${encodeURIComponent(c.ContactID)}`) }, [el("span", { text: c.Name }), el("span", { class: "res-kind", text: c.EmailAddress ?? "" })]));
  }
  if (Array.isArray(invoices) && invoices.length) {
    rows.push(el("div", { class: "res-head", text: "Transactions" }));
    for (const i of invoices) {
      const bill = i.Type === "ACCPAY";
      rows.push(el("button", { type: "button", class: "res", role: "option", onclick: pick(`#/${bill ? "bills" : "invoices"}/${encodeURIComponent(i.InvoiceID)}`) },
        [el("span", { text: `${bill ? "Bill" : "Invoice"} ${i.InvoiceNumber || "(no number)"}` }), el("span", { class: "res-kind", text: i.Contact?.Name ?? "" })]));
    }
  }
  if (contacts instanceof Error || invoices instanceof Error) rows.push(el("div", { class: "res-empty error", text: (contacts instanceof Error ? contacts : invoices).message }));
  if (!rows.length) rows.push(el("div", { class: "res-empty", text: `No results for “${q}”` }));
  box.replaceChildren(...rows);
}
function close() { $("#xsearch").hidden = true; $("#xsearch-input").value = ""; }

export function initSearch() {
  const input = $("#xsearch-input");
  let timer;
  $("#search-btn").addEventListener("click", () => { const s = $("#xsearch"); s.hidden = !s.hidden; if (!s.hidden) { input.focus(); run(input.value); } });
  $("#xsearch-close").addEventListener("click", close);
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => run(input.value), 250); });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  $("#xsearch-form").addEventListener("submit", (e) => { e.preventDefault(); run(input.value); });
}
