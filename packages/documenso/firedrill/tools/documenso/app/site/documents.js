// Documents page: folder row, heading, search + status filter pills, documents table and pagination.
import { actionButton, documentMenu } from "./actions.js";
import { icon } from "./icons.js";
import { menu, notSimulated, shortDate, stackAvatars, STATUS, statusChip } from "./overlay.js";
import { pagination, skeletonRows } from "./table.js";
import { app, isOwnEmail, setParams } from "./state.js";
import { openUpload } from "./upload.js";
import { button, call, describe, el, tooltip } from "./ui.js";

const STATUSES = ["INBOX", "PENDING", "COMPLETED", "CANCELLED", "DRAFT", "REJECTED"];
const EMPTY = {
  COMPLETED: ["checkCircle", "Nothing to do", "There are no completed documents yet. Documents that you have created or received will appear here once completed."],
  DRAFT: ["checkCircle", "No active drafts", "There are no active drafts at the current moment. You can upload a document to start drafting."],
  CANCELLED: ["xCircle", "Nothing cancelled", "There are no cancelled documents. Documents you cancel will remain here as a record that they were distributed."],
  REJECTED: ["xCircle", "No rejected documents", "There are no rejected documents. Documents that a recipient declines to sign will appear here."],
  ALL: ["bird", "We're all empty", "You have not yet created or received any documents. To create a document please upload one."],
  OTHER: ["checkCircle", "Nothing to do", "All documents have been processed. Any new documents that are sent or received will show here."],
};

const awaitingMe = (doc) => doc.recipients.some((r) => isOwnEmail(r.email) && r.signingStatus === "NOT_SIGNED" && r.role !== "CC");

/** Inbox = pending documents where the actor is a recipient who still has to act; collected page by page. */
async function inboxDocuments(query) {
  const found = [];
  for (let page = 1, total = 1; page <= total; page += 1) {
    const result = await call("documents.find", { status: "PENDING", page, perPage: 100, ...(query ? { query } : {}) });
    total = result.totalPages;
    found.push(...result.data.filter(awaitingMe));
  }
  return found;
}

export async function loadInboxCount() {
  return (await inboxDocuments("")).length;
}

export async function renderDocuments(main, params) {
  const status = STATUSES.includes(params.get("status")) ? params.get("status") : null;
  const query = (params.get("query") ?? "").slice(0, 255);
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const perPage = [10, 20, 30, 40, 50].includes(Number(params.get("perPage"))) ? Number(params.get("perPage")) : 10;
  const ws = app.workspace;

  const search = el("input", { class: "input", attrs: { id: "doc-search", type: "search", placeholder: "Search documents...", "aria-label": "Search documents", value: query } });
  let timer;
  search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => setParams({ query: search.value.trim(), page: null }), 400); });
  const statusPill = el("button", { class: `pill ${status ? "is-set" : ""}`, attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Filter by status" } }, [icon("listFilter"), el("span", { text: "Status" })]);
  const senderPill = tooltip(el("button", { class: "pill", attrs: { type: "button", "aria-label": "Filter by sender (not simulated)" }, on: { click: () => notSimulated("The sender filter") } }, [icon("user"), el("span", { text: "Sender" })]), "Not simulated by this Tool");
  const periodPill = tooltip(el("button", { class: "pill", attrs: { type: "button", "aria-label": "Filter by period (not simulated)" }, on: { click: () => notSimulated("The period filter") } }, [icon("calendar"), el("span", { text: "All Time" })]), "Not simulated by this Tool");
  const filters = el("div", { class: "filters" }, [el("div", { class: "search-box" }, search), statusPill, senderPill, periodPill]);
  if (status || query) filters.append(button("Reset", { variant: "ghost", cls: "muted", onClick: () => setParams({ status: null, query: null, page: null }) }));

  const tableHost = el("div", {});
  main.replaceChildren(el("div", { class: "container" }, [
    el("div", { class: "folder-row" }, [
      el("nav", { class: "breadcrumb", attrs: { "aria-label": "Folders" } }, [icon("folder"), el("span", { text: "Home" })]),
      el("div", { class: "folder-actions" }, [
        button("Create folder", { variant: "outline", iconName: "folderPlus", onClick: () => notSimulated("Folders") }),
        button("Upload Document", { iconName: "upload", onClick: openUpload }),
      ]),
    ]),
    el("div", { class: "page-heading" }, [el("span", { class: "avatar", text: ws.team.name.slice(0, 1), attrs: { "aria-hidden": "true" } }), el("h1", { text: "Documents" })]),
    filters, tableHost,
  ]));

  const counts = {};
  statusPill.addEventListener("click", () => menu(statusPill, [
    { label: "All", trailing: counts.ALL === undefined ? "" : String(counts.ALL), active: !status, onClick: () => setParams({ status: null, page: null }) },
    ...STATUSES.map((s) => ({ label: STATUS[s].label, iconName: STATUS[s].icon, trailing: counts[s] === undefined ? "" : String(counts[s]), active: s === status, onClick: () => setParams({ status: s, page: null }) })),
  ], { align: "start", width: 220 }));
  if (status) statusPill.append(el("span", { class: "pill-sep" }), statusChip(status));

  async function refresh() {
    if (!tableHost.firstChild) tableHost.replaceChildren(skeletonRows(["Created", "Title", "Sender", "Recipient", "Status", "Actions"]));
    try {
      const q = query ? { query } : {};
      let result;
      if (status === "INBOX") {
        const all = await inboxDocuments(query);
        result = { data: all.slice((page - 1) * perPage, page * perPage), count: all.length, currentPage: page, perPage, totalPages: Math.ceil(all.length / perPage) };
      } else {
        result = await call("documents.find", { page, perPage, ...q, ...(status ? { status } : {}) });
      }
      renderTable(result);
      const tally = await Promise.all(["PENDING", "COMPLETED", "CANCELLED", "DRAFT", "REJECTED"].map((s) => call("documents.find", { status: s, perPage: 1, ...q }).then((r) => [s, r.count])));
      for (const [s, n] of tally) counts[s] = n;
      counts.ALL = (await call("documents.find", { perPage: 1, ...q })).count;
      counts.INBOX = status === "INBOX" ? result.count : (await inboxDocuments(query)).length;
      const badge = document.querySelector("#inbox-badge");
      const inboxTotal = query ? await loadInboxCount() : counts.INBOX;
      badge.textContent = inboxTotal > 99 ? "99+" : String(inboxTotal);
      badge.hidden = inboxTotal === 0;
    } catch (error) {
      if (error?.denied) return app.errorPanel(main, error);
      tableHost.replaceChildren(el("div", { class: "table-wrap" }, el("div", { class: "table-error", attrs: { role: "alert" } }, [el("strong", { text: "Something went wrong" }), el("span", { text: describe(error) })])));
    }
  }

  function renderTable(result) {
    if (result.count === 0) {
      const [iconName, title, message] = EMPTY[status ?? "ALL"] ?? EMPTY.OTHER;
      tableHost.replaceChildren(el("div", { class: "empty", attrs: { "data-testid": "empty-document-state" } }, [icon(iconName), el("div", {}, [el("h3", { text: query ? "No results found" : title }), el("p", { text: query ? "No documents match your search." : message })])]));
      return;
    }
    const body = el("tbody");
    for (const doc of result.data) {
      const own = doc.user.id === ws.user.id || doc.team?.id === ws.team.id;
      const recipient = doc.recipients.find((r) => isOwnEmail(r.email));
      const titleNode = own ? el("a", { class: "cell-title", text: doc.title, title: doc.title, attrs: { href: `#/documents/${doc.id}` } })
        : recipient ? el("a", { class: "cell-title", text: doc.title, title: doc.title, attrs: { href: `#/sign/${encodeURIComponent(recipient.token)}` } })
          : el("span", { class: "cell-title", text: doc.title, title: doc.title });
      const more = el("button", { class: "more-btn", attrs: { type: "button", "aria-label": `Actions for ${doc.title}`, "aria-haspopup": "menu", "aria-expanded": "false" } }, icon("more"));
      more.addEventListener("click", () => documentMenu(more, doc, refresh));
      body.append(el("tr", {}, [
        el("td", { text: shortDate(doc.createdAt) }), el("td", {}, titleNode), el("td", { text: doc.user.name || doc.user.email }),
        el("td", {}, stackAvatars(doc.recipients, doc.status)), el("td", {}, statusChip(doc.status)),
        el("td", {}, el("div", { class: "cell-actions" }, [actionButton(doc), more])),
      ]));
    }
    const head = el("thead", {}, el("tr", {}, ["Created", "Title", "Sender", "Recipient", "Status", "Actions"].map((h) => el("th", { text: h }))));
    tableHost.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "data" }, [head, body])), pagination(result, (changes) => setParams(changes)));
  }

  await refresh();
  return { refresh };
}
