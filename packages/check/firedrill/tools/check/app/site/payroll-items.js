// The per-employee payroll item table on the payroll detail page, plus add and remove.
import { btn, call, confirmDialog, describe, el, newKey, openModal, toast } from "./ui.js";
import { fullName, hours as hoursText, human, initials, money, pill } from "./fmt.js";
import { render } from "./app.js";
import { loadEmployees, loadWorkplaces, truncationNote } from "./store.js";
import { itemDialog } from "./form-item.js";

export function itemsCard(payroll, employees, workplaces) {
  const items = payroll.items ?? [];
  const draft = payroll.status === "draft";
  const head = el("div", { class: "card-head" }, [
    el("h3", { text: "Employees on this payroll" }),
    el("span", { class: "spacer" }),
    el("span", { class: "card-sub", text: `${items.length} ${items.length === 1 ? "item" : "items"}` }),
    draft ? btn("Add employee", "secondary", { small: true, icon: "plus", onClick: () => void addItemDialog(payroll, employees, workplaces) }) : null,
  ]);
  if (items.length === 0) {
    return el("div", { class: "card" }, [head, el("div", { class: "state" }, [
      el("h3", { text: "No employees on this payroll yet" }),
      el("p", { text: draft ? "Add an employee to enter their hours, earnings and reimbursements." : "This payroll was approved without any items." }),
      draft ? btn("Add employee", "primary", { icon: "plus", onClick: () => void addItemDialog(payroll, employees, workplaces) }) : null,
    ])]);
  }
  return el("div", { class: "card" }, [head, el("div", { class: "table-wrap" }, el("table", { class: "tbl" }, [
    el("thead", {}, el("tr", {}, [
      el("th", { text: "Employee" }), el("th", { text: "Earnings" }), el("th", { class: "num", text: "Hours" }),
      el("th", { class: "num", text: "Gross" }), el("th", { class: "num", text: "Taxes" }),
      el("th", { class: "num", text: "Net pay" }), el("th", { text: "Payment" }), el("th", { text: "" }),
    ])),
    el("tbody", {}, items.map((item) => row(item, payroll, employees, workplaces, draft))),
  ]))]);
}

function row(item, payroll, employees, workplaces, draft) {
  const employee = employees.byId.get(item.employee);
  const name = employee ? fullName(employee) : item.employee;
  const gross = (item.earnings ?? []).reduce((total, earning) => total + Math.round(Number(earning.amount) * 100), 0);
  const totalHours = (item.earnings ?? []).reduce((total, earning) => total + (Number(earning.hours) || 0), 0);
  const taxes = (item.taxes ?? []).filter((tax) => tax.payer === "employee");
  const taxTotal = taxes.reduce((total, tax) => total + Math.round(Number(tax.amount) * 100), 0);
  const actions = [];
  if (draft) {
    actions.push(btn("Edit", "secondary", { small: true, onClick: () => void itemDialog({ payroll, employee: employee ?? { id: item.employee, workplaces: [], first_name: item.employee, last_name: "" }, item, workplaces: workplaces.byId }) }));
    actions.push(btn("Remove", "ghost", { small: true, icon: "trash", label: `Remove ${name} from this payroll`, onClick: () => void removeItem(item, name) }));
  } else if (taxes.length > 0) {
    actions.push(btn("Taxes", "link", { small: true, onClick: () => taxBreakdown(item, name) }));
  }
  return el("tr", {}, [
    el("td", {}, el("span", { class: "cell-person" }, [
      el("span", { class: "avatar", text: employee ? initials(employee.first_name, employee.last_name) : "?" }),
      el("span", {}, [
        el("span", { class: "strong", text: name }),
        el("span", { class: "sub", text: item.status ? human(item.status) : (employee?.email ?? item.employee) }),
      ]),
    ])),
    el("td", {}, el("div", { class: "earn-cell" }, (item.earnings ?? []).map((earning) => el("div", { class: "sub earn-row" }, [
      el("span", { class: "tag", text: human(earning.type) }),
      el("span", { text: `${workplaces.byId.get(earning.workplace)?.name ?? earning.workplace} · ${money(earning.amount)}` }),
    ])))),
    el("td", { class: "num", text: totalHours > 0 ? hoursText(totalHours) : "—" }),
    el("td", { class: "num", text: money((gross / 100).toFixed(2)) }),
    el("td", { class: "num", text: taxes.length > 0 ? money((taxTotal / 100).toFixed(2)) : "—" }),
    el("td", { class: "num strong", text: item.net_pay === null || item.net_pay === undefined ? "—" : money(item.net_pay) }),
    el("td", {}, [
      el("span", { text: human(item.payment_method) }),
      item.paper_check_number ? el("span", { class: "sub", text: `Check #${item.paper_check_number}` }) : null,
    ]),
    el("td", {}, el("div", { class: "head-actions" }, actions)),
  ]);
}

function taxBreakdown(item, name) {
  const table = el("table", { class: "tax-table" }, [
    el("thead", {}, el("tr", {}, [el("th", { text: "Tax" }), el("th", { text: "Payer" }), el("th", { text: "Amount" })])),
    el("tbody", {}, (item.taxes ?? []).map((tax) => el("tr", {}, [
      el("td", { text: tax.description ?? tax.tax }),
      el("td", {}, pill(tax.payer === "employee" ? "draft" : "pending", tax.payer === "employee" ? "Employee" : "Company")),
      el("td", { text: money(tax.amount) }),
    ]))),
  ]);
  const modal = openModal({
    title: `Taxes for ${name}`,
    subtitle: "Synthetic flat rates — not real tax law.",
    body: table,
    wide: true,
    actions: [btn("Close", "secondary", { onClick: () => modal.close() })],
  });
}

async function removeItem(item, name) {
  const ok = await confirmDialog(
    "Remove this employee from the payroll?",
    `${name}'s earnings and reimbursements are deleted from this draft. The payroll must be previewed again before it can be approved.`,
    "Remove employee",
    { danger: true },
  );
  if (!ok) return;
  try {
    await call("payroll_items.delete", { payroll_item: item.id }, newKey());
    toast(`${name} removed from this payroll.`);
  } catch (error) {
    toast(describe(error), { error: true });
  }
  await render();
}

/** Pick an employee who is not on the payroll yet, then open the item editor. */
export async function addItemDialog(payroll, employees, workplaces) {
  let list = employees;
  let places = workplaces;
  if (!list || !places) {
    try {
      list = await loadEmployees(payroll.company);
      places = await loadWorkplaces(payroll.company);
    } catch (error) {
      toast(describe(error), { error: true });
      return;
    }
  }
  const taken = new Set((payroll.items ?? []).map((item) => item.employee));
  const available = list.rows.filter((employee) => !taken.has(employee.id) && employee.active);
  if (available.length === 0) {
    const modal = openModal({
      title: "No employees to add",
      body: el("p", { text: "Every active employee of this company is already on this payroll, or nobody is active. Add or reactivate an employee first." }),
      actions: [btn("Close", "secondary", { onClick: () => modal.close() })],
    });
    return;
  }
  const partial = truncationNote(list.complete, "employees") ?? truncationNote(places.complete, "workplaces");
  const body = el("div", {}, [partial, ...available.map((employee) => {
    const blocking = (employee.onboard?.blocking_steps ?? []).length > 0;
    return el("div", { class: "payday-row" }, [
      el("span", { class: "avatar", text: initials(employee.first_name, employee.last_name) }),
      el("span", { class: "person-text" }, [
        el("span", { class: "strong", text: fullName(employee) }),
        el("span", { class: "sub", text: `${human(employee.payment_method_preference)} · ${employee.email ?? "no e-mail"}` }),
      ]),
      el("span", { class: "spacer" }),
      blocking ? pill("blocking", "Onboarding blocking") : pill("completed", "Ready"),
      btn("Add", "secondary", { small: true, label: `Add ${fullName(employee)}`, onClick: () => { modal.close(); void itemDialog({ payroll, employee, workplaces: places.byId }); } }),
    ]);
  })]);
  const modal = openModal({
    title: "Add an employee to this payroll",
    subtitle: "Employees with blocking onboarding steps are rejected by the payroll item rules.",
    body,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() })],
  });
}
