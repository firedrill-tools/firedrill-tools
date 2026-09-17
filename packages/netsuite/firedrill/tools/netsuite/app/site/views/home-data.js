// Data-driven home portlets: Trend Graphs (invoiced sales by month), Report Snapshots (sales by customer) and
// Custom Search (open invoices). Every bar and row is computed from this Tool's own invoice collection; the
// scan is paged (never truncated silently) and says so when it stops at the KPI row cap.
import { app, can, listIds, expand } from "../store.js";
import { el, money, mdy, errorBanner, emptyState, isDenied } from "../ui.js";

export const MAX_KPI_ROWS = 500;
const SVG = "http://www.w3.org/2000/svg";

function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** Every invoice the role can read, paged; `capped` when the KPI row cap stopped the scan. */
export async function loadInvoices(q) {
  const rows = [];
  let capped = false;
  for (let offset = 0; ; offset += 50) {
    const page = await listIds("invoice.list", { q, limit: 50, offset });
    rows.push(...await expand("invoice.get", page.ids));
    if (!page.hasMore) break;
    if (rows.length >= MAX_KPI_ROWS) { capped = true; break; }
  }
  return { rows, capped };
}

const capNote = (capped) => capped ? el("p", { class: "muted", text: `Computed over the first ${MAX_KPI_ROWS} matching invoices.` }) : document.createDocumentFragment();
const COUNTED = new Set(["Open", "Paid In Full"]);
const monthKey = (date) => String(date ?? "").slice(0, 7);
function lastMonths(today, count) {
  const [y, m] = today.split("-").map(Number);
  const keys = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (key) => MONTHS[Number(key.slice(5, 7)) - 1] ?? key;

/** Trend Graphs: invoiced sales (open + paid invoices) per month for the last six account months, as an SVG bar chart. */
export async function trendBody(node) {
  if (!can("TRAN_CUSTINVC")) {
    node.replaceChildren(el("p", { class: "muted", text: "The Invoice permission is required for this graph." }));
    return;
  }
  try {
    const currency = app.session?.account?.baseCurrency ?? "";
    const { rows, capped } = await loadInvoices('(status IS "open" OR status IS "paidInFull")');
    const keys = lastMonths(app.today, 6);
    const totals = new Map(keys.map((k) => [k, 0]));
    for (const row of rows) {
      const key = monthKey(row.tranDate);
      if (totals.has(key) && COUNTED.has(String(row.status?.refName))) totals.set(key, totals.get(key) + (Number(row.total) || 0));
    }
    const max = Math.max(1, ...totals.values());
    const W = 300; const H = 120; const pad = 14; const bw = (W - pad * 2) / keys.length;
    const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "trend", role: "img", "aria-label": "Sales by month, last six months" });
    chart.append(svg("line", { x1: pad, y1: H - 18, x2: W - pad, y2: H - 18, class: "axis" }));
    keys.forEach((key, i) => {
      const value = totals.get(key);
      const h = Math.round((value / max) * (H - 40));
      const x = pad + i * bw + bw * 0.2;
      chart.append(svg("title", { text: `${monthLabel(key)}: ${money(value, currency)}` }));
      chart.append(svg("rect", { x, y: H - 18 - h, width: bw * 0.6, height: h, class: key === monthKey(app.today) ? "bar current" : "bar" }));
      chart.append(svg("text", { x: x + bw * 0.3, y: H - 5, class: "tick", "text-anchor": "middle", text: monthLabel(key) }));
    });
    const sum = [...totals.values()].reduce((a, b) => a + b, 0);
    node.replaceChildren(
      el("div", { class: "trend-head" }, [el("strong", { text: "Sales" }), el("span", { class: "muted", text: `Last 6 months · ${money(sum, currency)}` })]),
      chart,
      el("p", { class: "muted", text: "Invoiced totals (open and paid invoices) by transaction month." }),
      capNote(capped),
    );
  } catch (error) {
    node.replaceChildren(isDenied(error) ? errorBanner(error) : errorBanner(error, "Trend graph could not be computed"));
  }
}

/** Report Snapshots: Sales by Customer, the five customers with the largest invoiced totals. */
export async function snapshotBody(node) {
  if (!can("TRAN_CUSTINVC")) {
    node.replaceChildren(el("p", { class: "muted", text: "The Invoice permission is required for this snapshot." }));
    return;
  }
  try {
    const currency = app.session?.account?.baseCurrency ?? "";
    const { rows, capped } = await loadInvoices('(status IS "open" OR status IS "paidInFull")');
    const byCustomer = new Map();
    for (const row of rows) {
      const id = String(row.entity?.id ?? "");
      const entry = byCustomer.get(id) ?? { id, name: row.entity?.refName ?? id, total: 0 };
      entry.total += Number(row.total) || 0;
      byCustomer.set(id, entry);
    }
    const top = [...byCustomer.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 5);
    const max = Math.max(1, ...top.map((entry) => entry.total));
    if (top.length === 0) { node.replaceChildren(emptyState("No results", "No open or paid invoices are visible to this role.")); return; }
    node.replaceChildren(
      el("div", { class: "snap-title", text: "Sales by Customer" }),
      el("ul", { class: "snap-bars" }, top.map((entry) => el("li", {}, [
        el("a", { href: `#/customers/${encodeURIComponent(entry.id)}`, text: entry.name }),
        svg("svg", { class: "snap-track", viewBox: "0 0 100 8", preserveAspectRatio: "none", "aria-hidden": "true" },
          svg("rect", { x: 0, y: 0, height: 8, width: Math.max(2, Math.round((entry.total / max) * 100)), class: "snap-fill" })),
        el("span", { class: "num", text: money(entry.total, currency) }),
      ]))),
      capNote(capped),
    );
  } catch (error) {
    node.replaceChildren(isDenied(error) ? errorBanner(error) : errorBanner(error, "Snapshot could not be computed"));
  }
}

/** Custom Search: the "Open Invoices" saved-search view, five rows by due date with a link to the full list. */
export async function searchBody(node) {
  if (!can("TRAN_CUSTINVC")) {
    node.replaceChildren(el("p", { class: "muted", text: "The Invoice permission is required for this search." }));
    return;
  }
  try {
    const currency = app.session?.account?.baseCurrency ?? "";
    const { rows, capped } = await loadInvoices('status IS "open"');
    const sorted = rows.filter((row) => Number(row.amountRemaining) > 0)
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.tranId).localeCompare(String(b.tranId)));
    const shown = sorted.slice(0, 5);
    if (shown.length === 0) { node.replaceChildren(emptyState("No results", "There are no open invoices.")); return; }
    node.replaceChildren(
      el("div", { class: "snap-title", text: "Open Invoices" }),
      el("table", { class: "search-results" }, [
        el("thead", {}, el("tr", {}, ["Date", "Number", "Name", "Due Date", "Amount Remaining"].map((h) => el("th", { text: h })))),
        el("tbody", {}, shown.map((row) => el("tr", {}, [
          el("td", { text: mdy(row.tranDate) }),
          el("td", {}, el("a", { href: `#/invoices/${encodeURIComponent(row.id)}`, text: row.tranId ?? "" })),
          el("td", { text: row.entity?.refName ?? "" }),
          el("td", { class: app.today && String(row.dueDate) < app.today ? "overdue" : "", text: mdy(row.dueDate) }),
          el("td", { class: "num", text: money(row.amountRemaining, currency) }),
        ]))),
      ]),
      el("p", { class: "muted" }, [`${shown.length} of ${sorted.length} result${sorted.length === 1 ? "" : "s"} · `, el("a", { href: "#/invoices?tab=Open", text: "View all" })]),
      capNote(capped),
    );
  } catch (error) {
    node.replaceChildren(isDenied(error) ? errorBanner(error) : errorBanner(error, "Search could not be run"));
  }
}
