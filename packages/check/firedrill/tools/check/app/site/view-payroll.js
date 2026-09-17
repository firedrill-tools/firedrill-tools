// Payroll detail: the run-payroll surface. Item editor for drafts, preview totals, approve, reopen and delete.
import { btn, call, confirmDialog, describe, el, newKey, toast } from "./ui.js";
import { countdown, day, human, money, pill, relativeDay, stamp } from "./fmt.js";
import { icon } from "./icons.js";
import { banner, loadEmployees, loadWorkplaces, skeletonCard, state, truncationNote } from "./store.js";
import { go, render, setTitle } from "./app.js";
import { deletePayroll } from "./view-payrolls.js";
import { addItemDialog, itemsCard } from "./payroll-items.js";

export async function renderPayroll(host, route, { isCurrent }) {
  setTitle("Payroll", [{ label: "Payrolls", href: "#/payrolls" }]);
  host.replaceChildren(el("div", { class: "page-inner" }, skeletonCard(7)));
  let payroll;
  let employees;
  let workplaces;
  try {
    payroll = await call("payrolls.get", { payroll: route.id, include_items: true });
    employees = await loadEmployees(payroll.company);
    workplaces = await loadWorkplaces(payroll.company);
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [
      backLink(),
      banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() })),
    ]));
    return;
  }
  if (!isCurrent()) return;
  setTitle(`Payroll paying ${day(payroll.payday)}`, [{ label: "Payrolls", href: "#/payrolls" }]);

  const draft = payroll.status === "draft";
  const previewed = payroll.preview?.status === "succeeded";
  const body = [backLink(), header(payroll)];
  const partial = truncationNote(employees.complete, "employees") ?? truncationNote(workplaces.complete, "workplaces");
  if (partial) body.push(partial);
  if (draft && !previewed) body.push(banner("info", "Preview this payroll to compute taxes and net pay before approving it."));
  if (draft && previewed) body.push(banner("ok", `Previewed ${stamp(payroll.preview.completed_at)}. Approving sends this preview; any edit afterwards needs a new preview.`));
  if (!draft && payroll.reopen_deadline) {
    const left = countdown(payroll.reopen_deadline, state.now);
    body.push(banner(left === "passed" ? "info" : "warn", left === "passed"
      ? `The reopen window closed ${stamp(payroll.reopen_deadline)}.`
      : `Approved. This payroll can still be reopened for ${left.replace(" left", "")}.`));
  }
  for (const warning of payroll.warnings ?? []) body.push(banner("warn", typeof warning === "string" ? warning : JSON.stringify(warning)));
  body.push(totals(payroll));
  body.push(itemsCard(payroll, employees, workplaces));
  body.push(metaCard(payroll));
  host.replaceChildren(el("div", { class: "page-inner" }, body));
}

function backLink() {
  return el("a", { class: "back-link", attrs: { href: "#/payrolls" } }, [icon("chevronLeft"), el("span", { text: "All payrolls" })]);
}

function header(payroll) {
  const draft = payroll.status === "draft";
  const actions = [];
  if (draft) {
    actions.push(btn("Add employee", "secondary", { icon: "plus", onClick: () => void addItemDialog(payroll) }));
    actions.push(btn("Delete draft", "ghost", { icon: "trash", onClick: () => void removeDraft(payroll) }));
    actions.push(btn("Preview", "secondary", { icon: "refresh", onClick: () => void preview(payroll) }));
    actions.push(btn("Approve payroll", "primary", { icon: "check", onClick: () => void approve(payroll) }));
  } else if (payroll.status === "pending" && payroll.reopen_deadline && countdown(payroll.reopen_deadline, state.now) !== "passed") {
    actions.push(btn("Reopen payroll", "secondary", { icon: "refresh", onClick: () => void reopen(payroll) }));
  }
  return el("div", { class: "detail-head" }, [
    el("div", {}, [
      el("h2", { class: "detail-title", text: `Payday ${day(payroll.payday)}` }),
      el("div", { class: "detail-meta" }, [
        pill(payroll.status),
        el("span", { class: "tag", text: human(payroll.type) }),
        el("span", { text: `${day(payroll.period_start, { year: false })} – ${day(payroll.period_end)}` }),
        el("span", { text: relativeDay(payroll.payday, state.now) }),
        el("span", { class: "mono", text: payroll.id }),
      ]),
    ]),
    el("span", { class: "spacer" }),
    el("div", { class: "head-actions" }, actions),
  ]);
}

function totals(payroll) {
  const t = payroll.totals ?? {};
  const cells = [
    ["Gross pay", t.employee_gross, "Employee earnings before taxes"],
    ["Employee taxes", t.employee_taxes, "Withheld from employee pay"],
    ["Reimbursements", t.employee_reimbursements, "Not taxed"],
    ["Net pay", t.employee_net, "Paid to employees"],
    ["Company taxes", t.company_taxes, "Employer share"],
    ["Cash requirement", t.cash_requirement, "Debited on the payday"],
  ];
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: "Totals" }),
      el("span", { class: "spacer" }),
      el("span", { class: "card-sub", text: payroll.preview?.status === "succeeded" ? `Previewed ${stamp(payroll.preview.completed_at)}` : "Computed from the items below" }),
    ]),
    el("div", { class: "totals" }, cells.map(([label, value, note]) => el("div", {}, [
      el("div", { class: "stat-label", text: label }),
      el("div", { class: "stat-value", text: money(value) }),
      el("div", { class: "stat-note", text: note }),
    ]))),
  ]);
}

function metaCard(payroll) {
  const rows = [
    ["Created", stamp(payroll.created_at)],
    ["Approval deadline", `${stamp(payroll.approval_deadline)}${payroll.status === "draft" ? ` · ${countdown(payroll.approval_deadline, state.now) || "passed"}` : ""}`],
    ["Approved", payroll.approved_at ? stamp(payroll.approved_at) : "—"],
    ["Reopen deadline", payroll.reopen_deadline ? stamp(payroll.reopen_deadline) : "—"],
    ["Pay frequency", human(payroll.pay_frequency)],
    ["Processing period", human(payroll.processing_period)],
    ["Pay schedule", payroll.pay_schedule ?? "Off-cycle"],
    ["Supplemental withholding", payroll.off_cycle_options?.force_supplemental_withholding ? "Forced" : "Standard"],
  ];
  const node = el("dl", { class: "dl" });
  for (const [label, value] of rows) {
    node.append(el("dt", { text: label }));
    node.append(el("dd", { text: String(value) }));
  }
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, el("h3", { text: "Payroll details" })),
    el("div", { class: "card-body" }, node),
  ]);
}

async function preview(payroll) {
  try {
    await call("payrolls.preview", { payroll: payroll.id, include_items: true }, newKey());
    toast("Preview complete. Totals and per-employee taxes are up to date.");
  } catch (error) {
    toast(describe(error), { error: true, timeout: 8000 });
  }
  await render();
}

async function approve(payroll) {
  if (payroll.preview?.status !== "succeeded") {
    toast("Preview this payroll before approving it.", { error: true });
    return;
  }
  const t = payroll.totals ?? {};
  const body = el("div", {}, [
    el("p", { text: `Approving sends this payroll for the ${day(payroll.payday)} payday. In a live environment this debits the company and pays the employees.` }),
    el("dl", { class: "dl" }, [
      el("dt", { text: "Net pay" }), el("dd", { text: money(t.employee_net) }),
      el("dt", { text: "Cash requirement" }), el("dd", { text: money(t.cash_requirement) }),
      el("dt", { text: "Approval deadline" }), el("dd", { text: `${stamp(payroll.approval_deadline)} · ${countdown(payroll.approval_deadline, state.now) || "passed"}` }),
    ]),
  ]);
  const ok = await confirmDialog("Approve this payroll?", body, "Approve payroll");
  if (!ok) return;
  try {
    await call("payrolls.approve", { payroll: payroll.id, preview_started_at: payroll.preview.started_at }, newKey());
    toast("Payroll approved.");
  } catch (error) {
    toast(describe(error), { error: true, timeout: 10000 });
  }
  await render();
}

async function reopen(payroll) {
  const ok = await confirmDialog("Reopen this payroll?", "The payroll returns to draft so items can be edited. It must be previewed and approved again before the deadline.", "Reopen payroll");
  if (!ok) return;
  try {
    await call("payrolls.reopen", { payroll: payroll.id }, newKey());
    toast("Payroll reopened as a draft.");
  } catch (error) {
    toast(describe(error), { error: true, timeout: 8000 });
  }
  await render();
}

async function removeDraft(payroll) {
  if (await deletePayroll(payroll)) go("payrolls");
}
