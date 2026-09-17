// Employee detail: profile cards, onboarding callout, earning rates (add / deactivate) and termination.
import { btn, call, confirmDialog, describe, el, newKey, openModal, toast } from "./ui.js";
import { addressLine, day, field, fullName, human, initials, input, money, pill, select, showFieldError } from "./fmt.js";
import { icon } from "./icons.js";
import { banner, listAll, loadWorkplaces, skeletonCard, state, truncationNote } from "./store.js";
import { render, setTitle } from "./app.js";
import { employeeDialog } from "./form-employee.js";

export async function renderEmployee(host, route, { isCurrent }) {
  setTitle("Employee", [{ label: "Employees", href: "#/employees" }]);
  host.replaceChildren(el("div", { class: "page-inner" }, skeletonCard(6)));
  let employee;
  let rates = [];
  let workplaces = new Map();
  let partial = null;
  try {
    employee = await call("employees.get", { employee: route.id });
    const ratePage = await listAll("earning_rates.list", { employee: employee.id }, { limit: 100 });
    rates = ratePage.rows;
    const placePage = await loadWorkplaces(employee.company);
    workplaces = placePage.byId;
    partial = truncationNote(ratePage.complete, "pay rates") ?? truncationNote(placePage.complete, "workplaces");
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [
      backLink(),
      banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() })),
    ]));
    return;
  }
  if (!isCurrent()) return;
  setTitle(fullName(employee), [{ label: "Employees", href: "#/employees" }]);
  const blocking = employee.onboard?.blocking_steps ?? [];
  const remaining = employee.onboard?.remaining_steps ?? [];
  host.replaceChildren(el("div", { class: "page-inner" }, [
    backLink(),
    header(employee),
    partial,
    blocking.length > 0
      ? banner("error", `Onboarding is blocking payroll: ${blocking.map(human).join(", ")}.`)
      : remaining.length > 0
        ? banner("warn", `Onboarding steps still open: ${remaining.map(human).join(", ")}.`)
        : banner("ok", "Onboarding complete. This employee can be added to a payroll."),
    el("div", { class: "split" }, [
      el("div", {}, [profileCard(employee), addressCard(employee)]),
      el("div", {}, [employmentCard(employee, workplaces), ratesCard(employee, rates)]),
    ]),
  ]));
}

function backLink() {
  return el("a", { class: "back-link", attrs: { href: "#/employees" } }, [icon("chevronLeft"), el("span", { text: "All employees" })]);
}

function header(employee) {
  return el("div", { class: "detail-head" }, [
    el("span", { class: "avatar avatar-lg", text: initials(employee.first_name, employee.last_name) }),
    el("div", {}, [
      el("h2", { class: "detail-title", text: fullName(employee) }),
      el("div", { class: "detail-meta" }, [
        pill(employee.active ? "active" : "terminated", employee.active ? "Active" : "Terminated"),
        el("span", { text: employee.email ?? "No e-mail on file" }),
        el("span", { class: "mono", text: employee.id }),
      ]),
    ]),
    el("span", { class: "spacer" }),
    el("div", { class: "head-actions" }, [
      btn("Edit", "secondary", { icon: "edit", onClick: () => employeeDialog({ employee }) }),
      employee.active
        ? btn("Terminate", "danger", { onClick: () => void terminate(employee) })
        : btn("Rehire", "secondary", { onClick: () => void rehire(employee) }),
    ]),
  ]);
}

function dl(rows) {
  const node = el("dl", { class: "dl" });
  for (const [label, value, cls] of rows) {
    node.append(el("dt", { text: label }));
    node.append(el("dd", { class: cls ?? "", text: value === null || value === undefined || value === "" ? "—" : String(value) }));
  }
  return node;
}

function profileCard(employee) {
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, el("h3", { text: "Personal" })),
    el("div", { class: "card-body" }, dl([
      ["Legal name", fullName(employee)],
      ["E-mail", employee.email],
      ["Date of birth", employee.dob ? day(employee.dob) : null],
      ["SSN", employee.ssn_last_four ? `••• •• ${employee.ssn_last_four}` : "Not on file"],
      ["SSN status", human(employee.ssn_validation_status)],
      ["W-2 electronic consent", employee.w2_electronic_consent_provided ? "Given" : "Not given"],
    ])),
  ]);
}

function addressCard(employee) {
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, el("h3", { text: "Home address" })),
    el("div", { class: "card-body" }, dl([
      ["Address", addressLine(employee.residence)],
      ["Tax state", employee.residence?.state],
    ])),
  ]);
}

function employmentCard(employee, workplaces) {
  const names = (employee.workplaces ?? []).map((id) => workplaces.get(id)?.name ?? id).join(", ");
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, el("h3", { text: "Employment" })),
    el("div", { class: "card-body" }, dl([
      ["Start date", day(employee.start_date)],
      ["Termination date", employee.termination_date ? day(employee.termination_date) : null],
      ["Primary workplace", workplaces.get(employee.primary_workplace)?.name ?? employee.primary_workplace],
      ["Workplaces", names],
      ["Payment method", human(employee.payment_method_preference)],
      ["Bank accounts", (employee.bank_accounts ?? []).length > 0 ? `${employee.bank_accounts.length} on file` : "None on file"],
      ["Employee id", employee.id, "mono"],
    ])),
  ]);
}

function ratesCard(employee, rates) {
  const body = rates.length === 0
    ? el("div", { class: "state" }, [el("h3", { text: "No earning rates" }), el("p", { text: "Add an hourly, salary or per-piece rate so payroll items can be priced from it." })])
    : el("div", { class: "card-body" }, rates.map((rate) => el("div", { class: "rate-line" }, [
      el("span", { class: "rate-text" }, [
        el("span", { class: "rate-name", text: rate.name || rate.id }),
        el("span", { class: "rate-meta", text: `${money(rate.amount)} ${rate.period === "hourly" ? "per hour" : rate.period === "annually" ? "per year" : "per piece"}${rate.workweek_hours ? ` · ${rate.workweek_hours} h workweek` : ""}` }),
      ]),
      el("span", { class: "spacer" }),
      pill(rate.active ? "active" : "inactive", rate.active ? "Active" : "Inactive"),
      rate.active
        ? btn("Deactivate", "secondary", { small: true, onClick: () => void setRateActive(rate, false) })
        : btn("Reactivate", "secondary", { small: true, onClick: () => void setRateActive(rate, true) }),
    ])));
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: "Earning rates" }),
      el("span", { class: "spacer" }),
      btn("Add rate", "secondary", { small: true, icon: "plus", onClick: () => rateDialog(employee) }),
    ]),
    body,
  ]);
}

async function setRateActive(rate, active) {
  if (!active) {
    const ok = await confirmDialog("Deactivate this earning rate?", `"${rate.name || rate.id}" can no longer be used on new payroll items. Existing items keep the amount already computed from it.`, "Deactivate");
    if (!ok) return;
  }
  try {
    await call("earning_rates.update", { earning_rate: rate.id, active }, newKey());
    toast(active ? "Earning rate reactivated." : "Earning rate deactivated.");
    await render();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}

function rateDialog(employee) {
  const form = el("form", { class: "form-grid", attrs: { novalidate: "" } });
  const name = input("name", "", { maxlength: "80" });
  const amount = input("amount", "", { inputmode: "decimal", placeholder: "25.00" });
  const period = select("period", [["hourly", "Per hour"], ["annually", "Per year (salary)"], ["piece", "Per piece"]], "hourly");
  const workweek = input("workweek_hours", "40", { type: "number", min: "1", max: "80" });
  form.append(
    field("Rate name", name, { name: "name", full: true, hint: "Shown on payroll items, for example “Baker (2026)”." }),
    field("Amount", amount, { name: "amount" }),
    field("Period", period, { name: "period" }),
    field("Workweek hours", workweek, { name: "workweek_hours", hint: "Used for overtime on salaried employees." }),
  );
  const save = btn("Add earning rate", "primary", { onClick: () => void submit() });
  const modal = openModal({
    title: `New earning rate for ${fullName(employee)}`,
    body: form,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save],
    onClose: () => { state.editing = Math.max(0, state.editing - 1); },
  });
  state.editing += 1;

  async function submit() {
    if (name.value.trim() === "") { showFieldError(form, "name", "Required."); return; }
    if (amount.value.trim() === "") { showFieldError(form, "amount", "Required."); return; }
    save.disabled = true;
    try {
      await call("earning_rates.create", {
        employee: employee.id,
        name: name.value.trim(),
        amount: amount.value.trim(),
        period: period.value,
        workweek_hours: Number(workweek.value) || 40,
      }, newKey());
      modal.close();
      toast("Earning rate added.");
      await render();
    } catch (error) {
      if (!showFieldError(form, error, describe(error))) toast(describe(error), { error: true });
    } finally {
      save.disabled = false;
    }
  }
}

async function terminate(employee) {
  const date = input("termination_date", String(state.now ?? "").slice(0, 10), { type: "date" });
  const body = el("div", {}, [
    el("p", { text: `${fullName(employee)} stops being an active employee on the termination date. Draft payrolls that already include them keep their items.` }),
    el("form", { class: "form-grid" }, field("Termination date", date, { name: "termination_date", full: true })),
  ]);
  const ok = await confirmDialog("Terminate this employee?", body, "Terminate employee", { danger: true });
  if (!ok) return;
  try {
    await call("employees.update", { employee: employee.id, termination_date: date.value }, newKey());
    toast("Employee terminated.");
    await render();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}

async function rehire(employee) {
  try {
    await call("employees.update", { employee: employee.id, termination_date: null }, newKey());
    toast("Termination date cleared.");
    await render();
  } catch (error) {
    toast(describe(error), { error: true });
  }
}
