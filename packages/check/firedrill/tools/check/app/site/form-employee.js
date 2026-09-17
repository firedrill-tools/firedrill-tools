// The Add employee / Edit employee drawer, shared by the Employees list and the employee detail page.
import { btn, call, describe, el, newKey, openModal, toast } from "./ui.js";
import { field, fullName, input, select, showFieldError } from "./fmt.js";
import { banner, loadWorkplaces, state, truncationNote } from "./store.js";
import { go, render } from "./app.js";

const STATES = ["CA", "NY", "OR"];

/** Create (no `employee`) or edit an employee. Calls `onSaved(employee)` or re-renders the current screen. */
export async function employeeDialog({ employee, company, onSaved } = {}) {
  const companyId = company ?? employee?.company ?? state.company;
  if (!companyId) { toast("Select a company first.", { error: true }); return; }
  let workplaces = [];
  let loadError;
  let partial = null;
  try {
    const placePage = await loadWorkplaces(companyId);
    workplaces = placePage.rows.filter((w) => w.active || employee?.workplaces?.includes(w.id));
    partial = truncationNote(placePage.complete, "workplaces");
  } catch (error) {
    loadError = describe(error);
  }

  const form = el("form", { class: "form-grid", attrs: { novalidate: "" } });
  const first = input("first_name", employee?.first_name ?? "", { maxlength: "60" });
  const middle = input("middle_name", employee?.middle_name ?? "", { maxlength: "60" });
  const last = input("last_name", employee?.last_name ?? "", { maxlength: "60" });
  const email = input("email", employee?.email ?? "", { type: "email", maxlength: "120" });
  const dob = input("dob", employee?.dob ?? "", { type: "date" });
  const start = input("start_date", employee?.start_date ?? "", { type: "date" });
  const ssn = input("ssn", "", { maxlength: "11", placeholder: employee ? "Replace the SSN on file" : "123-45-6789", inputmode: "numeric" });
  const method = select("payment_method_preference", [["direct_deposit", "Direct deposit"], ["manual", "Manual check"]], employee?.payment_method_preference ?? "direct_deposit");
  const consent = el("input", { attrs: { type: "checkbox", name: "w2_electronic_consent_provided", checked: employee?.w2_electronic_consent_provided ? "" : undefined } });
  const line1 = input("line1", employee?.residence?.line1 ?? "", { maxlength: "120" });
  const line2 = input("line2", employee?.residence?.line2 ?? "", { maxlength: "120" });
  const city = input("city", employee?.residence?.city ?? "", { maxlength: "60" });
  const stateSel = select("state", STATES.map((s) => [s, s]), employee?.residence?.state ?? "CA");
  const postal = input("postal_code", employee?.residence?.postal_code ?? "", { maxlength: "10", inputmode: "numeric" });
  const primary = select("primary_workplace", workplaces.map((w) => [w.id, w.name || w.id]), employee?.primary_workplace ?? workplaces[0]?.id ?? "");
  const extra = el("div", { class: "field-full" }, workplaces.map((w) => {
    const box = el("input", { attrs: { type: "checkbox", value: w.id, checked: (employee?.workplaces ?? [workplaces[0]?.id]).includes(w.id) ? "" : undefined } });
    box.dataset.workplace = w.id;
    return el("label", { class: "checkline" }, [box, el("span", { text: `${w.name || w.id} — ${w.address?.city ?? ""}, ${w.address?.state ?? ""}` })]);
  }));

  if (loadError) form.append(el("div", { class: "field-full" }, banner("warn", `Workplaces could not be loaded: ${loadError}`)));
  if (partial) form.append(el("div", { class: "field-full" }, partial));
  form.append(
    el("div", { class: "form-section field-full", text: "Personal" }),
    field("First name", first, { name: "first_name" }),
    field("Middle name", middle, { name: "middle_name" }),
    field("Last name", last, { name: "last_name" }),
    field("E-mail", email, { name: "email" }),
    field("Date of birth", dob, { name: "dob" }),
    field("Social Security number", ssn, { name: "ssn", hint: employee ? "Leave blank to keep the number on file. Only the last four digits are ever stored." : "Only the last four digits are stored." }),
    el("div", { class: "form-section field-full", text: "Home address" }),
    field("Street address", line1, { name: "line1", full: true }),
    field("Apartment, suite", line2, { name: "line2", full: true }),
    field("City", city, { name: "city" }),
    field("State", stateSel, { name: "state" }),
    field("ZIP code", postal, { name: "postal_code" }),
    el("div", { class: "form-section field-full", text: "Employment" }),
    field("Start date", start, { name: "start_date" }),
    field("Payment method", method, { name: "payment_method_preference" }),
    field("Primary workplace", primary, { name: "primary_workplace" }),
    el("div", { class: "field-full" }, [el("label", { class: "field-hint", text: "Workplaces this employee can be paid from" }), extra]),
    el("label", { class: "checkline field-full" }, [consent, el("span", { text: "Employee consented to receive the W-2 electronically" })]),
  );

  const save = btn(employee ? "Save changes" : "Add employee", "primary", { onClick: () => void submit() });
  const modal = openModal({
    title: employee ? `Edit ${fullName(employee)}` : "Add employee",
    subtitle: employee ? "Changes apply immediately to draft payrolls that use this employee." : "The employee can be added to a draft payroll once onboarding has no blocking steps.",
    body: form,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save],
    onClose: () => { state.editing = Math.max(0, state.editing - 1); },
  });
  state.editing += 1;

  async function submit() {
    const chosen = [...extra.querySelectorAll("input[type=checkbox]")].filter((b) => b.checked).map((b) => b.dataset.workplace);
    const workplaceList = chosen.includes(primary.value) || primary.value === "" ? chosen : [primary.value, ...chosen];
    const payload = {
      first_name: first.value.trim(),
      middle_name: middle.value.trim() === "" ? null : middle.value.trim(),
      last_name: last.value.trim(),
      email: email.value.trim() === "" ? null : email.value.trim(),
      dob: dob.value === "" ? null : dob.value,
      start_date: start.value,
      payment_method_preference: method.value,
      w2_electronic_consent_provided: consent.checked,
      workplaces: workplaceList,
      primary_workplace: primary.value,
      residence: {
        line1: line1.value.trim(),
        line2: line2.value.trim() === "" ? null : line2.value.trim(),
        city: city.value.trim(),
        state: stateSel.value,
        postal_code: postal.value.trim(),
        country: "US",
      },
      ...(ssn.value.trim() === "" ? {} : { ssn: ssn.value.trim() }),
    };
    for (const [name, value] of [["first_name", payload.first_name], ["last_name", payload.last_name], ["start_date", payload.start_date]]) {
      if (!value) { showFieldError(form, name, "Required."); return; }
    }
    if (workplaceList.length === 0) { showFieldError(form, "workplaces", "Choose at least one workplace."); return; }
    save.disabled = true;
    try {
      const saved = employee
        ? await call("employees.update", { employee: employee.id, ...payload }, newKey())
        : await call("employees.create", { company: companyId, ...payload }, newKey());
      modal.close();
      toast(employee ? "Employee updated." : `${fullName(saved)} added.`);
      if (onSaved) onSaved(saved);
      else if (employee) await render();
      else go("employees", saved.id);
    } catch (error) {
      if (!showFieldError(form, error, describe(error))) toast(describe(error), { error: true });
    } finally {
      save.disabled = false;
    }
  }
}
