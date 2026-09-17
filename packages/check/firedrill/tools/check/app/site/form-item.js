// The payroll item editor: earnings lines (rate or flat amount), reimbursements and the payment method.
import { btn, call, describe, el, newKey, openModal, toast } from "./ui.js";
import { field, fullName, input, money, select, showFieldError } from "./fmt.js";
import { icon } from "./icons.js";
import { banner, listAll, state, truncationNote } from "./store.js";
import { render } from "./app.js";

const EARNING_TYPES = [
  ["regular", "Regular"], ["overtime", "Overtime"], ["double_overtime", "Double overtime"], ["salaried", "Salaried"],
  ["holiday", "Holiday"], ["pto", "PTO"], ["sick", "Sick"], ["bonus", "Bonus"], ["commission", "Commission"],
  ["cash_tips", "Cash tips"], ["paycheck_tips", "Paycheck tips"], ["piece", "Piece"],
];

/** Open the editor for a new item (`item` omitted) or an existing one. */
export async function itemDialog({ payroll, employee, item, workplaces }) {
  let rates = [];
  let loadError;
  let partial = null;
  try {
    const ratePage = await listAll("earning_rates.list", { employee: employee.id, active: true }, { limit: 100 });
    rates = ratePage.rows;
    partial = truncationNote(ratePage.complete, "pay rates");
  } catch (error) {
    loadError = describe(error);
  }
  const options = (employee.workplaces ?? []).map((id) => [id, workplaces.get(id)?.name ?? id]);
  const form = el("form", { class: "form-grid", attrs: { novalidate: "" } });
  const method = select("payment_method", [["direct_deposit", "Direct deposit"], ["manual", "Manual check"]], item?.payment_method ?? employee.payment_method_preference);
  const checkNumber = input("paper_check_number", item?.paper_check_number ?? "", { maxlength: "20" });
  const lines = el("div", { class: "field-full" });
  const reimbs = el("div", { class: "field-full" });

  const addEarning = (value = {}) => lines.append(earningLine(value, options, rates, () => lines.children.length > 1));
  const addReimb = (value = {}) => reimbs.append(reimbLine(value));
  for (const earning of item?.earnings ?? []) addEarning(earning);
  if (lines.children.length === 0) addEarning({ workplace: employee.primary_workplace, earning_rate: rates[0]?.id ?? "", hours: rates[0]?.period === "hourly" ? 80 : "" });
  for (const reimbursement of item?.reimbursements ?? []) addReimb(reimbursement);

  if (loadError) form.append(el("div", { class: "field-full" }, banner("warn", `Earning rates could not be loaded: ${loadError}`)));
  if (partial) form.append(el("div", { class: "field-full" }, partial));
  form.append(
    el("div", { class: "form-section field-full", text: "Earnings" }),
    lines,
    el("div", { class: "field-full" }, btn("Add earning line", "secondary", { small: true, icon: "plus", onClick: () => addEarning({ workplace: employee.primary_workplace }) })),
    el("div", { class: "form-section field-full", text: "Reimbursements" }),
    reimbs,
    el("div", { class: "field-full" }, btn("Add reimbursement", "secondary", { small: true, icon: "plus", onClick: () => addReimb({}) })),
    el("div", { class: "form-section field-full", text: "Payment" }),
    field("Payment method", method, { name: "payment_method" }),
    field("Paper check number", checkNumber, { name: "paper_check_number", hint: "Manual checks only." }),
  );

  const save = btn(item ? "Save item" : "Add to payroll", "primary", { onClick: () => void submit() });
  const modal = openModal({
    title: item ? `Edit ${fullName(employee)}` : `Add ${fullName(employee)} to this payroll`,
    subtitle: `Payday ${payroll.payday} · earnings are priced from an active earning rate or a flat amount.`,
    body: form,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save],
    onClose: () => { state.editing = Math.max(0, state.editing - 1); },
  });
  state.editing += 1;

  function collect() {
    const earnings = [...lines.children].map((row) => {
      const get = (name) => row.querySelector(`[data-part="${name}"]`);
      const rate = get("rate").value;
      const hoursValue = get("hours").value.trim();
      const amountValue = get("amount").value.trim();
      const pieces = get("pieces").value.trim();
      return {
        type: get("type").value,
        workplace: get("workplace").value,
        ...(rate ? { earning_rate: rate } : { amount: amountValue }),
        ...(hoursValue === "" ? {} : { hours: Number(hoursValue) }),
        ...(pieces === "" ? {} : { piece_units: Number(pieces) }),
      };
    });
    const reimbursements = [...reimbs.children].map((row) => ({
      amount: row.querySelector('[data-part="amount"]').value.trim(),
      description: row.querySelector('[data-part="description"]').value.trim() || null,
    }));
    return {
      payment_method: method.value,
      earnings,
      reimbursements,
      paper_check_number: checkNumber.value.trim() === "" ? null : checkNumber.value.trim(),
    };
  }

  async function submit() {
    const payload = collect();
    if (payload.earnings.length === 0) { showFieldError(form, "earnings", "Add at least one earning line."); return; }
    save.disabled = true;
    try {
      if (item) await call("payroll_items.update", { payroll_item: item.id, ...payload }, newKey());
      else await call("payroll_items.create", { payroll: payroll.id, employee: employee.id, ...payload }, newKey());
      modal.close();
      toast(item ? "Payroll item saved. Preview again before approving." : `${fullName(employee)} added to this payroll.`);
      await render();
    } catch (error) {
      if (!showFieldError(form, error, describe(error))) toast(describe(error), { error: true, timeout: 8000 });
    } finally {
      save.disabled = false;
    }
  }
}

function earningLine(value, workplaceOptions, rates, canRemove) {
  const type = select("type", EARNING_TYPES, value.type ?? "regular");
  const workplace = select("workplace", workplaceOptions.length > 0 ? workplaceOptions : [["", "No workplace"]], value.workplace);
  const rate = select("earning_rate", [["", "Flat amount"], ...rates.map((r) => [r.id, `${r.name || r.id} — ${money(r.amount)} ${r.period === "hourly" ? "/h" : r.period === "annually" ? "/yr" : "/piece"}`])], value.earning_rate ?? "");
  const hours = input("hours", value.hours ?? "", { type: "number", min: "0", max: "400", step: "0.25" });
  const amount = input("amount", value.earning_rate ? "" : (value.amount ?? ""), { inputmode: "decimal", placeholder: "0.00" });
  const pieces = input("piece_units", value.piece_units ?? "", { type: "number", min: "0", step: "0.01" });
  for (const [node, part, label] of [[type, "type", "Earning type"], [workplace, "workplace", "Workplace"], [rate, "rate", "Earning rate"], [hours, "hours", "Hours"], [amount, "amount", "Flat amount"], [pieces, "pieces", "Piece units"]]) {
    node.dataset.part = part;
    node.setAttribute("aria-label", label);
  }
  const sync = () => { amount.disabled = rate.value !== ""; };
  rate.addEventListener("change", sync);
  sync();
  const row = el("div", { class: "earn-line" }, [
    el("span", { class: "drop" }, type),
    el("span", { class: "drop" }, workplace),
    el("span", { class: "drop" }, rate),
    el("span", { class: "drop" }, hours),
    el("span", { class: "drop" }, amount),
    el("span", { class: "drop" }, pieces),
    el("button", {
      class: "icon-btn",
      attrs: { type: "button", "aria-label": "Remove this earning line" },
      on: { click: () => { if (canRemove()) row.remove(); else toast("A payroll item needs at least one earning line.", { error: true }); } },
    }, icon("trash")),
  ]);
  return row;
}

function reimbLine(value) {
  const amount = input("amount", value.amount ?? "", { inputmode: "decimal", placeholder: "0.00" });
  const description = input("description", value.description ?? "", { maxlength: "200", placeholder: "What was reimbursed" });
  amount.dataset.part = "amount";
  amount.setAttribute("aria-label", "Reimbursement amount");
  description.dataset.part = "description";
  description.setAttribute("aria-label", "Reimbursement description");
  const row = el("div", { class: "earn-line" }, [
    el("span", { class: "drop" }, amount),
    el("span", { class: "drop drop-wide" }, description),
    el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": "Remove this reimbursement" }, on: { click: () => row.remove() } }, icon("trash")),
  ]);
  return row;
}
