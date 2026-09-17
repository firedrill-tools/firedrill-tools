// Payrolls list: status tabs, payday range, cursor paging and the "Run payroll" flow.
import { btn, call, confirmDialog, describe, el, newKey, openModal, toast } from "./ui.js";
import { countdown, day, field, human, input, money, pill, relativeDay, select, showFieldError } from "./fmt.js";
import { banner, emptyState, listPage, loadSchedules, skeletonCard, state, truncationNote } from "./store.js";
import { go, render, setTitle } from "./app.js";

const TABS = [["all", "All"], ["draft", "Drafts"], ["pending", "Pending"], ["processing", "Processing"], ["paid", "Paid"]];

export async function renderPayrolls(host, route, { isCurrent }) {
  setTitle("Payrolls");
  const status = Object.hasOwn(route.params, "status") ? route.params.status : "all";
  const type = route.params.type ?? "";
  const cursor = route.params.cursor;
  host.replaceChildren(el("div", { class: "page-inner" }, [head(status, type), skeletonCard(6)]));
  let page;
  try {
    page = await listPage("payrolls.list", {
      company: state.company,
      ...(status && status !== "all" ? { status: [status] } : {}),
      ...(type ? { type: [type] } : {}),
    }, cursor, 25);
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [
      head(status, type),
      banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() })),
    ]));
    return;
  }
  if (!isCurrent()) return;
  const body = [head(status, type)];
  if (page.rows.length === 0) {
    body.push(emptyState(
      status === "all" ? "No payrolls yet" : `No ${human(status).toLowerCase()} payrolls`,
      "Payrolls you create for this company appear here with their period, payday and approval deadline.",
      btn("Run payroll", "primary", { icon: "plus", onClick: () => void runPayrollDialog() }),
    ));
  } else {
    body.push(table(page.rows));
    body.push(el("div", { class: "card-foot card-foot-attached" }, [
      el("span", { class: "pager-info", text: `${page.rows.length} ${page.rows.length === 1 ? "payroll" : "payrolls"} on this page` }),
      el("div", { class: "pager" }, [
        btn("Previous", "secondary", { small: true, icon: "chevronLeft", disabled: !cursor, onClick: () => go("payrolls", undefined, { status, type }) }),
        btn("Next", "secondary", { small: true, disabled: !page.next, onClick: () => go("payrolls", undefined, { status, type, cursor: page.next }) }),
      ]),
    ]));
  }
  host.replaceChildren(el("div", { class: "page-inner" }, body));
}

function head(status, type) {
  return el("div", {}, [
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h2", { text: "Payrolls" }),
        el("p", { text: "Regular and off-cycle payrolls for the selected company, newest payday first." }),
      ]),
      el("div", { class: "spacer" }),
      el("div", { class: "head-actions" }, [
        btn("Run payroll", "primary", { icon: "plus", onClick: () => void runPayrollDialog() }),
      ]),
    ]),
    el("div", { class: "filters" }, [
      el("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Payroll status" } }, TABS.map(([value, label]) =>
        el("button", {
          class: `tab${value === status ? " active" : ""}`,
          text: label,
          attrs: { type: "button", role: "tab", "aria-selected": String(value === status) },
          on: { click: () => go("payrolls", undefined, { status: value, type }) },
        }))),
      (() => {
        const node = select("type", [["", "All types"], ["regular", "Regular"], ["off_cycle", "Off-cycle"]], type);
        node.id = "flt-type";
        node.style.width = "auto";
        node.setAttribute("aria-label", "Filter by payroll type");
        node.addEventListener("change", () => go("payrolls", undefined, { status, type: node.value }));
        return node;
      })(),
    ]),
  ]);
}

function table(rows) {
  return el("div", { class: "card" }, el("div", { class: "table-wrap" }, el("table", { class: "tbl" }, [
    el("thead", {}, el("tr", {}, [
      el("th", { text: "Payday" }),
      el("th", { text: "Pay period" }),
      el("th", { text: "Type" }),
      el("th", { text: "Status" }),
      el("th", { class: "num", text: "Gross" }),
      el("th", { class: "num", text: "Net pay" }),
      el("th", { text: "Approval deadline" }),
    ])),
    el("tbody", {}, rows.map((payroll) => el("tr", {
      class: "clickable",
      attrs: { tabindex: "0", role: "link", "aria-label": `Payroll paying ${day(payroll.payday)}` },
      on: {
        click: () => go("payrolls", payroll.id),
        keydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go("payrolls", payroll.id); } },
      },
    }, [
      el("td", {}, [
        el("span", { class: "strong", text: day(payroll.payday) }),
        el("span", { class: "sub", text: relativeDay(payroll.payday, state.now) }),
      ]),
      el("td", { text: `${day(payroll.period_start, { year: false })} – ${day(payroll.period_end)}` }),
      el("td", {}, el("span", { class: "tag", text: human(payroll.type) })),
      el("td", {}, pill(payroll.status)),
      el("td", { class: "num", text: money(payroll.totals?.employee_gross) }),
      el("td", { class: "num strong", text: money(payroll.totals?.employee_net) }),
      el("td", {}, [
        el("span", { class: "deadline", text: day(payroll.approval_deadline) }),
        el("span", { class: "sub", text: payroll.status === "draft" ? countdown(payroll.approval_deadline, state.now) : "—" }),
      ]),
    ]))),
  ])));
}

/** Run payroll: pick a schedule payday, or enter off-cycle dates. */
export async function runPayrollDialog(preset = {}) {
  const company = state.company;
  if (!company) { toast("Select a company first.", { error: true }); return; }
  let schedules = [];
  let partial = null;
  try {
    const page = await loadSchedules(company);
    schedules = page.rows;
    partial = truncationNote(page.complete, "pay schedules");
  } catch { /* the form still allows off-cycle dates */ }
  const form = el("form", { class: "form-grid", attrs: { novalidate: "" } });
  const typeSel = select("type", [["regular", "Regular payroll"], ["off_cycle", "Off-cycle payroll"]], preset.type ?? "regular");
  const scheduleSel = select("pay_schedule", [["", "No pay schedule"], ...schedules.map((s) => [s.id, s.name || s.id])], preset.pay_schedule ?? schedules[0]?.id ?? "");
  const periodStart = input("period_start", preset.period_start ?? "", { type: "date", required: "" });
  const periodEnd = input("period_end", preset.period_end ?? "", { type: "date", required: "" });
  const payday = input("payday", preset.payday ?? "", { type: "date", required: "" });
  const supplemental = el("input", { attrs: { type: "checkbox", name: "force_supplemental_withholding" } });
  const paydayPicker = el("div", { class: "field-full" });
  if (partial) form.append(el("div", { class: "field-full" }, partial));
  form.append(
    field("Payroll type", typeSel, { name: "type" }),
    field("Pay schedule", scheduleSel, { name: "pay_schedule", hint: "Regular payrolls must land on one of the schedule's paydays." }),
    paydayPicker,
    field("Period start", periodStart, { name: "period_start" }),
    field("Period end", periodEnd, { name: "period_end" }),
    field("Payday", payday, { name: "payday" }),
    el("label", { class: "checkline field-full" }, [supplemental, el("span", { text: "Withhold federal income tax at the supplemental rate (off-cycle only)" })]),
  );

  const fillPaydays = async () => {
    paydayPicker.replaceChildren();
    if (typeSel.value !== "regular" || !scheduleSel.value) return;
    paydayPicker.append(el("div", { class: "card-sub", text: "Loading upcoming paydays…" }));
    try {
      const page = await call("pay_schedules.paydays", { pay_schedule: scheduleSel.value });
      const upcoming = (page.results ?? []).slice(0, 6);
      paydayPicker.replaceChildren(el("div", { class: "card payday-picker" }, upcoming.length === 0
        ? el("div", { class: "card-sub payday-picker-empty", text: "This schedule has no upcoming paydays in the next year." })
        : upcoming.map((entry) => el("div", { class: "payday-row" }, [
          el("span", { class: "when", text: day(entry.payday) }),
          el("span", { class: "card-sub", text: `${day(entry.period_start, { year: false })} – ${day(entry.period_end)}` }),
          entry.impacted_by_weekend_or_holiday ? el("span", { class: "tag", text: "Moved for weekend" }) : null,
          el("span", { class: "spacer" }),
          btn("Use", "secondary", { small: true, onClick: () => { payday.value = entry.payday; periodStart.value = entry.period_start; periodEnd.value = entry.period_end; } }),
        ]))));
    } catch (error) {
      paydayPicker.replaceChildren(banner("warn", describe(error)));
    }
  };
  typeSel.addEventListener("change", () => void fillPaydays());
  scheduleSel.addEventListener("change", () => void fillPaydays());
  void fillPaydays();

  const submit = btn("Create draft payroll", "primary", { onClick: () => void create() });
  const modal = openModal({
    title: "Run payroll",
    subtitle: "Creates a draft you can fill with employees, preview and approve.",
    body: form,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), submit],
    onClose: () => { state.editing = Math.max(0, state.editing - 1); },
  });
  state.editing += 1;

  async function create() {
    const offCycle = typeSel.value === "off_cycle";
    const args = {
      company,
      type: typeSel.value,
      period_start: periodStart.value,
      period_end: periodEnd.value,
      payday: payday.value,
      ...(scheduleSel.value && !offCycle ? { pay_schedule: scheduleSel.value } : {}),
      ...(offCycle ? { off_cycle_options: { force_supplemental_withholding: supplemental.checked } } : {}),
    };
    for (const [name, value] of [["period_start", args.period_start], ["period_end", args.period_end], ["payday", args.payday]]) {
      if (!value) { showFieldError(form, name, "Required."); return; }
    }
    submit.disabled = true;
    try {
      const payroll = await call("payrolls.create", args, newKey());
      modal.close();
      toast(`Draft payroll created for ${day(payroll.payday)}.`);
      go("payrolls", payroll.id);
    } catch (error) {
      if (!showFieldError(form, error, describe(error))) toast(describe(error), { error: true });
    } finally {
      submit.disabled = false;
    }
  }
}

export async function deletePayroll(payroll) {
  const ok = await confirmDialog(
    "Delete this draft payroll?",
    `The draft paying ${day(payroll.payday)} and all of its payroll items will be removed. This cannot be undone.`,
    "Delete payroll",
    { danger: true },
  );
  if (!ok) return false;
  try {
    await call("payrolls.delete", { payroll: payroll.id }, newKey());
    toast("Draft payroll deleted.");
    return true;
  } catch (error) {
    toast(describe(error), { error: true });
    return false;
  }
}
