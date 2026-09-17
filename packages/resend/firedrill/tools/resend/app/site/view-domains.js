// Domains: list with Add domain, and the domain page with DNS records, Verify and Delete.
import { refresh } from "./app.js";
import { icon } from "./icons.js";
import { Cursor, linkRow, pagerBar, table } from "./list.js";
import { badge, button, call, confirmDialog, copyButton, describe, el, emptyState, errorState, field, formatDate, guard, modal, mutate, skeletonRows, timeCell, toast } from "./ui.js";

const REGIONS = [["us-east-1", "North Virginia (us-east-1)"], ["eu-west-1", "Ireland (eu-west-1)"], ["sa-east-1", "São Paulo (sa-east-1)"], ["ap-northeast-1", "Tokyo (ap-northeast-1)"]];
const regionName = (id) => (REGIONS.find(([v]) => v === id)?.[1] ?? id);
const cursor = new Cursor();

export async function renderDomains(_m, view) {
  document.title = "Domains · Resend (synthetic)";
  const head = el("div", { class: "page-head" }, [el("h1", { text: "Domains" }), el("div", { class: "head-actions" }, [button("Add domain", { variant: "primary", iconName: "plus", onClick: () => void addDomain() })])]);
  const holder = el("div", {}, [table(["Domain", "Status", "Region", "Created"], skeletonRows(4, 4), "Domains")]);
  if (!view.querySelector(".page-head")) view.replaceChildren(head, holder); else view.replaceChildren(head, view.children[1] ?? holder);
  let list;
  try {
    list = await call("domains.list", { limit: 20, ...cursor.args() });
  } catch (error) {
    view.replaceChildren(head, errorState(error, () => void renderDomains(_m, view)));
    return;
  }
  if (list.data.length === 0 && cursor.page === 1) {
    view.replaceChildren(head, emptyState("No domains yet", "Add a domain to start sending emails from your own address.", button("Add domain", { variant: "primary", iconName: "plus", onClick: () => void addDomain() })));
    return;
  }
  const body = el("tbody", {}, list.data.map((d) => linkRow([
    el("td", {}, [el("div", { class: "cell-main" }, [el("span", { class: "tile" }, [icon("globe", 15)]), el("span", { text: d.name })])]),
    el("td", {}, [badge(d.status)]),
    el("td", { class: "muted", text: regionName(d.region) }),
    el("td", { class: "muted" }, [timeCell(d.created_at)]),
  ], `#/domains/${encodeURIComponent(d.id)}`, `Domain ${d.name}, ${d.status}`)));
  view.replaceChildren(head, table(["Domain", "Status", "Region", "Created"], body, "Domains"), pagerBar(cursor, list, () => void renderDomains(_m, view), "domains"));
}

async function addDomain() {
  const created = await modal("Add domain", (close) => {
    const name = el("input", { class: "input", attrs: { id: "domain-name", placeholder: "updates.example.com", autocomplete: "off" } });
    const region = el("select", { class: "select", attrs: { id: "domain-region" } }, REGIONS.map(([v, t]) => el("option", { text: t, attrs: { value: v } })));
    region.style.width = "100%";
    const error = el("p", { class: "form-error", attrs: { role: "alert" } });
    const submit = button("Add", { variant: "primary" });
    const form = el("form", {}, [field("Name", name, "Use a subdomain like updates.example.com to separate sending reputation."), field("Region", region), error, el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close() }), submit])]);
    submit.type = "submit";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      try {
        close(await guard(() => mutate("domains.create", { name: name.value.trim(), region: region.value })));
      } catch (e) {
        error.textContent = describe(e);
        submit.disabled = false;
      }
    });
    return form;
  }, { description: "Send emails from your own domain once its DNS records are verified." });
  if (created) {
    toast(`Domain ${created.name} added`);
    location.hash = `#/domains/${encodeURIComponent(created.id)}`;
  }
}

export async function renderDomainDetail(id, view) {
  document.title = "Domain · Resend (synthetic)";
  let domain;
  try {
    domain = await call("domains.get", { id });
  } catch (error) {
    view.replaceChildren(backLink(), errorState(error, () => void renderDomainDetail(id, view)));
    return;
  }
  const verify = button("Verify DNS Records", { iconName: "refresh", onClick: async () => {
    verify.disabled = true;
    try { await guard(() => mutate("domains.verify", { id })); toast("Verification started"); await refresh(); } catch (e) { toast(describe(e), { error: true }); verify.disabled = false; }
  } });
  const remove = button("Delete", { variant: "ghost", iconName: "trash", onClick: async () => {
    if (!(await confirmDialog("Delete domain", `Are you sure you want to delete ${domain.name}? Emails can no longer be sent from this domain.`, "Delete domain"))) return;
    try { await guard(() => mutate("domains.remove", { id })); toast(`Domain ${domain.name} deleted`); location.hash = "#/domains"; } catch (e) { toast(describe(e), { error: true }); }
  } });
  const meta = el("div", { class: "meta-grid" }, [
    metaItem("Created", el("span", { text: formatDate(domain.created_at) })),
    metaItem("Status", badge(domain.status)),
    metaItem("Region", el("span", { text: regionName(domain.region) })),
    metaItem("Sending", badge(domain.capabilities?.sending === "enabled" ? "delivered" : "canceled", domain.capabilities?.sending === "enabled" ? "Enabled" : "Disabled")),
  ]);
  const banner = domain.status === "failed" ? el("div", { class: "callout callout-error", attrs: { role: "alert" } }, [icon("alert", 16), el("div", {}, [el("strong", { text: "DNS verification failed" }), el("p", { text: "We couldn't find the records below at your DNS provider. Check the values and verify again." })])])
    : domain.status === "not_started" ? el("div", { class: "callout callout-info" }, [icon("clock", 16), el("div", {}, [el("strong", { text: "Add these DNS records" }), el("p", { text: "Add the records to your DNS provider, then click Verify DNS Records." })])]) : null;
  const rows = el("tbody", {}, (domain.records ?? []).map((r) => el("tr", {}, [
    el("td", { text: r.type }),
    el("td", {}, [el("span", { class: "cell-main" }, [el("span", { class: "mono", text: r.name }), copyButton(r.name, `Copy ${r.record} name`)])]),
    el("td", {}, [el("span", { class: "cell-main" }, [el("span", { class: "mono", text: r.value }), copyButton(r.value, `Copy ${r.record} value`)])]),
    el("td", { class: "muted", text: r.ttl }),
    el("td", { class: "muted", text: r.priority ?? "" }),
    el("td", {}, [badge(r.status)]),
  ])));
  const groups = el("section", { class: "section" }, [el("h2", { text: "DNS Records" }), table(["Type", "Name", "Content", "TTL", "Priority", "Status"], rows, "DNS records")]);
  view.replaceChildren(backLink(), el("div", { class: "detail-head" }, [el("span", { class: "tile lg" }, [icon("globe", 26)]), el("div", { class: "detail-title" }, [el("p", { class: "eyebrow", text: "Domain" }), el("h1", { text: domain.name })]), el("div", { class: "head-actions" }, [remove, verify])]), ...[meta, banner, groups].filter(Boolean));
}

export function metaItem(label, value) {
  return el("div", { class: "meta-item" }, [el("p", { class: "eyebrow", text: label }), el("div", {}, [value])]);
}
function backLink() {
  return el("a", { class: "back", attrs: { href: "#/domains" } }, [icon("chevronLeft", 14), el("span", { text: "Domains" })]);
}
