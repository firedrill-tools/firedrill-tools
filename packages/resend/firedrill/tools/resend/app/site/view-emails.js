// Emails: Sending list (search, status filter, cursor pages) and the email detail page.
import { icon } from "./icons.js";
import { Cursor, debounce, linkRow, pagerBar, table } from "./list.js";
import { badge, button, call, el, emptyState, errorState, notSimulated, skeletonRows, timeCell } from "./ui.js";

const STATUSES = [["", "All statuses"], ["delivered", "Delivered"], ["bounced", "Bounced"], ["scheduled", "Scheduled"], ["canceled", "Canceled"], ["sent", "Sent"]];
const state = { query: "", status: "", cursor: new Cursor(), token: 0 };
const HEAD = ["To", "Status", "Subject", "Sent"];

export async function renderEmails(_m, view, { refresh = false } = {}) {
  document.title = "Emails · Resend (synthetic)";
  if (!refresh || !view.querySelector("#emails-body")) view.replaceChildren(buildFrame());
  await loadList();
}

function buildFrame() {
  const search = el("input", { class: "input", attrs: { id: "email-search", type: "search", placeholder: "Search...", "aria-label": "Search emails by recipient or subject", value: state.query } });
  search.value = state.query;
  search.addEventListener("input", debounce(() => { state.query = search.value.trim(); state.cursor.reset(); void loadList(); }));
  const status = el("select", { class: "select", attrs: { id: "email-status", "aria-label": "Filter by status" } }, STATUSES.map(([v, t]) => el("option", { text: t, attrs: { value: v } })));
  status.value = state.status;
  status.addEventListener("change", () => { state.status = status.value; state.cursor.reset(); void loadList(); });
  const range = button("Last 15 days", { iconName: "calendar", attrs: { class: "btn btn-secondary fake-select", "data-soon": "Date range filter" } });
  const keys = button("All API Keys", { attrs: { class: "btn btn-secondary fake-select", "data-soon": "API key filter" } });
  const exportBtn = el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Export", title: "Export", "data-soon": "Export" } }, [icon("download", 16)]);
  const tabs = el("div", { class: "tabs", attrs: { role: "tablist" } }, [
    el("button", { text: "Sending", attrs: { type: "button", role: "tab", "aria-selected": "true" } }),
    el("button", { text: "Receiving", attrs: { type: "button", role: "tab", "aria-selected": "false", "data-soon": "Receiving" } }),
  ]);
  return el("div", {}, [
    el("div", { class: "page-head" }, [el("h1", { text: "Emails" }), el("div", { class: "head-actions" }, [button("Docs", { iconName: "book", variant: "ghost", attrs: { "data-soon": "Docs" } })])]),
    tabs,
    el("div", { class: "toolbar" }, [el("div", { class: "search" }, [icon("search", 14), search]), range, status, keys, exportBtn]),
    el("div", { attrs: { id: "emails-status" } }),
    table(HEAD, skeletonRows(4, 8), "Emails"),
    el("div", { attrs: { id: "emails-pager" } }),
  ]);
}

async function loadList() {
  const token = ++state.token;
  const tableEl = document.querySelector(".table");
  if (!tableEl) return;
  const args = { limit: 20, ...state.cursor.args() };
  if (state.query) args.query = state.query;
  if (state.status) args.status = state.status;
  let list;
  try {
    list = await call("emails.list", args);
  } catch (error) {
    if (token !== state.token) return;
    document.querySelector("#emails-status").replaceChildren(errorState(error, () => void loadList()));
    tableEl.tBodies[0].replaceWith(el("tbody", {}, [el("tr", {}, [el("td", { class: "muted", text: "No emails could be loaded.", attrs: { colspan: "4" } })])]));
    document.querySelector("#emails-pager").replaceChildren();
    return;
  }
  if (token !== state.token) return;
  document.querySelector("#emails-status").replaceChildren();
  if (list.data.length === 0 && state.cursor.page === 1) {
    const filtered = state.query || state.status;
    tableEl.closest(".table-wrap").hidden = true;
    document.querySelector("#emails-pager").replaceChildren(filtered
      ? emptyState("No emails found", "No emails match the current filters. Try a different search or status.")
      : emptyState("No emails yet", "Emails you send through the API will show up here.", button("Send your first email", { variant: "primary", attrs: { "data-soon": "Onboarding" } })));
    return;
  }
  tableEl.closest(".table-wrap").hidden = false;
  const body = el("tbody");
  for (const email of list.data) {
    const to = email.to.length > 1 ? `${email.to[0]} +${email.to.length - 1}` : email.to[0] ?? "—";
    body.append(linkRow([
      el("td", {}, [el("div", { class: "cell-main" }, [el("span", { class: "tile" }, [icon("mail", 15)]), el("span", { text: to })])]),
      el("td", {}, [badge(email.last_event)]),
      el("td", { class: "muted", text: email.subject }),
      el("td", { class: "muted" }, [timeCell(email.scheduled_at && email.last_event === "scheduled" ? email.scheduled_at : email.created_at)]),
    ], `#/emails/${encodeURIComponent(email.id)}`, `Email to ${to}: ${email.subject}`));
  }
  tableEl.tBodies[0].replaceWith(body);
  document.querySelector("#emails-pager").replaceChildren(pagerBar(state.cursor, list, () => void loadList(), "emails"));
}

export { renderEmailDetail } from "./view-email-detail.js";
export { notSimulated };
