// "Select payout method" form, modelled on the dashboard's payout method picker (Bank transfer / Venmo / PayPal / Check).
import { app } from "./app.js";
import { icon } from "./icons.js";
import { btn, call, describe, el, field, input, newKey, openModal, select, showFieldError, toast } from "./ui.js";

const TYPES = [["bank-transfer", "Bank transfer", "bank"], ["venmo", "Venmo", "phone"], ["paypal", "PayPal", "paypal"], ["check", "Check", "mail"]];
const CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "MXN"].map((c) => [c, c]);

export function methodIcon(type) {
  const found = TYPES.find(([t]) => t === type);
  return icon(found ? found[2] : "bank");
}
export function methodLine(account) {
  if (account.type === "bank-transfer") return [account.bankName, account.accountNum ?? account.iban, account.country].filter(Boolean).join(" · ");
  if (account.type === "paypal") return account.emailAddress ?? "";
  if (account.type === "venmo") return account.phoneNumber ?? "";
  if (account.type === "check") return [account.mailing?.name, account.mailing?.city, account.mailing?.country].filter(Boolean).join(" · ");
  return "";
}

export function openAddMethod(recipient, done) {
  let type = "bank-transfer";
  const form = el("form", { class: "form-grid", attrs: { novalidate: true } });
  const choices = el("div", { class: "choice-row field-full", attrs: { role: "group", "aria-label": "Payout method" } });
  const draw = () => {
    choices.replaceChildren(...TYPES.map(([value, label, glyph]) => el("button", { class: "choice", attrs: { type: "button", "aria-pressed": String(value === type) }, on: { click: () => { type = value; draw(); } } }, [icon(glyph), el("span", { text: label })])));
    const fields = [];
    if (type === "bank-transfer") {
      fields.push(field("Bank account currency", select("currency", CURRENCIES, recipient.primaryCurrency ?? "USD")), field("Bank country", input("country", recipient.address?.country ?? "US", { maxlength: 2 })),
        field("Account holder name", input("accountHolderName", recipient.name), { full: true }), field("Routing / branch number", input("branchId")), field("Account number", input("accountNum", "", { inputmode: "numeric" })),
        field("Bank ID (Canada)", input("bankId")), field("IBAN (instead of account number)", input("iban")));
    } else if (type === "paypal") {
      fields.push(field("PayPal email", input("emailAddress", recipient.email, { type: "email" }), { full: true }), field("Currency", select("currency", CURRENCIES, "USD")));
    } else if (type === "venmo") {
      fields.push(field("Venmo phone number", input("phoneNumber", recipient.phone ?? ""), { full: true, hint: "US numbers only" }));
    } else {
      const a = recipient.address ?? {};
      fields.push(field("Name on check", input("mailing.name", recipient.name), { full: true }), field("Street", input("mailing.street1", a.street1), { full: true }),
        field("City", input("mailing.city", a.city)), field("State", input("mailing.region", a.region)), field("ZIP", input("mailing.postal", a.postalCode)), field("Country", input("mailing.country", "US", { maxlength: 2 })));
    }
    form.replaceChildren(choices, ...fields);
  };
  draw();
  const formError = el("div", { class: "form-error", attrs: { role: "alert" } });
  const save = btn("Add payout method", "dark");
  let key = newKey();
  let keyType = type;
  app.editing += 1;
  const modal = openModal({
    title: "Select payout method",
    body: [el("p", { text: "Processing time and fees follow this synthetic merchant's schedule. No bank, PayPal, Venmo or mail network is contacted." }), form, formError],
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save],
    onClose: () => { app.editing -= 1; },
  });
  save.addEventListener("click", async () => {
    const d = Object.fromEntries(new FormData(form).entries());
    const args = { recipientId: recipient.id, type };
    const mailing = {};
    for (const [name, raw] of Object.entries(d)) {
      const value = String(raw).trim();
      if (!value) continue;
      if (name.startsWith("mailing.")) mailing[name.slice(8)] = name.endsWith("country") ? value.toUpperCase() : value;
      else args[name] = name === "country" ? value.toUpperCase() : value;
    }
    if (type === "check") args.mailing = mailing;
    if (keyType !== type) { key = newKey(); keyType = type; }
    save.disabled = true;
    formError.textContent = "";
    try {
      await call("recipient_accounts.create", args, key);
      modal.close();
      toast("Payout method added.");
      done();
    } catch (error) {
      if (!showFieldError(form, error)) formError.textContent = describe(error);
      save.disabled = false;
    }
  });
}
