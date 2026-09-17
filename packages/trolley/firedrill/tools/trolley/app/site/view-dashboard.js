// Overview: balance, sent value, recipients needing attention, batches awaiting processing.
import { app, go, setTitle } from "./app.js";
import { dataTable, errorBlock, stateBlock } from "./list.js";
import { icon } from "./icons.js";
import { btn, call, date, el, money, pill } from "./ui.js";

function kpiCard(label) {
  const value = el("div", { class: "kpi-value" }, el("div", { class: "skeleton" }));
  const sub = el("div", { class: "kpi-sub" });
  const node = el("section", { class: "card kpi" }, [el("div", { class: "kpi-label", text: label }), value, sub]);
  return { node, set(v, s) { value.textContent = v; sub.textContent = s ?? ""; }, fail(error) { node.replaceChildren(errorBlock(error)); } };
}

export async function renderDashboard(host, route, view) {
  setTitle("Overview");
  const balanceCard = kpiCard("Available balance");
  const sentCard = kpiCard("Payments Sent (Value)");
  const attentionCard = kpiCard("Recipients");
  const table = dataTable([
    { label: "Amount", cell: (b) => money(b.amount, b.currency) },
    { label: "Batch", cell: (b) => el("div", {}, [el("div", { text: b.description || "Untitled batch" }), el("div", { class: "sub mono", text: b.id })]) },
    { label: "Payments", num: true, cell: (b) => String(b.totalPayments) },
    { label: "Status", cell: (b) => pill(b.status) },
    { label: "Created", cell: (b) => date(b.createdAt) },
  ], { onRowClick: (b) => go("payments", b.id) });
  const openCard = el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", { text: "Batches awaiting processing" }), el("span", { class: "spacer" }), btn("View all payments", "link", { onClick: () => go("payments", undefined, { status: "open" }) })]),
    table.node,
  ]);
  const recentCard = el("section", { class: "card" }, [el("div", { class: "card-head" }, el("h2", { text: "Recently completed" })), el("div", { class: "card-body" }, el("div", { class: "skeleton" }))]);
  host.replaceChildren(el("div", { class: "stack" }, [
    el("div", { class: "grid-3" }, [balanceCard.node, sentCard.node, attentionCard.node]),
    el("div", { class: "grid-2" }, [openCard, recentCard]),
  ]));

  const [balances, open, complete, total, attention] = await Promise.allSettled([
    call("balances.list", { kind: "paymentrails" }),
    call("batches.list", { status: "open", pageSize: 10, orderBy: "createdAt", sortBy: "desc" }),
    call("batches.list", { status: "complete", pageSize: 1000, orderBy: "createdAt", sortBy: "desc" }),
    call("recipients.list", { pageSize: 1 }),
    call("recipients.list", { status: "incomplete", pageSize: 1 }),
  ]);
  if (!view.isCurrent()) return;

  if (balances.status === "fulfilled") {
    const primary = balances.value.balances.find((b) => b.primary) ?? balances.value.balances[0];
    app.now = balances.value.serverTime;
    if (primary) balanceCard.set(money(primary.amount, primary.currency), `${primary.currency} · pending ${money(primary.pendingAmount, primary.currency)}`);
    else balanceCard.set("—", "No balances");
  } else balanceCard.fail(balances.reason);

  if (complete.status === "fulfilled") {
    const batches = complete.value.batches;
    const byCurrency = new Map();
    for (const batch of batches) byCurrency.set(batch.currency, (byCurrency.get(batch.currency) ?? 0) + Math.round(Number(batch.amount) * 100));
    const [currency, cents] = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["USD", 0];
    const count = batches.reduce((sum, b) => sum + b.totalPayments, 0);
    const capped = complete.value.meta.records > batches.length ? ` (first ${batches.length} batches)` : "";
    sentCard.set(money((cents / 100).toFixed(2), currency), `${count} payments in ${batches.length} completed batches${capped}`);
    const body = recentCard.querySelector(".card-body");
    body.replaceChildren(batches.length === 0 ? stateBlock("money", "No completed batches yet", "Processed batches appear here.") :
      el("div", {}, batches.slice(0, 5).map((b) => el("div", { class: "method" }, [
        el("div", { class: "method-icon done" }, icon("check")),
        el("div", { class: "method-main" }, [el("div", { class: "method-title", text: b.description || b.id }), el("div", { class: "method-sub", text: `${b.totalPayments} payments · ${date(b.completedAt ?? b.updatedAt)}` })]),
        el("strong", { text: money(b.amount, b.currency) }),
      ]))));
  } else {
    sentCard.fail(complete.reason);
    recentCard.querySelector(".card-body").replaceChildren(errorBlock(complete.reason));
  }

  if (total.status === "fulfilled" && attention.status === "fulfilled") {
    attentionCard.set(String(total.value.meta.records), `${attention.value.meta.records} incomplete profiles need attention`);
  } else attentionCard.fail(total.reason ?? attention.reason);

  if (open.status === "fulfilled") {
    table.setRows(open.value.batches, stateBlock("check", "Nothing waiting", "All batches have been processed."));
  } else table.setError(open.reason, () => go("dashboard"));
}
