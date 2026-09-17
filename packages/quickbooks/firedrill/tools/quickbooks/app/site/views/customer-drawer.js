// New / edit customer drawer (customers.post create or full update with SyncToken).
import { go } from "../store.js";
import { ToolError, call, describe, el, newKey, toast } from "../ui.js";
import { drawer, field, input } from "./common.js";

export function openCustomerDrawer(existing = null, onSaved) {
  const c = existing ?? {};
  const f = {
    GivenName: field("First name", input({ value: c.GivenName ?? "", autocomplete: "off" })),
    FamilyName: field("Last name", input({ value: c.FamilyName ?? "", autocomplete: "off" })),
    CompanyName: field("Company name", input({ value: c.CompanyName ?? "" })),
    DisplayName: field("Customer display name *", input({ value: c.DisplayName ?? "" })),
    Email: field("Email", input({ type: "email", value: c.PrimaryEmailAddr?.Address ?? "" })),
    Phone: field("Phone number", input({ type: "tel", value: c.PrimaryPhone?.FreeFormNumber ?? "" })),
    Line1: field("Street address 1", input({ value: c.BillAddr?.Line1 ?? "" })),
    City: field("City", input({ value: c.BillAddr?.City ?? "" })),
    State: field("State", input({ value: c.BillAddr?.CountrySubDivisionCode ?? "" })),
    Zip: field("ZIP code", input({ value: c.BillAddr?.PostalCode ?? "" })),
    Notes: field("Notes", el("textarea", { value: c.Notes ?? "" })),
  };
  const display = f.DisplayName.input;
  const suggest = () => {
    if (display.dataset.touched) return;
    display.value = f.CompanyName.input.value.trim() || `${f.GivenName.input.value} ${f.FamilyName.input.value}`.trim();
  };
  if (!existing) for (const k of ["GivenName", "FamilyName", "CompanyName"]) f[k].input.addEventListener("input", suggest);
  display.addEventListener("input", () => { display.dataset.touched = "1"; });
  const formError = el("div");
  const body = [formError,
    el("div", { class: "section-title", text: "Name and contact" }),
    el("div", { class: "row2" }, [f.GivenName.wrap, f.FamilyName.wrap]), f.CompanyName.wrap, f.DisplayName.wrap,
    el("div", { class: "row2" }, [f.Email.wrap, f.Phone.wrap]),
    el("div", { class: "section-title", text: "Addresses" }), f.Line1.wrap,
    el("div", { class: "row3" }, [f.City.wrap, f.State.wrap, f.Zip.wrap]),
    el("div", { class: "section-title", text: "Notes and attachments" }), f.Notes.wrap];
  const key = newKey();
  drawer(existing ? "Customer information" : "New customer", body, (close) => {
    const save = el("button", { type: "button", class: "btn primary", text: "Save" });
    save.addEventListener("click", async () => {
      for (const x of Object.values(f)) x.setError("");
      formError.replaceChildren();
      const v = (k) => f[k].input.value.trim();
      if (!v("DisplayName")) { f.DisplayName.setError("Enter a customer display name."); display.focus(); return; }
      const bodyOut = { DisplayName: v("DisplayName") };
      const opt = (k, val) => { if (val) bodyOut[k] = val; };
      opt("GivenName", v("GivenName")); opt("FamilyName", v("FamilyName")); opt("CompanyName", v("CompanyName")); opt("Notes", v("Notes"));
      if (v("Email")) bodyOut.PrimaryEmailAddr = { Address: v("Email") };
      if (v("Phone")) bodyOut.PrimaryPhone = { FreeFormNumber: v("Phone") };
      if (v("Line1") || v("City") || v("State") || v("Zip")) {
        bodyOut.BillAddr = {};
        for (const [k, s] of [["Line1", "Line1"], ["City", "City"], ["CountrySubDivisionCode", "State"], ["PostalCode", "Zip"]]) if (v(s)) bodyOut.BillAddr[k] = v(s);
      }
      if (existing) { bodyOut.Id = existing.Id; bodyOut.SyncToken = existing.SyncToken; bodyOut.sparse = true; }
      save.disabled = true;
      try {
        const out = await call("customers.post", { body: bodyOut }, key);
        close();
        toast(existing ? "Customer saved" : `${out.Customer?.DisplayName ?? "Customer"} added`);
        if (onSaved) onSaved(out.Customer); else go(`#/customers/${encodeURIComponent(out.Customer.Id)}`);
      } catch (error) {
        save.disabled = false;
        const map = { DisplayName: "DisplayName", PrimaryEmailAddr: "Email", PrimaryPhone: "Phone", GivenName: "GivenName", FamilyName: "FamilyName", CompanyName: "CompanyName", Notes: "Notes" };
        const target = error instanceof ToolError ? map[error.element] : undefined;
        if (target) f[target].setError(describe(error));
        else formError.replaceChildren(el("div", { class: "banner error", role: "alert" }, el("div", { text: describe(error) })));
        if (error instanceof ToolError && error.is("STALE_OBJECT")) formError.replaceChildren(el("div", { class: "banner warn", role: "alert", text: "This customer was changed elsewhere. Close and reopen it to get the latest version." }));
      }
    });
    return [el("button", { type: "button", class: "btn", text: "Cancel", onclick: close }), save];
  });
}
