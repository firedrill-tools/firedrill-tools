// Companies: every company the API key can reach, with the active filter, cursor paging and a detail drawer.
import { btn, call, describe, el, openModal, toast } from "./ui.js";
import { addressLine, day, human, initials, pill } from "./fmt.js";
import { banner, emptyState, listPage, skeletonCard, state } from "./store.js";
import { go, paintCompany, render, setTitle } from "./app.js";

const TABS = [["true", "Active"], ["false", "Inactive"], ["", "All"]];

export async function renderCompanies(host, route, { isCurrent }) {
  setTitle("Companies");
  const active = Object.hasOwn(route.params, "active") ? route.params.active : "true";
  const cursor = route.params.cursor;
  host.replaceChildren(el("div", { class: "page-inner" }, [head(active), skeletonCard(5)]));
  let page;
  try {
    page = await listPage("companies.list", active === "" ? {} : { active: active === "true" }, cursor, 25);
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [head(active), banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() }))]));
    return;
  }
  if (!isCurrent()) return;
  if (typeof page.serverTime === "string") state.now = page.serverTime;
  const body = [head(active)];
  if (page.rows.length === 0) {
    body.push(emptyState("No companies", active === "true"
      ? "This API key cannot reach an active company in this world."
      : "No company matches this filter."));
  } else {
    body.push(table(page.rows));
    body.push(el("div", { class: "card-foot card-foot-attached" }, [
      el("span", { class: "pager-info", text: `${page.rows.length} ${page.rows.length === 1 ? "company" : "companies"} on this page` }),
      el("div", { class: "pager" }, [
        btn("Previous", "secondary", { small: true, icon: "chevronLeft", disabled: !cursor, onClick: () => go("companies", undefined, { active }) }),
        btn("Next", "secondary", { small: true, disabled: !page.next, onClick: () => go("companies", undefined, { active, cursor: page.next }) }),
      ]),
    ]));
  }
  host.replaceChildren(el("div", { class: "page-inner" }, body));
}

function head(active) {
  return el("div", {}, [
    el("div", { class: "page-head" }, [
      el("div", {}, [
        el("h2", { text: "Companies" }),
        el("p", { text: "Every company this API key can reach. Select one to scope the rest of the Console to it." }),
      ]),
    ]),
    el("div", { class: "filters" }, el("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Company status" } }, TABS.map(([value, label]) =>
      el("button", {
        class: `tab${value === active ? " active" : ""}`,
        text: label,
        attrs: { type: "button", role: "tab", "aria-selected": String(value === active) },
        on: { click: () => go("companies", undefined, { active: value }) },
      })))),
  ]);
}

function table(rows) {
  return el("div", { class: "card" }, el("div", { class: "table-wrap" }, el("table", { class: "tbl" }, [
    el("thead", {}, el("tr", {}, [
      el("th", { text: "Company" }), el("th", { text: "Business type" }), el("th", { text: "Pay frequency" }),
      el("th", { text: "Location" }), el("th", { text: "Status" }), el("th", { text: "" }),
    ])),
    el("tbody", {}, rows.map((company) => el("tr", {
      class: "clickable",
      attrs: { tabindex: "0", role: "link", "aria-label": `Company ${company.legal_name}` },
      on: {
        click: () => void openCompany(company.id),
        keydown: (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void openCompany(company.id); } },
      },
    }, [
      el("td", {}, el("span", { class: "cell-person" }, [
        el("span", { class: "avatar", text: initials(company.trade_name || company.legal_name) }),
        el("span", {}, [
          el("span", { class: "strong", text: company.trade_name || company.legal_name }),
          el("span", { class: "sub", text: company.legal_name }),
        ]),
      ])),
      el("td", { text: human(company.business_type) }),
      el("td", { text: human(company.pay_frequency) }),
      el("td", {}, [
        el("span", { text: `${company.address?.city ?? "—"}${company.address?.state ? `, ${company.address.state}` : ""}` }),
        el("span", { class: "sub", text: human(company.industry_type) }),
      ]),
      el("td", {}, pill(company.active ? "active" : "inactive")),
      el("td", {}, el("div", { class: "head-actions" }, [
        btn(company.id === state.company ? "Selected" : "Select", "secondary", {
          small: true,
          disabled: company.id === state.company,
          onClick: (event) => { event.stopPropagation(); state.company = company.id; paintCompany(); toast(`Scoped to ${company.trade_name || company.legal_name}.`); go("home"); },
        }),
      ])),
    ]))),
  ])));
}

async function openCompany(id) {
  let company;
  try {
    company = await call("companies.get", { company: id });
  } catch (error) {
    toast(describe(error), { error: true });
    return;
  }
  const rows = [
    ["Legal name", company.legal_name],
    ["Trade name", company.trade_name ?? "—"],
    ["Other business name", company.other_business_name ?? "—"],
    ["Business type", human(company.business_type)],
    ["Industry", human(company.industry_type)],
    ["Pay frequency", human(company.pay_frequency)],
    ["Processing period", human(company.processing_period)],
    ["Start date", day(company.start_date)],
    ["Address", addressLine(company.address)],
    ["E-mail", company.email ?? "—"],
    ["Phone", company.phone ?? "—"],
    ["Website", company.website ?? "—"],
    ["Company id", company.id],
  ];
  const dl = el("dl", { class: "dl" });
  for (const [label, value] of rows) {
    dl.append(el("dt", { text: label }));
    dl.append(el("dd", { class: label === "Company id" ? "mono" : "", text: String(value ?? "—") }));
  }
  const modal = openModal({
    title: company.trade_name || company.legal_name,
    subtitle: company.active ? "Active company" : "Inactive company",
    body: dl,
    wide: true,
    actions: [
      btn("Close", "secondary", { onClick: () => modal.close() }),
      btn("Scope Console to this company", "primary", {
        onClick: () => { state.company = company.id; paintCompany(); modal.close(); go("home"); },
      }),
    ],
  });
}
