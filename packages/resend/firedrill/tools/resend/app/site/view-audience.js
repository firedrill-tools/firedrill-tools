// Audience: Contacts (search, segment filter, add, open panel) and Segments (list, create, delete).
import { refresh } from "./app.js";
import { openContact } from "./contact-panel.js";
import { icon } from "./icons.js";
import { Cursor, debounce, pagerBar, table } from "./list.js";
import { badge, button, call, confirmDialog, describe, el, emptyState, errorState, field, guard, modal, mutate, skeletonRows, timeCell, toast } from "./ui.js";

const contacts = { query: "", segmentId: "", cursor: new Cursor(), token: 0 };
const segCursor = new Cursor();

export async function allSegments() {
  const out = [];
  let after;
  for (let page = 0; page < 50; page += 1) {
    const list = await call("segments.list", { limit: 100, ...(after ? { after } : {}) });
    out.push(...list.data);
    if (!list.has_more || list.data.length === 0) break;
    after = list.data[list.data.length - 1].id;
  }
  return out;
}

function tabs(active) {
  const t = (label, href) => el("a", { text: label, attrs: { href, role: "tab", "aria-selected": String(label === active), class: "tab-link" } });
  return el("div", { class: "tabs", attrs: { role: "tablist" } }, [t("Contacts", "#/audience/contacts"), t("Segments", "#/audience/segments"), el("button", { text: "Topics", attrs: { type: "button", "data-soon": "Topics" } }), el("button", { text: "Properties", attrs: { type: "button", "data-soon": "Properties" } })]);
}

export async function renderContacts(_m, view, { refresh: again = false } = {}) {
  document.title = "Contacts · Resend (synthetic)";
  if (!again || !view.querySelector("#contacts-table")) {
    const search = el("input", { class: "input", attrs: { type: "search", placeholder: "Search by email or name...", "aria-label": "Search contacts" } });
    search.value = contacts.query;
    search.addEventListener("input", debounce(() => { contacts.query = search.value.trim(); contacts.cursor.reset(); void loadContacts(); }));
    const segment = el("select", { class: "select", attrs: { id: "contact-segment", "aria-label": "Filter by segment" } }, [el("option", { text: "All contacts", attrs: { value: "" } })]);
    segment.addEventListener("change", () => { contacts.segmentId = segment.value; contacts.cursor.reset(); void loadContacts(); });
    view.replaceChildren(
      el("div", { class: "page-head" }, [el("h1", { text: "Audience" }), el("div", { class: "head-actions" }, [button("Export", { iconName: "download", attrs: { "data-soon": "Export" } }), button("Add contacts", { variant: "primary", iconName: "plus", onClick: () => void addContact() })])]),
      tabs("Contacts"),
      el("div", { class: "toolbar" }, [el("div", { class: "search" }, [icon("search", 14), search]), segment]),
      el("div", { attrs: { id: "contacts-status" } }),
      el("div", { attrs: { id: "contacts-table" } }, [table(["Email", "Name", "Status", "Added"], skeletonRows(4, 8), "Contacts")]),
      el("div", { attrs: { id: "contacts-pager" } }),
    );
  }
  try {
    const segs = await allSegments();
    const select = view.querySelector("#contact-segment");
    select.replaceChildren(el("option", { text: "All contacts", attrs: { value: "" } }), ...segs.map((s) => el("option", { text: s.name, attrs: { value: s.id } })));
    if (!segs.some((s) => s.id === contacts.segmentId)) contacts.segmentId = "";
    select.value = contacts.segmentId;
  } catch { /* the contact list reports its own error */ }
  await loadContacts();
}

async function loadContacts() {
  const token = ++contacts.token;
  const args = { limit: 20, ...contacts.cursor.args() };
  if (contacts.query) args.query = contacts.query;
  if (contacts.segmentId) args.segmentId = contacts.segmentId;
  const status = document.querySelector("#contacts-status");
  const holder = document.querySelector("#contacts-table");
  const pager = document.querySelector("#contacts-pager");
  if (!holder) return;
  let list;
  try { list = await call("contacts.list", args); } catch (error) {
    if (token !== contacts.token) return;
    status.replaceChildren(errorState(error, () => void loadContacts()));
    holder.replaceChildren();
    pager.replaceChildren();
    return;
  }
  if (token !== contacts.token) return;
  status.replaceChildren();
  if (list.data.length === 0 && contacts.cursor.page === 1) {
    holder.replaceChildren(contacts.query || contacts.segmentId ? emptyState("No contacts found", "No contacts match this search or segment.") : emptyState("No contacts yet", "Add contacts to build your audience.", button("Add contacts", { variant: "primary", iconName: "plus", onClick: () => void addContact() })));
    pager.replaceChildren();
    return;
  }
  const body = el("tbody", {}, list.data.map((c) => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
    const row = el("tr", { class: "row", attrs: { tabindex: "0", "aria-label": `Contact ${c.email}` } }, [
      el("td", {}, [el("div", { class: "cell-main" }, [el("span", { class: "tile avatar", text: (name || c.email).charAt(0).toUpperCase() }), el("span", { text: c.email })])]),
      el("td", { class: "muted", text: name || "—" }),
      el("td", {}, [badge(c.unsubscribed ? "unsubscribed" : "subscribed")]),
      el("td", { class: "muted" }, [timeCell(c.created_at)]),
    ]);
    const open = () => void openContact(c.id).then((changed) => { if (changed) void refresh(); });
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    return row;
  }));
  holder.replaceChildren(table(["Email", "Name", "Status", "Added"], body, "Contacts"));
  pager.replaceChildren(pagerBar(contacts.cursor, list, () => void loadContacts(), "contacts"));
}

async function addContact() {
  let segs = [];
  try { segs = await allSegments(); } catch { segs = []; }
  const done = await modal("Add contact", (close) => {
    const email = el("input", { class: "input", attrs: { id: "contact-email", type: "email", placeholder: "steve.wozniak@example.com", autocomplete: "off" } });
    const first = el("input", { class: "input", attrs: { id: "contact-first", autocomplete: "off" } });
    const last = el("input", { class: "input", attrs: { id: "contact-last", autocomplete: "off" } });
    const boxes = segs.map((s) => el("label", { class: "check" }, [el("input", { attrs: { type: "checkbox", value: s.id } }), el("span", { text: s.name })]));
    const error = el("p", { class: "form-error", attrs: { role: "alert" } });
    const submit = button("Add", { variant: "primary" });
    submit.type = "submit";
    const form = el("form", {}, [field("Email", email), el("div", { class: "two" }, [field("First name", first), field("Last name", last)]), segs.length ? el("fieldset", { class: "field checks" }, [el("legend", { text: "Segments" }), ...boxes]) : null, error, el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close() }), submit])]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      const args = { email: email.value.trim() };
      if (first.value.trim()) args.firstName = first.value.trim();
      if (last.value.trim()) args.lastName = last.value.trim();
      const segmentIds = boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
      if (segmentIds.length) args.segmentIds = segmentIds;
      try { await guard(() => mutate("contacts.create", args)); close(true); } catch (e) { error.textContent = describe(e); submit.disabled = false; }
    });
    return form;
  });
  if (done) { toast("Contact added"); await refresh(); }
}

export async function renderSegments(_m, view) {
  document.title = "Segments · Resend (synthetic)";
  const head = el("div", { class: "page-head" }, [el("h1", { text: "Audience" }), el("div", { class: "head-actions" }, [button("Create segment", { variant: "primary", iconName: "plus", onClick: () => void createSegment() })])]);
  if (!view.querySelector("#segments-marker")) view.replaceChildren(head, tabs("Segments"), el("div", { attrs: { id: "segments-marker" } }, [table(["Name", "Created", ""], skeletonRows(3, 3), "Segments")]));
  const holder = view.querySelector("#segments-marker");
  let list;
  try { list = await call("segments.list", { limit: 20, ...segCursor.args() }); } catch (error) { holder.replaceChildren(errorState(error, () => void renderSegments(_m, view))); return; }
  if (list.data.length === 0 && segCursor.page === 1) { holder.replaceChildren(emptyState("No segments yet", "Group contacts into segments to target broadcasts.")); return; }
  const body = el("tbody", {}, list.data.map((s) => el("tr", {}, [
    el("td", {}, [el("div", { class: "cell-main" }, [el("span", { class: "tile" }, [icon("users", 15)]), el("button", { class: "link-btn", text: s.name, attrs: { type: "button", "aria-label": `Show contacts in ${s.name}` }, on: { click: () => { contacts.segmentId = s.id; contacts.cursor.reset(); location.hash = "#/audience/contacts"; } } })])]),
    el("td", { class: "muted" }, [timeCell(s.created_at)]),
    el("td", { class: "actions" }, [el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": `Delete segment ${s.name}`, title: "Delete segment" }, on: { click: () => void removeSegment(s) } }, [icon("trash", 15)])]),
  ])));
  holder.replaceChildren(table(["Name", "Created", ""], body, "Segments"), pagerBar(segCursor, list, () => void renderSegments(_m, view), "segments"));
}

async function createSegment() {
  const done = await modal("Create segment", (close) => {
    const name = el("input", { class: "input", attrs: { id: "segment-name", maxlength: "100", autocomplete: "off", placeholder: "Beta testers" } });
    const error = el("p", { class: "form-error", attrs: { role: "alert" } });
    const submit = button("Create", { variant: "primary" });
    submit.type = "submit";
    const form = el("form", {}, [field("Name", name), error, el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close() }), submit])]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try { await guard(() => mutate("segments.create", { name: name.value.trim() })); close(true); } catch (e) { error.textContent = describe(e); submit.disabled = false; }
    });
    return form;
  });
  if (done) { toast("Segment created"); await refresh(); }
}

async function removeSegment(s) {
  if (!(await confirmDialog("Delete segment", `Delete "${s.name}"? Contacts stay in your audience; only the segment is removed.`, "Delete segment"))) return;
  try { await guard(() => mutate("segments.remove", { id: s.id })); toast("Segment deleted"); await refresh(); } catch (e) { toast(describe(e), { error: true }); }
}
