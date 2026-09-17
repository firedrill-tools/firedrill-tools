// New / edit contact dialog: contacts.save (summarizeErrors=false maps ValidationErrors) with one idempotency key per attempt.
import { app, go } from "../store.js";
import { call, el, toast, newKey } from "../ui.js";
import { dialog } from "../overlay.js";

export function openContactForm(contact = null, onSaved) {
  const editing = Boolean(contact?.ContactID);
  const phone = (contact?.Phones ?? []).find((p) => p.PhoneType === "DEFAULT") ?? {};
  const street = (contact?.Addresses ?? []).find((a) => a.AddressType === "POBOX") ?? {};
  const fields = [
    ["cf-name", "Contact name", "Name", contact?.Name, "span2", true], ["cf-first", "First name", "FirstName", contact?.FirstName], ["cf-last", "Last name", "LastName", contact?.LastName],
    ["cf-email", "Email", "EmailAddress", contact?.EmailAddress, "span2"], ["cf-phone", "Phone", "phone", phone.PhoneNumber],
    ["cf-addr", "Billing address", "AddressLine1", street.AddressLine1, "span2"], ["cf-city", "Town / City", "City", street.City], ["cf-region", "State / Region", "Region", street.Region],
    ["cf-post", "Postal / Zip code", "PostalCode", street.PostalCode], ["cf-country", "Country", "Country", street.Country],
  ];
  const inputs = Object.create(null);
  const errBox = el("div", { class: "err", role: "alert" });
  let key = newKey();
  const grid = el("div", { class: "form-grid" }, fields.map(([id, label, name, value, cls, required]) => {
    const input = el("input", { class: "input", id, value: value ?? "", maxlength: name === "phone" ? "50" : "255", required, type: name === "EmailAddress" ? "email" : "text" });
    input.addEventListener("input", () => { key = newKey(); app.dirty = true; input.classList.remove("invalid"); });
    inputs[name] = input;
    return el("div", { class: `field ${cls ?? ""}` }, [el("label", { for: id, text: required ? `${label} *` : label }), input]);
  }));
  let busy = false;
  const { close, box } = dialog({
    title: editing ? `Edit ${contact.Name}` : "New contact", wide: true, body: [grid, errBox],
    onClose: () => { app.dirty = false; },
    actions: [
      { label: "Cancel", kind: "standard", run: (done) => done() },
      { label: "Save", kind: "main", run: async () => {
        if (busy) return;
        const v = (n) => inputs[n].value.trim();
        if (!v("Name")) { inputs.Name.classList.add("invalid"); errBox.textContent = "Contact name is required."; inputs.Name.focus(); return; }
        const element = { Name: v("Name"), FirstName: v("FirstName") || null, LastName: v("LastName") || null, EmailAddress: v("EmailAddress") || null,
          Phones: v("phone") ? [{ PhoneType: "DEFAULT", PhoneNumber: v("phone") }] : [] };
        const address = ["AddressLine1", "City", "Region", "PostalCode", "Country"].reduce((a, n) => (v(n) ? { ...a, [n]: v(n) } : a), {});
        element.Addresses = Object.keys(address).length ? [{ AddressType: "POBOX", ...address }] : [];
        if (editing) element.ContactID = contact.ContactID;
        busy = true;
        for (const b of box.querySelectorAll(".dialog-foot .btn")) b.disabled = true;
        try {
          const out = await call("contacts.save", { method: "POST", ...(editing ? { pathContactId: contact.ContactID } : {}), body: { Contacts: [element] }, summarizeErrors: false }, key);
          const saved = out.Contacts?.[0];
          if (saved?.StatusAttributeString === "ERROR") {
            const messages = (saved.ValidationErrors ?? []).map((e) => e.Message);
            if (messages.some((m) => /name/i.test(m))) inputs.Name.classList.add("invalid");
            if (messages.some((m) => /email/i.test(m))) inputs.EmailAddress.classList.add("invalid");
            errBox.textContent = messages.join(" ") || "The contact could not be saved.";
            return;
          }
          app.dirty = false;
          close();
          toast(editing ? `${saved.Name} updated` : `${saved.Name} added`);
          if (onSaved) onSaved(saved); else go(`#/contacts/${encodeURIComponent(saved.ContactID)}`);
        } catch (error) {
          errBox.textContent = error.message;
        } finally {
          busy = false;
          for (const b of box.querySelectorAll(".dialog-foot .btn")) b.disabled = false;
        }
      } },
    ],
  });
  inputs.Name.focus();
}
