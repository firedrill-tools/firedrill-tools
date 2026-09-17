// Employees: filters for status and workplace, a name/e-mail search, cursor paging and the Add employee drawer.
import { btn, describe, el } from "./ui.js";
import { day, fullName, human, initials, pill } from "./fmt.js";
import { icon } from "./icons.js";
import { banner, emptyState, listPage, loadWorkplaces, skeletonCard, state, truncationNote } from "./store.js";
import { go, render, setTitle } from "./app.js";
import { employeeDialog } from "./form-employee.js";

const TABS = [["true", "Active"], ["false", "Terminated"], ["", "All"]];

export async function renderEmployees(host, route, { isCurrent }) {
  setTitle("Employees");
  const active = Object.hasOwn(route.params, "active") ? route.params.active : "true";
  const workplace = route.params.workplace ?? "";
  const q = route.params.q ?? "";
  const cursor = route.params.cursor;
  host.replaceChildren(el("div", { class: "page-inner" }, [head(active, workplace, q, []), skeletonCard(6)]));
  let page;
  let workplaces = { rows: [], byId: new Map() };
  try {
    workplaces = await loadWorkplaces(state.company);
    page = await listPage("employees.list", {
      ...(state.company ? { company: state.company } : {}),
      ...(active === "" ? {} : { active: active === "true" }),
      ...(workplace ? { workplace } : {}),
    }, cursor, 25);
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [
      head(active, workplace, q, workplaces.rows),
      banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() })),
    ]));
    return;
  }
  if (!isCurrent()) return;
  const needle = q.trim().toLowerCase();
  const rows = needle === ""
    ? page.rows
    : page.rows.filter((e) => `${fullName(e)} ${e.email ?? ""}`.toLowerCase().includes(needle));
  const body = [head(active, workplace, q, workplaces.rows)];
  const partial = truncationNote(workplaces.complete, "workplaces");
  if (partial) body.push(partial);
  if (needle !== "") body.push(banner("info", "The search filters the employees on this page. Clear it to page through everyone."));
  if (rows.length === 0) {
    body.push(emptyState(
      needle === "" ? "No employees" : "No employee matches that search",
      needle === "" ? "Add an employee to this company to run payroll for them." : "Try a different name or e-mail address, or clear the search.",
      needle === "" ? btn("Add employee", "primary", { icon: "plus", onClick: () => employeeDialog({ company: state.company }) }) : undefined,
    ));
  } else {
    body.push(table(rows, workplaces.byId));
    body.push(el("div", { class: "card-foot card-foot-attached" }, [
      el("span", { class: "pager-info", text: `${rows.length} ${rows.length === 1 ? "employee" : "employees"} on this page` }),
      el("div", { class: "pager" }, [
        btn("Previous", "secondary", { small: true, icon: "chevronLeft", disabled: !cursor, onClick: () => go("employees", undefined, { active, workplace, q }) }),
        btn("Next", "secondary", { small: true, disabled: !page.next, onClick: () => go("employees", undefined, { active, workplace, q, cursor: page.next }) }),
      ]),
    ]));
  }
  host.replaceChildren(el("div", { class: "page-inner" }, body));
}

function head(active, workplace, q, workplaces) {
  const search = el("input", { class: "", attrs: { type: "search", value: q, placeholder: "Search this page by name or e-mail", "aria-label": "Search employees on this page", id: "emp-search" } });
  search.addEventListener("change", () => go("employees", undefined, { active, workplace, q: search.value }));
  search.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); go("employees", undefined, { active, workplace, q: search.value }); } });
  const wp = el("select", { class: "input", attrs: { "aria-label": "Filter by workplace", id: "emp-workplace" } }, [
    el("option", { text: "All workplaces", attrs: { value: "", selected: workplace === "" } }),
    ...workplaces.map((w) => el("option", { text: w.name || w.id, attrs: { value: w.id, selected: w.id === workplace } })),
  ]);
  wp.style.width = "auto";
  wp.addEventListener("change", () => go("employees", undefined, { active, workplace: wp.value, q }));
  return el("div", {}, [
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h2", { text: "Employees" }),
        el("p", { text: "Everyone on payroll for the selected company, sorted by last name." }),
      ]),
      el("div", { class: "spacer" }),
      el("div", { class: "head-actions" }, [
        btn("Add employee", "primary", { icon: "plus", disabled: !state.company, onClick: () => employeeDialog({ company: state.company }) }),
      ]),
    ]),
    el("div", { class: "filters" }, [
      el("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Employment status" } }, TABS.map(([value, label]) =>
        el("button", {
          class: `tab${value === active ? " active" : ""}`,
          text: label,
          attrs: { type: "button", role: "tab", "aria-selected": String(value === active) },
          on: { click: () => go("employees", undefined, { active: value, workplace, q }) },
        }))),
      wp,
      el("label", { class: "search", attrs: { for: "emp-search" } }, [icon("search"), search]),
    ]),
  ]);
}

function table(rows, workplacesById) {
  return el("div", { class: "card" }, el("div", { class: "table-wrap" }, el("table", { class: "tbl" }, [
    el("thead", {}, el("tr", {}, [
      el("th", { text: "Name" }), el("th", { text: "Workplace" }), el("th", { text: "Onboarding" }),
      el("th", { text: "Payment method" }), el("th", { text: "Start date" }), el("th", { text: "Status" }),
    ])),
    el("tbody", {}, rows.map((employee) => el("tr", {
      class: "clickable",
      attrs: { tabindex: "0", role: "link", "aria-label": `Employee ${fullName(employee)}` },
      on: {
        click: () => go("employees", employee.id),
        keydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); go("employees", employee.id); } },
      },
    }, [
      el("td", {}, el("span", { class: "cell-person" }, [
        el("span", { class: "avatar", text: initials(employee.first_name, employee.last_name) }),
        el("span", {}, [
          el("span", { class: "strong", text: fullName(employee) }),
          el("span", { class: "sub", text: employee.email ?? "No e-mail on file" }),
        ]),
      ])),
      el("td", { text: workplacesById.get(employee.primary_workplace)?.name ?? employee.primary_workplace ?? "—" }),
      el("td", {}, pill(employee.onboard?.status ?? "needs_attention")),
      el("td", { text: human(employee.payment_method_preference) }),
      el("td", { text: day(employee.start_date) }),
      el("td", {}, pill(employee.active ? "active" : "terminated", employee.active ? "Active" : "Terminated")),
    ]))),
  ])));
}
