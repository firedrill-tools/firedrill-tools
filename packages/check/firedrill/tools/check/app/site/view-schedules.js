// Pay schedules: the company's schedules and, for each, the computed paydays, periods and approval deadlines.
import { btn, call, describe, el, newKey, openModal, toast } from "./ui.js";
import { day, field, human, input, select, showFieldError, stamp } from "./fmt.js";
import { banner, emptyState, listAll, skeletonCard, state, truncationNote } from "./store.js";
import { render, setTitle } from "./app.js";
import { runPayrollDialog } from "./view-payrolls.js";

const FREQUENCIES = [["weekly", "Weekly"], ["biweekly", "Every other week"], ["semimonthly", "Twice a month"], ["monthly", "Monthly"], ["quarterly", "Quarterly"], ["annually", "Annually"]];

export async function renderSchedules(host, route, { isCurrent }) {
  setTitle("Pay schedules");
  host.replaceChildren(el("div", { class: "page-inner" }, [head(), skeletonCard(4)]));
  let schedules = [];
  let partial = null;
  try {
    const page = await listAll("pay_schedules.list", state.company ? { company: state.company } : {}, { limit: 100 });
    schedules = page.rows;
    partial = truncationNote(page.complete, "pay schedules");
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [head(), banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() }))]));
    return;
  }
  if (!isCurrent()) return;
  if (schedules.length === 0) {
    host.replaceChildren(el("div", { class: "page-inner" }, [head(), emptyState(
      "No pay schedules",
      "A regular payroll must land on one of a schedule's paydays. Off-cycle payrolls can be run without a schedule.",
      btn("Add pay schedule", "primary", { icon: "plus", onClick: () => scheduleDialog() }),
    )]));
    return;
  }
  const cards = schedules.map((schedule) => scheduleCard(schedule, isCurrent));
  host.replaceChildren(el("div", { class: "page-inner" }, [head(), partial, ...cards]));
}

function head() {
  return el("div", { class: "page-head" }, [
    el("div", {}, [
      el("h2", { text: "Pay schedules" }),
      el("p", { text: "Paydays, pay periods and approval deadlines are computed from the schedule's first payday and frequency." }),
    ]),
    el("div", { class: "spacer" }),
    el("div", { class: "head-actions" }, btn("Add pay schedule", "primary", { icon: "plus", disabled: !state.company, onClick: () => scheduleDialog() })),
  ]);
}

function scheduleCard(schedule, isCurrent) {
  const body = el("div", { class: "card-body" }, el("div", { class: "card-sub", text: "Loading paydays…" }));
  const card = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("div", {}, [
        el("h3", { text: schedule.name || schedule.id }),
        el("div", { class: "card-sub", text: `${human(schedule.pay_frequency)} · first payday ${day(schedule.first_payday)} · first period ends ${day(schedule.first_period_end)}${schedule.second_payday ? ` · second payday ${day(schedule.second_payday)}` : ""}` }),
      ]),
      el("span", { class: "spacer" }),
      el("span", { class: "mono sub", text: schedule.id }),
    ]),
    body,
  ]);
  void (async () => {
    try {
      const page = await call("pay_schedules.paydays", { pay_schedule: schedule.id });
      if (!isCurrent()) return;
      const rows = (page.results ?? []).slice(0, 8);
      body.replaceChildren(rows.length === 0
        ? el("div", { class: "card-sub", text: "This schedule has no paydays in the next year." })
        : el("div", {}, rows.map((entry) => el("div", { class: "payday-row" }, [
          el("span", { class: "when", text: day(entry.payday) }),
          el("span", { class: "card-sub", text: `${day(entry.period_start, { year: false })} – ${day(entry.period_end)}` }),
          entry.impacted_by_weekend_or_holiday ? el("span", { class: "tag", text: "Moved for weekend" }) : null,
          el("span", { class: "spacer" }),
          el("span", { class: "card-sub", text: `Approve by ${stamp(entry.approval_deadline_datetime ?? entry.approval_deadline)}` }),
          btn("Run payroll", "secondary", { small: true, onClick: () => void runPayrollDialog({ type: "regular", pay_schedule: schedule.id, payday: entry.payday, period_start: entry.period_start, period_end: entry.period_end }) }),
        ]))));
    } catch (error) {
      if (isCurrent()) body.replaceChildren(banner("warn", describe(error)));
    }
  })();
  return card;
}

function scheduleDialog() {
  const form = el("form", { class: "form-grid", attrs: { novalidate: "" } });
  const name = input("name", "", { maxlength: "80" });
  const frequency = select("pay_frequency", FREQUENCIES, "biweekly");
  const firstPayday = input("first_payday", "", { type: "date" });
  const firstPeriodEnd = input("first_period_end", "", { type: "date" });
  const secondPayday = input("second_payday", "", { type: "date" });
  const syncSecond = () => { secondPayday.disabled = frequency.value !== "semimonthly"; };
  frequency.addEventListener("change", syncSecond);
  syncSecond();
  form.append(
    field("Schedule name", name, { name: "name", full: true }),
    field("Pay frequency", frequency, { name: "pay_frequency" }),
    field("First payday", firstPayday, { name: "first_payday" }),
    field("First period end", firstPeriodEnd, { name: "first_period_end" }),
    field("Second payday", secondPayday, { name: "second_payday", hint: "Twice-a-month schedules only." }),
  );
  const save = btn("Add pay schedule", "primary", { onClick: () => void submit() });
  const modal = openModal({
    title: "New pay schedule",
    subtitle: "Every regular payroll for this company must use one of its schedules.",
    body: form,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save],
    onClose: () => { state.editing = Math.max(0, state.editing - 1); },
  });
  state.editing += 1;

  async function submit() {
    for (const [fieldName, value] of [["name", name.value.trim()], ["first_payday", firstPayday.value], ["first_period_end", firstPeriodEnd.value]]) {
      if (!value) { showFieldError(form, fieldName, "Required."); return; }
    }
    save.disabled = true;
    try {
      await call("pay_schedules.create", {
        company: state.company,
        name: name.value.trim(),
        pay_frequency: frequency.value,
        first_payday: firstPayday.value,
        first_period_end: firstPeriodEnd.value,
        ...(frequency.value === "semimonthly" && secondPayday.value ? { second_payday: secondPayday.value } : {}),
      }, newKey());
      modal.close();
      toast("Pay schedule added.");
      await render();
    } catch (error) {
      if (!showFieldError(form, error, describe(error))) toast(describe(error), { error: true });
    } finally {
      save.disabled = false;
    }
  }
}
