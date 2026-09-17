// Contact detail: details panel, Outstanding / Overdue balances, paged invoices and bills, Edit and Archive/Restore.
import { go, listPage, register } from "../store.js";
import { amount, call, dmy, el, errorBanner, icon, newKey, skeletonRows, toast } from "../ui.js";
import { confirmDialog, openMenu } from "../overlay.js";
import { initials, pageHead, pager, statusTag } from "./common.js";
import { openContactForm } from "./contact-form.js";

async function render(host, route) {
  host.replaceChildren(el("div", { class: "loading" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: "Loading…" })]));
  let c;
  try {
    c = (await call("contacts.get", { contactId: route.id })).Contacts?.[0];
  } catch (error) {
    host.replaceChildren(el("div", { class: "page-inner" }, errorBanner(error, error?.is?.("NOT_FOUND") ? "This contact doesn't exist" : "We couldn't load this contact")));
    return;
  }
  const refresh = () => render(host, route);
  const archived = c.ContactStatus === "ARCHIVED";
  const setStatus = async (status) => {
    try {
      const out = await call("contacts.save", { method: "POST", pathContactId: c.ContactID, body: { ContactID: c.ContactID, ContactStatus: status }, summarizeErrors: false }, newKey());
      const row = out.Contacts?.[0];
      if (row?.StatusAttributeString === "ERROR") throw new Error((row.ValidationErrors ?? []).map((v) => v.Message).join(" "));
      toast(status === "ARCHIVED" ? `${c.Name} archived` : `${c.Name} restored`);
      await refresh();
    } catch (error) { toast(error.message, { error: true }); }
  };
  const options = [
    { label: "Edit", run: () => openContactForm(c, () => refresh()) },
    archived ? { label: "Restore", run: () => setStatus("ACTIVE") } : { label: "Archive", run: async () => { if (await confirmDialog("Archive contact", `Archive ${c.Name}? Archived contacts are hidden from your lists and can be restored later.`, "Archive", "negative")) setStatus("ARCHIVED"); } },
    { label: "Merge" }, { label: "Add to group" },
  ];
  const actions = [
    el("button", { type: "button", class: "btn", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, options, { align: "right" }); } }, ["Options", icon("chevron", 18)]),
    el("button", { type: "button", class: "btn", text: "Edit", onclick: () => openContactForm(c, () => refresh()) }),
    el("button", { type: "button", class: "btn main", "aria-haspopup": "menu", onclick: (e) => { e.stopPropagation(); openMenu(e.currentTarget, [{ label: "Invoice", run: () => go("#/invoices/new") }, { label: "Bill", run: () => go("#/bills/new") }, { label: "Quote" }, { label: "Purchase order" }], { align: "right" }); } }, ["New", icon("chevron", 18)]),
  ];
  const head = pageHead({ crumbs: [["Contacts", "#/contacts"]], title: c.Name, titleExtra: archived ? el("span", { class: "tag ARCHIVED", text: "Archived" }) : null, actions });
  const phone = (c.Phones ?? []).find((p) => p.PhoneNumber);
  const addr = (c.Addresses ?? []).find((a) => a.AddressLine1 || a.City);
  const meta = (k, v) => el("div", { class: "meta" }, [el("div", { class: "k", text: k }), el("div", { class: "v", text: v || "—" })]);
  const side = el("aside", { class: "side", "aria-label": "Contact details" }, [el("div", { class: "avatar-lg", text: initials(c.Name) }), el("h2", { text: "Contact details" }),
    meta("Primary person", [c.FirstName, c.LastName].filter(Boolean).join(" ")), meta("Email", c.EmailAddress), meta("Phone", phone ? [phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(" ") : ""),
    meta("Address", addr ? [addr.AddressLine1, addr.AddressLine2, addr.City, addr.Region, addr.PostalCode, addr.Country].filter(Boolean).join(", ") : ""),
    meta("Contact type", [c.IsCustomer ? "Customer" : "", c.IsSupplier ? "Supplier" : ""].filter(Boolean).join(", "))]);
  const b = c.Balances ?? {};
  const tile = (k, v, over) => el("div", { class: "money-tile" }, [el("div", { class: "k", text: k }), el("div", { class: `v${over && v > 0 ? " overdue" : ""}`, text: amount(v) })]);
  const tiles = el("div", { class: "money-tiles" }, [tile("They owe · Outstanding", b.AccountsReceivable?.Outstanding ?? 0), tile("They owe · Overdue", b.AccountsReceivable?.Overdue ?? 0, true), tile("You owe · Outstanding", b.AccountsPayable?.Outstanding ?? 0), tile("You owe · Overdue", b.AccountsPayable?.Overdue ?? 0, true)]);
  const tbody = el("tbody", {}, skeletonRows(6, 4));
  const footer = el("div");
  const panel = el("div", { class: "panel" }, [el("div", { class: "toolbar" }, el("strong", { text: "Invoices and bills" })), el("div", { class: "table-scroll" }, el("table", { class: "xt" }, [
    el("thead", {}, el("tr", {}, ["Number", "Type", "Date", "Due date", "Due", "Status"].map((h, i) => el("th", { class: i === 4 ? "num" : "", text: h })))), tbody])), footer]);
  host.replaceChildren(head, el("div", { class: "page-inner" }, el("div", { class: "contact-layout" }, [side, el("div", {}, [tiles, panel])])));

  const page = Math.max(1, Number.parseInt(route.params.get("page") ?? "1", 10) || 1);
  try {
    const result = await listPage("invoices.list", "Invoices", { contactIds: [c.ContactID], where: `Status!="DELETED"`, order: "Date DESC", page, pageSize: 10, summaryOnly: true });
    tbody.replaceChildren(...(result.rows.length ? result.rows.map((inv) => {
      const href = `#/${inv.Type === "ACCPAY" ? "bills" : "invoices"}/${encodeURIComponent(inv.InvoiceID)}`;
      return el("tr", { class: "clickable", onclick: () => go(href) }, [el("td", {}, el("a", { class: "primary-cell", href, text: inv.InvoiceNumber || "—" })), el("td", { text: inv.Type === "ACCPAY" ? "Bill" : "Invoice" }),
        el("td", { text: dmy(inv.DateString) }), el("td", { text: dmy(inv.DueDateString) }), el("td", { class: "num", text: amount(inv.AmountDue) }), el("td", {}, statusTag(inv))]);
    }) : [el("tr", {}, el("td", { colspan: "6" }, el("div", { class: "empty", text: "There are no transactions for this contact" })))]));
    footer.replaceChildren(pager(result.pagination, ({ page: pg }) => go(`#/contacts/${encodeURIComponent(c.ContactID)}?page=${pg}`), [10]));
  } catch (error) {
    tbody.replaceChildren(el("tr", {}, el("td", { colspan: "6" }, errorBanner(error, "Transactions couldn't load"))));
  }
}

register("contact", render);
