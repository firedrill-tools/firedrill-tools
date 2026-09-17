// Balances: funding balances by kind (Trolley and PayPal).
import { go, setTitle } from "./app.js";
import { dataTable, stateBlock, tabs } from "./list.js";
import { el, human, money } from "./ui.js";
import { call } from "./ui.js";

export async function renderBalances(host, route, view) {
  setTitle("Balances");
  const kind = route.params.kind ?? "";
  const table = dataTable([
    { label: "Account", cell: (b) => el("div", {}, [el("div", { text: b.type === "paymentrails" ? "Trolley balance" : "PayPal balance" }), el("div", { class: "sub mono", text: b.accountNumber })]) },
    { label: "Currency", cell: (b) => b.currency },
    { label: "Primary", cell: (b) => (b.primary ? "Yes" : "—") },
    { label: "Pending", num: true, cell: (b) => money(b.pendingAmount, b.currency) },
    { label: "Available", num: true, cell: (b) => el("strong", { text: money(b.amount, b.currency) }) },
  ]);
  host.replaceChildren(el("div", {}, [
    tabs([["", "All balances"], ["paymentrails", "Trolley"], ["paypal", "PayPal"]], kind, (value) => go("balances", undefined, { kind: value })),
    el("div", { class: "banner banner-info" }, el("span", { text: "Deposits and funding transfers are not simulated. Processing a batch debits the Trolley balance in the batch currency." })),
    el("section", { class: "card" }, table.node),
  ]));
  try {
    const value = await call("balances.list", kind ? { kind } : {});
    if (!view.isCurrent()) return;
    table.setRows(value.balances, stateBlock("coins", "No balances", `There are no ${kind ? human(kind) : ""} balances for this merchant.`));
  } catch (error) {
    if (!view.isCurrent()) return;
    table.setError(error, () => go("balances", undefined, { kind }));
  }
}
