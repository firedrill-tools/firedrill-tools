// Customers list, customer detail (payment methods, subscriptions, invoices, payments) and the add/edit modals.
import { icon } from "./icons.js";
import { canRead, canWrite, indexAll, invalidateCache, navigate, now, registerPage, routeHash, setTitle } from "./store.js";
import { ToolError, action, avatar, badge, button, call, cardChip, confirmDialog, dateTime, el, field, humanize, idChip, input, intentStatus, invoiceStatus, key, link, money, moneyCell, openMenu, openModal, select, statusBadge, subscriptionStatus, textarea, toast } from "./ui.js";
import { alert, amountWithStatus, boundNote, chip, dateCell, deniedPanel, empty, kv, listTools, load, metaBar, methodPicker, notSimulated, pageHeader, pageInner, pagedList, section, statTabs, submitModal, table } from "./widgets.js";
import { chargeOf } from "./pages-payments.js";

function customerRows(customers) {
  return table({
    select: { label: "customers", rowLabel: (customer) => `customer ${customer.name ?? customer.id}` },
    columns: [
      { label: "Name", class: "truncate", render: (customer) => el("span", { class: "customer-cell" }, [avatar(customer.name || customer.email || "?", customer.id, "sm"), el("span", { class: "truncate", text: customer.name ?? el("span", { class: "muted", text: "No name" }) })]) },
      { label: "Email", class: "truncate", render: (customer) => customer.email ?? el("span", { class: "muted", text: "—" }) },
      { label: "Default payment method", class: "nowrap", render: (customer) => (customer.invoice_settings?.default_payment_method && typeof customer.invoice_settings.default_payment_method === "object" ? cardChip(customer.invoice_settings.default_payment_method) : el("span", { class: "muted", text: "—" })) },
      { label: "Status", class: "nowrap", render: (customer) => (customer.delinquent ? badge("Delinquent", "red", "alert-circle") : el("span", { class: "muted", text: "—" })) },
      { label: "Created", class: "nowrap", render: (customer) => dateCell(customer.created) },
      { label: "", class: "actions", render: (customer) => customerMenu(customer) },
    ],
    rows: customers,
    href: (customer) => `#/customers/${customer.id}`,
    onOpen: (customer) => navigate(`#/customers/${customer.id}`),
  });
}

function customerMenu(customer) {
  const trigger = button(undefined, "ghost", { icon: "more", size: "sm", ariaLabel: `Actions for ${customer.name ?? customer.id}`, class: "btn-icon-only" });
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(trigger, [
      { label: "View customer", icon: "external", onSelect: () => navigate(`#/customers/${customer.id}`) },
      { label: "Copy customer ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(customer.id).then(() => toast("Copied to clipboard")) },
      ...(canWrite("payment_intents") ? [{ label: "Create payment", icon: "payments", onSelect: () => navigate(routeHash("payments", "new", { customer: customer.id })) }] : []),
      ...(canWrite("invoices") ? [{ label: "Create invoice", icon: "invoices", onSelect: () => navigate(routeHash("invoices", "new", { customer: customer.id })) }] : []),
      ...(canWrite("subscriptions") ? [{ label: "Create subscription", icon: "subscriptions", onSelect: () => navigate(routeHash("subscriptions", "new", { customer: customer.id })) }] : []),
    ], { align: "end" });
  });
  return trigger;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

registerPage("customers", async (host, route) => {
  setTitle("Customers");
  const actions = [];
  if (canWrite("customers")) actions.push(button("Add customer", "primary", { icon: "plus", onClick: () => openCustomerForm() }));
  const header = pageHeader("Customers", { actions });
  const segmentsHost = el("div");
  const drawSegments = (allCount) => segmentsHost.replaceChildren(statTabs(CUSTOMER_SEGMENTS.map((segment) => (segment.key === "all" ? { ...segment, count: allCount } : segment)), "all", () => navigate("#/customers")));
  drawSegments(undefined);
  const filters = el("div", { class: "filters" });
  const listHost = el("div");
  host.replaceChildren(pageInner(header, segmentsHost, filters, listHost));
  if (!canRead("customers")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "customers" }), "customers"));
    return;
  }
  const email = route.params.email ?? "";
  const emailInput = input({ placeholder: "Filter by exact email", value: email, type: "search" });
  emailInput.setAttribute("aria-label", "Filter customers by exact email");
  const emailChip = el("form", { class: "chip-input", attrs: { role: "search" } }, [icon("search"), emailInput]);
  emailChip.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(routeHash("customers", undefined, { email: emailInput.value.trim() || undefined }));
  });
  filters.append(
    emailChip,
    chip("Card", { onClick: () => notSimulated("Card filter", "customers.list filters by exact email only.") }),
    chip("Created date", { onClick: () => notSimulated("Created date filter", "customers.list filters by exact email only.") }),
    chip("Type", { onClick: () => notSimulated("Type filter", "All customers in this synthetic account are individuals.") }),
    chip("More filters", { onClick: () => notSimulated("More filters") }),
    listTools([["Analyze", "sparkline", "Customer analytics are not simulated."]]),
  );
  if (email) filters.append(button("Clear", "link", { onClick: () => navigate("#/customers") }));
  filters.append(el("span", { class: "filters-note", text: "Email filter is exact and case-sensitive, as in the API" }));
  const list = pagedList({
    operation: "customers.list",
    args: { expand: ["data.invoice_settings.default_payment_method"], ...(email ? { email } : {}) },
    limit: 20,
    render: customerRows,
    emptyNode: () => (email ? empty("No customers match", `No customer has the email ${email}.`) : empty("No customers yet", "Customers are created when a payment is made or when you add one.", canWrite("customers") ? button("Add customer", "primary", { icon: "plus", onClick: () => openCustomerForm() }) : undefined)),
  });
  listHost.append(list.element);
  try {
    const index = await indexAll("customers.list", {});
    drawSegments(`${index.items.length}${index.complete ? "" : "+"}`);
  } catch {
    drawSegments(undefined);
  }
});

const SEGMENT_NOTE = "Customer segments are computed by Stripe's analytics, which this synthetic account does not run. Only the All count comes from customers.list.";
const CUSTOMER_SEGMENTS = Object.freeze([
  { key: "all", label: "All" },
  { key: "top", label: "Top customers", notSimulated: SEGMENT_NOTE },
  { key: "first_time", label: "First-time customers", notSimulated: SEGMENT_NOTE },
  { key: "repeat", label: "Repeat customers", notSimulated: SEGMENT_NOTE },
  { key: "recent", label: "Recent customers", notSimulated: SEGMENT_NOTE },
  { key: "high_refunds", label: "High refunds", notSimulated: SEGMENT_NOTE },
  { key: "high_disputes", label: "High disputes", notSimulated: SEGMENT_NOTE },
]);

// ---------------------------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------------------------

registerPage("customer", async (host, route) => {
  const id = route.id;
  setTitle(id);
  const inner = pageInner();
  host.replaceChildren(inner);
  await load(inner, async () => {
    const customer = await call("customers.retrieve", { customer: id, expand: ["invoice_settings.default_payment_method"] });
    return renderCustomer(customer);
  }, { retry: () => navigate(location.hash) });
});

function renderCustomer(customer) {
  const name = customer.name || customer.email || customer.id;
  const defaultMethod = customer.invoice_settings?.default_payment_method;
  const defaultId = typeof defaultMethod === "object" && defaultMethod !== null ? defaultMethod.id : defaultMethod;
  const actions = [];
  if (canWrite("payment_intents")) actions.push(button("Create payment", "secondary", { onClick: () => navigate(routeHash("payments", "new", { customer: customer.id })) }));
  if (canWrite("invoices")) actions.push(button("Create invoice", "secondary", { onClick: () => navigate(routeHash("invoices", "new", { customer: customer.id })) }));
  if (canWrite("subscriptions")) actions.push(button("Create subscription", "secondary", { onClick: () => navigate(routeHash("subscriptions", "new", { customer: customer.id })) }));
  const more = button(undefined, "secondary", { icon: "more", ariaLabel: "More actions", class: "btn-icon-only" });
  more.addEventListener("click", () =>
    openMenu(more, [
      ...(canWrite("customers") ? [{ label: "Edit information", icon: "edit", onSelect: () => openCustomerForm(customer) }] : []),
      { label: "Copy customer ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(customer.id).then(() => toast("Copied to clipboard")) },
      "divider",
      { label: "Delete customer", icon: "trash", danger: true, disabled: true, description: "Not offered by this synthetic account" },
    ], { align: "end" }),
  );
  actions.push(more);
  const title = el("div", { class: "detail-title" }, [avatar(name, customer.id, "lg"), el("div", {}, [el("h1", { class: "page-title", text: name }), customer.email && customer.name ? el("div", { class: "page-subtitle", text: customer.email }) : null]), customer.delinquent ? badge("Delinquent", "red", "alert-circle") : null]);
  const header = pageHeader(title, { kind: "Customer", actions, breadcrumbs: [{ label: "Customers", href: "#/customers" }, { label: customer.id }] });
  const meta = metaBar([
    ["Account balance", el("span", {}, [moneyCell(customer.balance, customer.currency ?? "usd"), customer.balance < 0 ? el("span", { class: "muted", text: " credit" }) : null])],
    ["Default payment method", typeof defaultMethod === "object" && defaultMethod !== null ? cardChip(defaultMethod) : el("span", { class: "muted", text: "None" })],
    ["Created", dateTime(customer.created, now())],
    ["Customer since", relativeDays(customer.created)],
  ]);

  const details = section("Details", [
    kv([
      ["Customer ID", idChip(customer.id)],
      ["Customer since", dateTime(customer.created, now())],
      ["Name", customer.name],
      ["Email", customer.email],
      ["Phone", customer.phone],
      ["Description", customer.description],
      ["Billing address", addressText(customer.address)],
      ["Shipping", customer.shipping ? `${customer.shipping.name ?? ""}${customer.shipping.name ? ", " : ""}${addressText(customer.shipping.address) ?? ""}` : null],
      ["Preferred locales", customer.preferred_locales?.length ? customer.preferred_locales.join(", ") : null],
      ["Tax status", customer.tax_exempt === "none" ? "Taxable" : humanize(customer.tax_exempt)],
      ["Invoice prefix", el("code", { class: "id-code", text: customer.invoice_prefix })],
      ["Next invoice number", `${customer.invoice_prefix}-${String(customer.next_invoice_sequence).padStart(4, "0")}`],
      ["Currency", customer.currency ? customer.currency.toUpperCase() : null],
      ["Delinquent", customer.delinquent ? "Yes — an open invoice is past due" : "No"],
    ]),
  ], { actions: canWrite("customers") ? [button("Edit", "secondary", { size: "sm", icon: "edit", onClick: () => openCustomerForm(customer) })] : [] });
  details.querySelector(".kv").classList.add("kv-stacked");

  const methodsHost = el("div");
  const methodsSection = section("Payment methods", methodsHost, { actions: canWrite("payment_methods") ? [button("Add payment method", "secondary", { size: "sm", icon: "plus", onClick: () => openAttach(customer) })] : [] });
  void loadMethods(methodsHost, customer, defaultId);

  const subscriptionsHost = el("div");
  const subscriptionsSection = section("Subscriptions", subscriptionsHost, { actions: [link("#/subscriptions", "View all", { class: "btn btn-link" })] });
  void loadSubscriptions(subscriptionsHost, customer);

  const invoicesHost = el("div");
  const invoicesSection = section("Invoices", invoicesHost, { actions: [link(routeHash("invoices", undefined, { customer: customer.id }), "View all", { class: "btn btn-link" })] });
  void loadInvoices(invoicesHost, customer);

  const paymentsHost = el("div");
  const paymentsSection = section("Payments", paymentsHost, { actions: [link("#/payments", "View all", { class: "btn btn-link" })] });
  void loadPayments(paymentsHost, customer);

  const metadataRows = Object.entries(customer.metadata ?? {});
  const metadataSection = section("Metadata", metadataRows.length > 0 ? kv(metadataRows) : el("p", { class: "muted", text: "No metadata" }));
  if (metadataRows.length > 0) metadataSection.querySelector(".kv").classList.add("kv-stacked");
  const eventsSection = section("Events", el("p", { class: "muted", text: "Stripe event objects are not simulated for this account." }));

  return [header, meta, el("div", { class: "detail-layout" }, [el("div", { class: "detail-main" }, [paymentsSection, subscriptionsSection, methodsSection, invoicesSection, eventsSection]), el("aside", { class: "detail-rail", attrs: { "aria-label": "Customer details" } }, [details, metadataSection])])];
}

function relativeDays(created) {
  const days = Math.max(0, Math.floor((now() - created) / 86400));
  if (days < 1) return "Today";
  if (days < 31) return `${days} day${days === 1 ? "" : "s"}`;
  if (days < 365) return `${Math.floor(days / 30)} month${Math.floor(days / 30) === 1 ? "" : "s"}`;
  return `${Math.floor(days / 365)} year${Math.floor(days / 365) === 1 ? "" : "s"}`;
}

export function addressText(address) {
  if (!address) return null;
  const parts = [address.line1, address.line2, [address.city, address.state].filter(Boolean).join(", "), address.postal_code, address.country].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

async function loadMethods(host, customer, defaultId) {
  if (!canRead("payment_methods")) {
    host.replaceChildren(el("p", { class: "muted", text: "This key cannot read payment methods." }));
    return;
  }
  await load(host, async () => {
    const methodIndex = await indexAll("payment_methods.list", { customer: customer.id });
    const methods = methodIndex.items;
    if (methods.length === 0) return el("p", { class: "muted", text: "No payment methods. Add one of Stripe's test cards to charge this customer." });
    const list = el("div", { class: "pm-list" });
    for (const method of methods) {
      const row = el("div", { class: "pm-row" }, [cardChip(method, { expiry: true }), method.id === defaultId ? badge("Default", "purple") : null]);
      const actions = el("div", { class: "btn-group" });
      if (canWrite("customers") && method.id !== defaultId) actions.append(button("Set as default", "ghost", { size: "sm", onClick: () => setDefault(customer, method) }));
      if (canWrite("payment_methods")) actions.append(button("Detach", "ghost", { size: "sm", onClick: () => detach(customer, method) }));
      row.append(actions);
      list.append(row);
    }
    const note = boundNote(methodIndex, "payment methods of this customer");
    return note ? el("div", {}, [note, list]) : list;
  });
}

async function loadSubscriptions(host, customer) {
  if (!canRead("subscriptions")) {
    host.replaceChildren(el("p", { class: "muted", text: "This key cannot read subscriptions." }));
    return;
  }
  host.replaceChildren(pagedList({
    operation: "subscriptions.list",
    args: { customer: customer.id, status: "all" },
    limit: 10,
    emptyNode: () => el("p", { class: "muted", text: "No subscriptions." }),
    render: (rows) => table({
      columns: [
        { label: "Subscription", render: (subscription) => el("span", { text: subscription.items.data.map((item) => item.price.nickname ?? item.price.id).join(", ") }) },
        { label: "Status", class: "nowrap", render: (subscription) => statusBadge(subscriptionStatus(subscription, now())) },
        { label: "Amount", class: "nowrap", render: (subscription) => subscriptionAmount(subscription) },
        { label: "Current period", class: "nowrap muted", render: (subscription) => `${dateTime(subscription.items.data[0]?.current_period_start, now())} – ${dateTime(subscription.items.data[0]?.current_period_end, now())}` },
        { label: "Created", class: "nowrap", render: (subscription) => dateCell(subscription.created) },
      ],
      rows,
      href: (subscription) => `#/subscriptions/${subscription.id}`,
      onOpen: (subscription) => navigate(`#/subscriptions/${subscription.id}`),
    }),
  }).element);
}

export function subscriptionAmount(subscription) {
  const items = subscription.items.data;
  const total = items.reduce((sum, item) => sum + (item.price.unit_amount ?? 0) * (item.quantity ?? 1), 0);
  const recurring = items[0]?.price.recurring;
  const suffix = recurring ? (recurring.interval_count === 1 ? ` / ${recurring.interval}` : ` every ${recurring.interval_count} ${recurring.interval}s`) : "";
  return el("span", { class: "money" }, [el("span", { class: "money-value", text: money(total, subscription.currency) }), el("span", { class: "money-currency", text: suffix.trim() })]);
}

async function loadInvoices(host, customer) {
  if (!canRead("invoices")) {
    host.replaceChildren(el("p", { class: "muted", text: "This key cannot read invoices." }));
    return;
  }
  host.replaceChildren(pagedList({
    operation: "invoices.list",
    args: { customer: customer.id },
    limit: 10,
    emptyNode: () => el("p", { class: "muted", text: "No invoices." }),
    render: (rows) => table({
      columns: [
        { label: "Amount", class: "nowrap", render: (invoice) => amountWithStatus(invoice.total, invoice.currency, statusBadge(invoiceStatus(invoice, now()))) },
        { label: "Invoice number", render: (invoice) => invoice.number ?? el("span", { class: "muted", text: "Draft" }) },
        { label: "Due", class: "nowrap muted", render: (invoice) => (invoice.due_date ? dateTime(invoice.due_date, now()) : "—") },
        { label: "Created", class: "nowrap", render: (invoice) => dateCell(invoice.created) },
      ],
      rows,
      href: (invoice) => `#/invoices/${invoice.id}`,
      onOpen: (invoice) => navigate(`#/invoices/${invoice.id}`),
    }),
  }).element);
}

async function loadPayments(host, customer) {
  if (!canRead("payment_intents")) {
    host.replaceChildren(el("p", { class: "muted", text: "This key cannot read payments." }));
    return;
  }
  host.replaceChildren(pagedList({
    operation: "payment_intents.list",
    args: { customer: customer.id, expand: ["data.latest_charge"] },
    limit: 10,
    emptyNode: () => el("p", { class: "muted", text: "No payments." }),
    render: (rows) => table({
      columns: [
        { label: "Amount", class: "nowrap", render: (intent) => amountWithStatus(intent.amount, intent.currency, statusBadge(intentStatus(intent, chargeOf(intent)))) },
        { label: "Description", class: "truncate", render: (intent) => intent.description },
        { label: "Payment method", class: "nowrap", render: (intent) => (chargeOf(intent)?.payment_method_details?.card ? cardChip({ card: chargeOf(intent).payment_method_details.card }) : null) },
        { label: "Date", class: "nowrap", render: (intent) => dateCell(intent.created) },
      ],
      rows,
      href: (intent) => `#/payments/${intent.id}`,
      onOpen: (intent) => navigate(`#/payments/${intent.id}`),
    }),
  }).element);
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

async function setDefault(customer, method) {
  await action(async () => {
    await call("customers.update", { customer: customer.id, invoice_settings: { default_payment_method: method.id } }, key());
    toast("Default payment method updated");
    invalidateCache();
    navigate(location.hash);
  });
}

async function detach(customer, method) {
  const ok = await confirmDialog("Detach payment method?", `${method.card ? `${humanize(method.card.brand)} •••• ${method.card.last4}` : method.id} will no longer be usable for this customer's payments, invoices or subscriptions.`, "Detach", { danger: true });
  if (!ok) return;
  await action(async () => {
    await call("payment_methods.detach", { payment_method: method.id }, key());
    toast("Payment method detached");
    invalidateCache();
    navigate(location.hash);
  });
}

function openAttach(customer) {
  const picker = methodPicker({ includeTestCards: true });
  const makeDefault = el("input", { attrs: { type: "checkbox" } });
  makeDefault.checked = !customer.invoice_settings?.default_payment_method;
  const fields = { payment_method: field("Card", picker, { hint: "Test cards materialise as real pm_… objects when attached, as in Stripe's test mode." }) };
  const idempotencyKey = key();
  openModal({
    title: "Add payment method",
    body: [fields.payment_method, el("label", { class: "check-field" }, [makeDefault, el("span", { class: "check-label", text: "Use as default for invoices and subscriptions" })])],
    actions: [
      { label: "Cancel" },
      {
        label: "Add",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          if (!picker.value) {
            fields.payment_method.setError("Choose a card.");
            return;
          }
          return submitModal(api, fields, async () => {
            const method = await call("payment_methods.attach", { payment_method: picker.value, customer: customer.id }, idempotencyKey);
            if (makeDefault.checked && canWrite("customers")) await call("customers.update", { customer: customer.id, invoice_settings: { default_payment_method: method.id } }, key());
            return method;
          }, () => {
            toast("Payment method added");
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

/** Add (no `existing`) or edit a customer. */
export function openCustomerForm(existing, onCreated) {
  const name = input({ placeholder: "Jane Diaz", value: existing?.name ?? "" });
  const email = input({ type: "email", placeholder: "jane.diaz@example.com", value: existing?.email ?? "" });
  const description = textarea({ placeholder: "Internal note about this customer", value: existing?.description ?? "", rows: 2 });
  const phone = input({ placeholder: "+1 555 0100", value: existing?.phone ?? "" });
  const line1 = input({ placeholder: "Address line 1", value: existing?.address?.line1 ?? "" });
  const line2 = input({ placeholder: "Address line 2", value: existing?.address?.line2 ?? "" });
  const city = input({ placeholder: "City", value: existing?.address?.city ?? "" });
  const state = input({ placeholder: "State / province", value: existing?.address?.state ?? "" });
  const postal = input({ placeholder: "Postal code", value: existing?.address?.postal_code ?? "" });
  const country = input({ placeholder: "Country (ISO, e.g. US)", value: existing?.address?.country ?? "", maxlength: 2 });
  for (const [control, label] of [[line1, "Address line 1"], [line2, "Address line 2"], [city, "City"], [state, "State or province"], [postal, "Postal code"], [country, "Country (two-letter ISO code)"]]) control.setAttribute("aria-label", label);
  const taxExempt = select([{ value: "none", label: "Taxable" }, { value: "exempt", label: "Exempt" }, { value: "reverse", label: "Reverse charge" }], existing?.tax_exempt ?? "none");
  const fields = {
    name: field("Name", name),
    email: field("Email", email, { optional: true }),
    description: field("Description", description, { optional: true }),
    phone: field("Phone", phone, { optional: true }),
    address: field("Billing address", el("div", { class: "inline-list" }, [line1, line2, el("div", { class: "field-row" }, [city, state]), el("div", { class: "field-row" }, [postal, country])]), { optional: true }),
    tax_exempt: field("Tax status", taxExempt),
  };
  const idempotencyKey = key();
  openModal({
    title: existing ? "Update customer" : "Add customer",
    size: "modal-lg",
    body: [fields.name, fields.email, fields.description, fields.phone, fields.address, fields.tax_exempt],
    actions: [
      { label: "Cancel" },
      {
        label: existing ? "Update customer" : "Add customer",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          const args = { name: name.value.trim(), email: email.value.trim(), description: description.value.trim(), phone: phone.value.trim(), tax_exempt: taxExempt.value };
          const hasAddress = [line1, line2, city, state, postal, country].some((control) => control.value.trim());
          if (hasAddress) args.address = { line1: line1.value.trim() || null, line2: line2.value.trim() || null, city: city.value.trim() || null, state: state.value.trim() || null, postal_code: postal.value.trim() || null, country: country.value.trim().toUpperCase() || null };
          if (!existing) for (const [name_, value] of Object.entries(args)) if (value === "") delete args[name_];
          return submitModal(api, fields, () => (existing ? call("customers.update", { customer: existing.id, ...args }, idempotencyKey) : call("customers.create", args, idempotencyKey)), (customer) => {
            toast(existing ? "Customer updated" : "Customer added");
            invalidateCache();
            if (onCreated) onCreated(customer);
            else navigate(`#/customers/${customer.id}`);
          });
        },
      },
    ],
  });
}

