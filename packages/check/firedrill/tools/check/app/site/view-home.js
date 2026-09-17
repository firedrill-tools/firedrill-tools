// Home: the selected company at a glance — upcoming paydays, drafts approaching their deadline, recent payrolls.
// Every number is read from the Tool's own operations; "today" comes from the world clock in `companies.list`.
import { btn, call, describe, el } from "./ui.js";
import { countdown, day, human, money, pill, relativeDay } from "./fmt.js";
import { banner, emptyState, listAll, listPage, selectedCompany, skeletonCard, state } from "./store.js";
import { go, render, setTitle } from "./app.js";
import { runPayrollDialog } from "./view-payrolls.js";

export async function renderHome(host, route, { isCurrent }) {
  setTitle("Home");
  const company = selectedCompany();
  host.replaceChildren(el("div", { class: "page-inner" }, [head(company), skeletonCard(4)]));
  if (!company) {
    host.replaceChildren(el("div", { class: "page-inner" }, [
      head(undefined),
      emptyState("No company in scope", "This API key cannot reach an active company in this world. Add a company grant, or check the Companies page."),
    ]));
    return;
  }
  let drafts;
  let recent;
  let employees;
  let paydays = [];
  let paydayError;
  try {
    drafts = await listPage("payrolls.list", { company: company.id, status: ["draft"] }, undefined, 25);
    recent = await listPage("payrolls.list", { company: company.id }, undefined, 6);
    employees = await listAll("employees.list", { company: company.id, active: true }, { limit: 100 });
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [
      head(company),
      banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() })),
    ]));
    return;
  }
  try {
    const schedules = await listAll("pay_schedules.list", { company: company.id }, { limit: 100 });
    for (const schedule of schedules.rows) {
      const page = await call("pay_schedules.paydays", { pay_schedule: schedule.id });
      for (const entry of page.results ?? []) paydays.push({ ...entry, schedule });
    }
    paydays.sort((a, b) => (a.payday < b.payday ? -1 : a.payday > b.payday ? 1 : 0));
    paydays = paydays.filter((entry) => entry.payday >= String(state.now ?? "").slice(0, 10)).slice(0, 5);
  } catch (error) {
    paydayError = describe(error);
  }
  if (!isCurrent()) return;

  const nextPayday = paydays[0];
  const dueSoon = drafts.rows.filter((p) => p.approval_deadline >= String(state.now ?? ""));
  host.replaceChildren(el("div", { class: "page-inner" }, [
    head(company),
    el("div", { class: "grid grid-3" }, [
      stat("Next payday", nextPayday ? day(nextPayday.payday) : "—", nextPayday ? relativeDay(nextPayday.payday, state.now) : "No scheduled payday ahead"),
      stat("Drafts to approve", String(drafts.rows.length), dueSoon.length === drafts.rows.length ? "All still inside their deadline" : `${drafts.rows.length - dueSoon.length} past the approval deadline`),
      stat("Active employees", String(employees.rows.length), employees.complete ? `${employees.rows.filter((e) => e.onboard?.status === "completed").length} fully onboarded` : "More than one page — see Employees"),
    ]),
    draftsCard(drafts.rows),
    paydaysCard(paydays, paydayError),
    recentCard(recent.rows),
  ]));
}

function head(company) {
  return el("div", { class: "page-head" }, [
    el("div", {}, [
      el("h2", { text: company ? (company.trade_name || company.legal_name) : "Home" }),
      el("p", { text: company ? `${human(company.business_type)} · ${human(company.pay_frequency)} payroll · ${company.address?.state ?? "—"}` : "Nothing is in scope for this API key." }),
    ]),
    el("div", { class: "spacer" }),
    el("div", { class: "head-actions" }, [
      btn("View employees", "secondary", { icon: "people", onClick: () => go("employees") }),
      btn("Run payroll", "primary", { icon: "plus", disabled: !company, onClick: () => void runPayrollDialog() }),
    ]),
  ]);
}

function stat(label, value, note) {
  return el("div", { class: "card stat" }, [
    el("div", { class: "stat-label", text: label }),
    el("div", { class: "stat-value", text: value }),
    el("div", { class: "stat-note", text: note }),
  ]);
}

function draftsCard(rows) {
  const body = rows.length === 0
    ? el("div", { class: "state" }, [el("h3", { text: "No drafts waiting" }), el("p", { text: "Start a payroll to add employee hours and earnings." })])
    : el("div", { class: "card-body" }, rows.slice(0, 5).map((payroll) => el("div", { class: "payday-row" }, [
      el("span", { class: "when", text: day(payroll.payday) }),
      el("span", { class: "card-sub", text: `${day(payroll.period_start, { year: false })} – ${day(payroll.period_end)} · ${human(payroll.type)}` }),
      el("span", { class: "spacer" }),
      el("span", { class: "deadline", text: countdown(payroll.approval_deadline, state.now) || "deadline passed" }),
      btn("Open", "secondary", { small: true, onClick: () => go("payrolls", payroll.id) }),
    ])));
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: "Drafts to approve" }),
      el("span", { class: "spacer" }),
      btn("All payrolls", "link", { small: true, onClick: () => go("payrolls", undefined, { status: "draft" }) }),
    ]),
    body,
  ]);
}

function paydaysCard(paydays, error) {
  let body;
  if (error) body = el("div", { class: "card-body" }, banner("warn", error));
  else if (paydays.length === 0) body = el("div", { class: "state" }, [el("h3", { text: "No upcoming paydays" }), el("p", { text: "Add a pay schedule to see the paydays and approval deadlines for this company." })]);
  else body = el("div", { class: "card-body" }, paydays.map((entry) => el("div", { class: "payday-row" }, [
    el("span", { class: "when", text: day(entry.payday) }),
    el("span", { class: "card-sub", text: `${entry.schedule.name || entry.schedule.id} · ${day(entry.period_start, { year: false })} – ${day(entry.period_end)}` }),
    entry.impacted_by_weekend_or_holiday ? el("span", { class: "tag", text: "Moved for weekend" }) : null,
    el("span", { class: "spacer" }),
    el("span", { class: "card-sub", text: relativeDay(entry.payday, state.now) }),
    btn("Run", "secondary", { small: true, onClick: () => void runPayrollDialog({ type: "regular", pay_schedule: entry.schedule.id, payday: entry.payday, period_start: entry.period_start, period_end: entry.period_end }) }),
  ])));
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h3", { text: "Upcoming paydays" }),
      el("span", { class: "spacer" }),
      btn("Pay schedules", "link", { small: true, onClick: () => go("schedules") }),
    ]),
    body,
  ]);
}

function recentCard(rows) {
  if (rows.length === 0) {
    return el("div", { class: "card" }, [
      el("div", { class: "card-head" }, el("h3", { text: "Recent payrolls" })),
      el("div", { class: "state" }, [el("h3", { text: "No payrolls yet" }), el("p", { text: "Payrolls you create for this company appear here with their period, payday and status." })]),
    ]);
  }
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h3", { text: "Recent payrolls" }), el("span", { class: "spacer" }), btn("View all", "link", { small: true, onClick: () => go("payrolls") })]),
    el("div", { class: "table-wrap" }, el("table", { class: "tbl" }, [
      el("thead", {}, el("tr", {}, [
        el("th", { text: "Payday" }), el("th", { text: "Pay period" }), el("th", { text: "Status" }),
        el("th", { class: "num", text: "Net pay" }), el("th", { class: "num", text: "Cash requirement" }),
      ])),
      el("tbody", {}, rows.map((payroll) => el("tr", {
        class: "clickable",
        attrs: { tabindex: "0", role: "link", "aria-label": `Payroll paying ${day(payroll.payday)}` },
        on: {
          click: () => go("payrolls", payroll.id),
          keydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go("payrolls", payroll.id); } },
        },
      }, [
        el("td", {}, [el("span", { class: "strong", text: day(payroll.payday) }), el("span", { class: "sub", text: relativeDay(payroll.payday, state.now) })]),
        el("td", { text: `${day(payroll.period_start, { year: false })} – ${day(payroll.period_end)}` }),
        el("td", {}, pill(payroll.status)),
        el("td", { class: "num", text: money(payroll.totals?.employee_net) }),
        el("td", { class: "num", text: money(payroll.totals?.cash_requirement) }),
      ]))),
    ])),
  ]);
}
