// Settings → Organisation details (read-only view of organisation.get).
import { app, loadOrg, register } from "../store.js";
import { dmy, el, errorBanner, wireDate } from "../ui.js";
import { notSimulated } from "../overlay.js";
import { pageHead } from "./common.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

register("settings", async (host) => {
  host.replaceChildren(el("div", { class: "loading" }, [el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: "Loading…" })]));
  await loadOrg();
  const head = pageHead({ crumbs: [["Settings"]], title: "Organisation details", actions: [el("button", { type: "button", class: "btn main", text: "Save", disabled: true, title: "Organisation settings are read-only in this Tool" })] });
  if (!app.org) { host.replaceChildren(head, el("div", { class: "page-inner" }, errorBanner(app.orgError ?? new Error("No organisation"), "We couldn't load your organisation"))); return; }
  const o = app.org;
  const kv = (pairs) => el("dl", { class: "kv" }, pairs.flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v === null || v === undefined || v === "" ? "—" : String(v) })]));
  const addr = (o.Addresses ?? [])[0];
  const phone = (o.Phones ?? [])[0];
  const section = (title, body) => el("section", { class: "side" }, [el("h2", { text: title }), body]);
  const list = el("div", { class: "settings-list" }, [
    section("Basic information", kv([["Display name", o.Name], ["Legal or trading name", o.LegalName], ["Organisation type", o.OrganisationType], ["Business registration number", o.RegistrationNumber], ["Industry", o.LineOfBusiness], ["Short code", o.ShortCode]])),
    section("Financial settings", kv([["Base currency", o.BaseCurrency], ["Country", o.CountryCode], ["Financial year end", o.FinancialYearEndDay && o.FinancialYearEndMonth ? `${o.FinancialYearEndDay} ${MONTHS[o.FinancialYearEndMonth - 1]}` : ""],
      ["GST number", o.TaxNumber], ["GST basis", o.SalesTaxBasis], ["GST period", o.SalesTaxPeriod], ["Lock date", dmy(wireDate(o.PeriodLockDate)) || dmy(o.PeriodLockDate)], ["Time zone", o.Timezone]])),
    section("Contact details", kv([["Postal address", addr ? [addr.AddressLine1, addr.City, addr.PostalCode, addr.Country].filter(Boolean).join(", ") : ""], ["Telephone", phone ? [phone.PhoneAreaCode, phone.PhoneNumber].filter(Boolean).join(" ") : ""], ["Edition", o.Edition], ["Plan", o.Class]])),
  ]);
  const more = el("div", { class: "card-foot" }, ["Users", "Currencies", "Invoice settings", "Connected apps"].map((t) => el("button", { type: "button", class: "btn small", text: t, onclick: () => notSimulated(t) })));
  host.replaceChildren(head, el("div", { class: "page-inner" }, [list, more]));
});
