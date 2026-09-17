// Recipient profile: header, profile details (edit), payout methods, archive/restore.
import { app, go, setTitle } from "./app.js";
import { errorBlock, stateBlock } from "./list.js";
import { btn, call, confirmDialog, date, describe, el, field, human, initials, input, newKey, openModal, pill, showFieldError, toast } from "./ui.js";
import { openAddMethod, methodIcon, methodLine } from "./view-methods.js";

export async function renderRecipient(host, route, view) {
  setTitle("Recipients");
  host.replaceChildren(el("div", { class: "card card-body" }, el("div", { class: "skeleton" })));
  let recipient;
  let accounts;
  try {
    [recipient, accounts] = await Promise.all([
      call("recipients.get", { recipientId: route.id }).then((v) => v.recipient),
      call("recipient_accounts.list", { recipientId: route.id }).then((v) => v.accounts),
    ]);
  } catch (error) {
    if (!view.isCurrent()) return;
    host.replaceChildren(crumbs(route.id), el("section", { class: "card" }, error.is?.("NOT_FOUND") ? stateBlock("user", "Recipient not found", "It may have been removed or the ID is wrong.") : errorBlock(error, () => go("recipients", route.id))));
    return;
  }
  if (!view.isCurrent()) return;
  const archived = recipient.status === "archived";

  const actions = archived
    ? btn("Restore recipient", "secondary", { onClick: () => mutate("recipients.update", { recipientId: recipient.id, status: "active" }, "Recipient restored.") })
    : btn("Archive", "secondary", { onClick: archive });
  const head = el("div", { class: "profile-head" }, [
    el("span", { class: `face${recipient.type === "business" ? " biz" : ""}`, text: initials(recipient.name), attrs: { "aria-hidden": "true" } }),
    el("div", {}, [el("h2", { text: recipient.name || "(no name)" }), el("div", { class: "method-sub", text: `${human(recipient.type)} · ${recipient.email ?? ""}` })]),
    pill(recipient.status), pill(recipient.complianceStatus),
    el("span", { class: "spacer" }), actions,
  ]);

  const address = recipient.address ?? {};
  const addressText = [address.street1, address.street2, address.city, address.region, address.postalCode, address.country].filter(Boolean).join(", ");
  const details = el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", { text: "Profile" }), el("span", { class: "spacer" }), btn("Edit", "secondary", { small: true, disabled: archived, onClick: openEdit })]),
    el("div", { class: "card-body" }, el("dl", { class: "dl" }, [
      ["Recipient ID", recipient.id], ["Reference ID", recipient.referenceId ?? "—"], ["Email", recipient.email ?? "—"],
      ["Phone", recipient.phone ?? "—"], ["Date of birth", recipient.dob ?? "—"], ["Address", addressText || "Missing (profile incomplete)"],
      ["Tags", (recipient.tags ?? []).join(", ") || "—"], ["Created", date(recipient.createdAt, true)], ["Last updated", date(recipient.updatedAt, true)],
    ].flatMap(([k, v]) => [el("dt", { text: k }), el("dd", { text: v })]))),
  ]);

  const methodsBody = el("div", { class: "card-body" });
  if (accounts.length === 0) methodsBody.append(stateBlock("bank", "No payout method", "Add a payout method so this recipient can be paid."));
  for (const account of accounts) {
    const row = el("div", { class: "method" }, [
      el("div", { class: "method-icon" }, methodIcon(account.type)),
      el("div", { class: "method-main" }, [el("div", { class: "method-title" }, [el("span", { text: `${human(account.type)} · ${account.currency ?? ""} ` }), account.primary ? pill("primary") : null]), el("div", { class: "method-sub", text: methodLine(account) })]),
    ]);
    if (!account.primary && !archived) row.append(btn("Make primary", "link", { small: true, onClick: () => mutate("recipient_accounts.update", { recipientId: recipient.id, accountId: account.id, primary: true }, "Primary payout method updated.") }));
    if (!archived) row.append(btn("Remove", "link", { small: true, onClick: () => removeAccount(account) }));
    methodsBody.append(row);
  }
  const route_ = recipient.payoutMethod ? el("div", { class: "method-sub", text: `Route: ${human(recipient.routeType ?? "")} · minimum ${recipient.routeMinimum ?? "—"} · estimated fees ${recipient.estimatedFees ?? "—"}` }) : null;
  const methods = el("section", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", { text: "Payout methods" }), el("span", { class: "spacer" }), btn("Add payout method", "dark", { disabled: archived, onClick: () => openAddMethod(recipient, () => go("recipients", recipient.id)) })]),
    methodsBody, route_ ? el("div", { class: "card-body" }, route_) : null,
  ]);

  host.replaceChildren(crumbs(recipient.name || recipient.id),
    archived ? el("div", { class: "banner banner-warn", attrs: { role: "status" } }, el("span", { text: "This recipient is archived. Restore it to edit details or add payments." })) : "",
    head, el("div", { class: "grid-2" }, [details, methods]));

  async function mutate(operation, args, message) {
    try {
      await call(operation, args, newKey());
      toast(message);
    } catch (error) {
      toast(describe(error), { error: true });
    }
    go("recipients", recipient.id);
  }
  async function archive() {
    if (await confirmDialog("Archive recipient?", `${recipient.name} will be hidden from the recipient list and cannot be added to new payments.`, "Archive", { danger: true })) {
      await mutate("recipients.delete", { recipientId: recipient.id }, "Recipient archived.");
    }
  }
  async function removeAccount(account) {
    if (await confirmDialog("Remove payout method?", `${human(account.type)} ${methodLine(account)} will be disabled.`, "Remove", { danger: true })) {
      await mutate("recipient_accounts.delete", { recipientId: recipient.id, accountId: account.id }, "Payout method removed.");
    }
  }
  function openEdit() {
    const form = el("form", { class: "form-grid", attrs: { novalidate: true } });
    const individual = recipient.type === "individual";
    form.append(
      ...(individual ? [field("First name", input("firstName", recipient.firstName)), field("Last name", input("lastName", recipient.lastName))] : [field("Business name", input("name", recipient.name), { full: true })]),
      field("Email", input("email", recipient.email)), field("Phone", input("phone", recipient.phone)),
      field("Reference ID", input("referenceId", recipient.referenceId)), field("Tags", input("tags", (recipient.tags ?? []).join(", ")), { hint: "Comma separated" }),
      field("Street address", input("street1", address.street1), { full: true }), field("City", input("city", address.city)),
      field("Region / state", input("region", address.region)), field("Postal code", input("postalCode", address.postalCode)), field("Country code", input("country", address.country, { maxlength: 2 })),
    );
    const formError = el("div", { class: "form-error", attrs: { role: "alert" } });
    const save = btn("Save changes", "primary");
    const key = newKey();
    app.editing += 1;
    const modal = openModal({ title: "Edit profile", body: [form, formError], wide: true, actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save], onClose: () => { app.editing -= 1; } });
    save.addEventListener("click", async () => {
      const d = Object.fromEntries(new FormData(form).entries());
      const args = { recipientId: recipient.id, email: d.email.trim(), tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean) };
      if (individual) { args.firstName = d.firstName.trim(); args.lastName = d.lastName.trim(); } else args.name = d.name.trim();
      if (d.phone.trim()) args.phone = d.phone.trim();
      if (d.referenceId.trim()) args.referenceId = d.referenceId.trim();
      args.address = { street1: d.street1.trim() || null, city: d.city.trim() || null, region: d.region.trim() || null, postalCode: d.postalCode.trim() || null, country: d.country.trim().toUpperCase() || null };
      save.disabled = true;
      try {
        await call("recipients.update", args, key);
        modal.close();
        toast("Profile saved.");
        go("recipients", recipient.id);
      } catch (error) {
        if (!showFieldError(form, error)) formError.textContent = describe(error);
        save.disabled = false;
      }
    });
  }
}

function crumbs(label) {
  return el("nav", { class: "crumbs", attrs: { "aria-label": "Breadcrumb" } }, [el("a", { text: "Recipients", attrs: { href: "#/recipients" } }), el("span", { text: "›" }), el("span", { text: label })]);
}
