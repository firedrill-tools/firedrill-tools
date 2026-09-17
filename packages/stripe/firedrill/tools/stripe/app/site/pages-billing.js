// Billing: invoices (list, invoice page with the draft editor, create) and subscriptions (list, detail, create).
import { icon } from "./icons.js";
import { app, canRead, canWrite, indexAll, invalidateCache, navigate, now, registerPage, routeHash, setTitle } from "./store.js";
import { ToolError, action, badge, button, call, cardChip, confirmDialog, dateOnly, dateTime, el, field, humanize, idChip, input, intentStatus, invoiceStatus, key, link, money, moneyCell, openMenu, openModal, priceLabel, select, statusBadge, subscriptionStatus, text, textarea, toast } from "./ui.js";
import { alert, amountInput, amountWithStatus, applyError, chip, customerCell, customerPicker, dateCell, deniedPanel, empty, kv, listTools, load, metaBar, methodPicker, notSimulated, pageHeader, pageInner, pagedList, section, statTabs, submitModal, table, timeline } from "./widgets.js";
import { addressText, openCustomerForm, subscriptionAmount } from "./pages-customers.js";

const INVOICE_TABS = [
  { key: "all", label: "All invoices" },
  { key: "draft", label: "Draft" },
  { key: "open", label: "Outstanding" },
  { key: "past_due", label: "Past due" },
  { key: "paid", label: "Paid" },
  { key: "void", label: "Void" },
];

function invoiceRows(invoices) {
  return table({
    select: { label: "invoices", rowLabel: (invoice) => `invoice ${invoice.number ?? invoice.id}` },
    columns: [
      { label: "Amount", class: "nowrap", render: (invoice) => amountWithStatus(invoice.total, invoice.currency, statusBadge(invoiceStatus(invoice, now()))) },
      { label: "Invoice number", class: "nowrap", render: (invoice) => invoice.number ?? el("span", { class: "muted", text: "Draft" }) },
      { label: "Customer", class: "truncate", render: (invoice) => customerCell(typeof invoice.customer === "object" && invoice.customer !== null ? invoice.customer : { id: invoice.customer, name: invoice.customer_name, email: invoice.customer_email }) },
      { label: "Due", class: "nowrap muted", render: (invoice) => (invoice.due_date ? dateOnly(invoice.due_date, now()) : "—") },
      { label: "Created", class: "nowrap", render: (invoice) => dateCell(invoice.created) },
      { label: "", class: "actions", render: (invoice) => invoiceMenu(invoice) },
    ],
    rows: invoices,
    href: (invoice) => `#/invoices/${invoice.id}`,
    onOpen: (invoice) => navigate(`#/invoices/${invoice.id}`),
  });
}

function invoiceMenu(invoice) {
  const trigger = button(undefined, "ghost", { icon: "more", size: "sm", ariaLabel: `Actions for ${invoice.number ?? invoice.id}`, class: "btn-icon-only" });
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(trigger, [
      { label: "View invoice", icon: "external", onSelect: () => navigate(`#/invoices/${invoice.id}`) },
      { label: "Copy invoice ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(invoice.id).then(() => toast("Copied to clipboard")) },
      { label: "View customer", icon: "customers", onSelect: () => navigate(`#/customers/${typeof invoice.customer === "object" ? invoice.customer.id : invoice.customer}`) },
    ], { align: "end" });
  });
  return trigger;
}

// ---------------------------------------------------------------------------------------------
// Invoices list
// ---------------------------------------------------------------------------------------------

registerPage("invoices", async (host, route) => {
  setTitle("Invoices");
  const tab = route.params.tab ?? "all";
  const customer = route.params.customer;
  const actions = [];
  if (canWrite("invoices")) actions.push(button("Create invoice", "primary", { icon: "plus", onClick: () => navigate(routeHash("invoices", "new", { customer })) }));
  const header = pageHeader("Invoices", { actions });
  const tabsHost = el("div");
  const filters = el("div", { class: "filters" });
  const listHost = el("div");
  host.replaceChildren(pageInner(header, tabsHost, filters, listHost));
  if (!canRead("invoices")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "invoices" }), "invoices"));
    return;
  }
  const select_ = (next) => navigate(routeHash("invoices", undefined, { ...route.params, tab: next === "all" ? undefined : next }));
  tabsHost.append(statTabs(INVOICE_TABS, tab, select_));
  const clearCustomer = () => navigate(routeHash("invoices", undefined, { tab: tab === "all" ? undefined : tab }));
  filters.append(
    customer ? chip("Customer", { active: true, value: customer, onClick: clearCustomer, onClear: clearCustomer }) : chip("Customer", { onClick: () => notSimulated("Customer filter", "Open a customer and choose Invoices › View all to filter this list by that customer.") }),
    chip("Created date", { onClick: () => notSimulated("Created date filter") }),
    chip("Due date", { onClick: () => notSimulated("Due date filter") }),
    chip("More filters", { onClick: () => notSimulated("More filters") }),
    listTools(),
  );
  const args = { expand: ["data.customer"] };
  if (customer) args.customer = customer;
  if (tab === "past_due") {
    args.status = "open";
    args.due_date = { lt: now() };
  } else if (tab !== "all") args.status = tab;
  const list = pagedList({
    operation: "invoices.list",
    args,
    limit: 20,
    render: invoiceRows,
    emptyNode: () => empty(tab === "all" ? "No invoices yet" : `No ${INVOICE_TABS.find((entry) => entry.key === tab)?.label.toLowerCase()} invoices`, "Invoices you create, or that subscriptions generate, appear here.", canWrite("invoices") && tab === "all" ? button("Create invoice", "primary", { icon: "plus", onClick: () => navigate("#/invoices/new") }) : undefined),
  });
  listHost.append(list.element);
  // Counts for the tabs: one bounded index of the account's invoices.
  try {
    const index = await indexAll("invoices.list", customer ? { customer } : {});
    const counts = Object.fromEntries(INVOICE_TABS.map((entry) => [entry.key, 0]));
    for (const invoice of index.items) {
      counts.all += 1;
      const status = invoiceStatus(invoice, now()).key;
      if (status === "past_due") counts.open += 1;
      if (counts[status] !== undefined) counts[status] += 1;
    }
    tabsHost.replaceChildren(statTabs(INVOICE_TABS.map((entry) => ({ ...entry, count: `${counts[entry.key]}${index.complete ? "" : "+"}` })), tab, select_));
  } catch {
    /* the list itself already shows the error */
  }
});

// ---------------------------------------------------------------------------------------------
// Invoice page (draft editor / open / paid / void)
// ---------------------------------------------------------------------------------------------

registerPage("invoice", async (host, route) => {
  setTitle(route.id);
  const inner = pageInner();
  host.replaceChildren(inner);
  await load(inner, async () => {
    const invoice = await call("invoices.retrieve", { invoice: route.id, expand: ["customer", "default_payment_method", "payments.data.payment.payment_intent"] });
    return renderInvoice(invoice);
  }, { retry: () => navigate(location.hash) });
});

function renderInvoice(invoice) {
  const status = invoiceStatus(invoice, now());
  const customer = typeof invoice.customer === "object" && invoice.customer !== null ? invoice.customer : { id: invoice.customer, name: invoice.customer_name, email: invoice.customer_email };
  const payment = invoice.payments?.data?.[0];
  const intent = payment && typeof payment.payment.payment_intent === "object" ? payment.payment.payment_intent : undefined;
  const actions = [];
  const write = canWrite("invoices");
  if (invoice.status === "draft" && write) {
    actions.push(button("Add item", "secondary", { icon: "plus", onClick: () => openInvoiceItem(invoice, customer) }));
    actions.push(button("Finalize invoice", "primary", { onClick: () => finalize(invoice) }));
  }
  if (invoice.status === "open" && write) {
    actions.push(button("Charge customer", "primary", { onClick: () => openPay(invoice, customer) }));
  }
  const more = button(undefined, "secondary", { icon: "more", ariaLabel: "More actions", class: "btn-icon-only" });
  more.addEventListener("click", () =>
    openMenu(more, [
      { label: "Copy invoice ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(invoice.id).then(() => toast("Copied to clipboard")) },
      { label: "View customer", icon: "customers", onSelect: () => navigate(`#/customers/${customer.id}`) },
      ...(intent ? [{ label: "View payment", icon: "payments", onSelect: () => navigate(`#/payments/${intent.id}`) }] : []),
      "divider",
      { label: "Send invoice", icon: "external", disabled: true, description: "No e-mail is sent by this synthetic account" },
      { label: "Download PDF", icon: "receipt", disabled: true, description: "Not served" },
      ...(invoice.status === "open" && write ? [{ label: "Mark as paid out of band", icon: "check", onSelect: () => payOutOfBand(invoice) }, { label: "Void invoice", icon: "x-circle", danger: true, onSelect: () => voidInvoice(invoice) }] : []),
    ], { align: "end" }),
  );
  actions.push(more);

  const title = el("div", { class: "detail-title" }, [el("h1", { class: "page-title" }, moneyCell(invoice.total, invoice.currency)), statusBadge(status)]);
  const header = pageHeader(title, { kind: invoice.number ? `Invoice ${invoice.number}` : "Draft invoice", actions, breadcrumbs: [{ label: "Invoices", href: "#/invoices" }, { label: invoice.number ?? invoice.id }] });

  const meta = metaBar([
    ["Customer", link(`#/customers/${customer.id}`, customer.name || customer.email || customer.id)],
    ["Billing method", invoice.collection_method === "send_invoice" ? "Send invoice" : "Charge automatically"],
    invoice.due_date ? ["Due", dateOnly(invoice.due_date, now())] : undefined,
    ["Amount due", money(invoice.amount_due, invoice.currency)],
    ["Created", dateTime(invoice.created, now())],
  ]);

  const banners = [];
  if (invoice.status === "draft") banners.push(alert("Add items, then finalize the invoice to make it payable. Finalizing assigns the invoice number and creates its PaymentIntent.", "info", { title: "This invoice is a draft", iconName: "edit" }));
  if (status.key === "past_due") banners.push(alert(`This invoice was due ${dateOnly(invoice.due_date, now())} and is still unpaid; the customer is marked delinquent.`, "warning", { title: "Past due" }));
  if (invoice.status === "open" && invoice.attempt_count > 0) banners.push(alert(`${invoice.attempt_count} payment attempt${invoice.attempt_count === 1 ? "" : "s"} failed.${intent?.last_payment_error ? ` Last error: ${intent.last_payment_error.message}` : ""}`, "danger", { title: "Payment failed" }));

  const lines = invoice.lines?.data ?? [];
  const itemsTable = el("div", { class: "line-items" }, [
    table({
      columns: [
        { label: "Description", class: "truncate", render: (line) => el("span", { class: "customer-cell-text" }, [el("span", { text: line.description ?? "Item" }), el("span", { class: "customer-cell-sub", text: `${dateOnly(line.period.start, now())}${line.period.end !== line.period.start ? ` – ${dateOnly(line.period.end, now())}` : ""}` })]) },
        { label: "Qty", class: "num nowrap", render: (line) => String(line.quantity ?? 1) },
        { label: "Unit price", class: "num nowrap", render: (line) => money(line.pricing?.unit_amount_decimal !== undefined ? Number(line.pricing.unit_amount_decimal) : Math.round(line.amount / (line.quantity || 1)), line.currency) },
        { label: "Amount", class: "num nowrap", render: (line) => money(line.amount, line.currency) },
      ],
      rows: lines,
      stack: false,
      emptyNode: el("div", { class: "table-note", text: "No items yet." }),
    }),
    el("div", { class: "totals" }, [
      el("span", { class: "total-label", text: "Subtotal" }), el("span", { class: "money" }, text(money(invoice.subtotal, invoice.currency))),
      el("span", { class: "total-label", text: "Total" }), el("span", { class: "money" }, text(money(invoice.total, invoice.currency))),
      el("span", { class: "total-label total-strong", text: "Amount due" }), el("span", { class: "money total-strong" }, text(money(invoice.amount_due, invoice.currency))),
    ]),
  ]);
  const itemsSection = section("Items", itemsTable, { count: lines.length, actions: invoice.status === "draft" && write ? [button("Add item", "secondary", { size: "sm", icon: "plus", onClick: () => openInvoiceItem(invoice, customer) })] : [] });

  const summary = section("Summary", el("div", { class: "kv-cols" }, [
    kv([
      ["Billed to", el("span", {}, [text(customer.name ?? "—"), invoice.customer_email ? el("span", { class: "muted", text: ` · ${invoice.customer_email}` }) : null])],
      ["Billing address", addressText(invoice.customer_address)],
      ["Currency", invoice.currency.toUpperCase()],
      ["Billing reason", humanize(invoice.billing_reason)],
      ["Subscription", invoice.parent?.subscription_details?.subscription ? link(`#/subscriptions/${invoice.parent.subscription_details.subscription}`, invoice.parent.subscription_details.subscription) : null],
    ]),
    kv([
      ["Invoice number", invoice.number],
      ["ID", idChip(invoice.id)],
      ["Default payment method", typeof invoice.default_payment_method === "object" && invoice.default_payment_method !== null ? cardChip(invoice.default_payment_method) : null],
      ["Hosted invoice page", invoice.hosted_invoice_url ? el("span", { class: "muted", text: `${invoice.hosted_invoice_url} (synthetic, not served)` }) : null],
      ["Memo", invoice.description],
      ["Footer", invoice.footer],
    ]),
  ]));

  const paymentsSection = payment ? section("Payments", table({
    columns: [
      { label: "Amount", class: "nowrap", render: () => amountWithStatus(payment.amount_requested, payment.currency, badge(humanize(payment.status), payment.status === "paid" ? "green" : payment.status === "canceled" ? "gray" : "blue")) },
      { label: "PaymentIntent", render: () => (intent ? el("span", { class: "amount-status" }, [link(`#/payments/${intent.id}`, intent.id), statusBadge(intentStatus(intent, undefined))]) : el("code", { class: "id-code", text: payment.payment.payment_intent ?? "—" })) },
      { label: "Paid at", class: "nowrap muted", render: () => (payment.status_transitions?.paid_at ? dateTime(payment.status_transitions.paid_at, now()) : "—") },
    ],
    rows: [payment],
    href: intent ? () => `#/payments/${intent.id}` : undefined,
    onOpen: intent ? () => navigate(`#/payments/${intent.id}`) : undefined,
  })) : null;

  const events = [];
  const transitions = invoice.status_transitions ?? {};
  if (transitions.paid_at) events.push({ title: invoice.paid_out_of_band ? "Marked as paid out of band" : "Invoice paid", at: transitions.paid_at, tone: "green", icon: "check-circle" });
  if (transitions.voided_at) events.push({ title: "Invoice voided", at: transitions.voided_at, icon: "minus-circle" });
  if (transitions.marked_uncollectible_at) events.push({ title: "Marked uncollectible", at: transitions.marked_uncollectible_at, tone: "red", icon: "x-circle" });
  if (transitions.finalized_at) events.push({ title: "Invoice finalized", at: transitions.finalized_at, text: invoice.number ? `Number ${invoice.number} assigned` : undefined, tone: "blue", icon: "check-circle" });
  events.push({ title: "Invoice created", at: invoice.created, text: humanize(invoice.billing_reason), icon: "dot" });
  events.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  const historySection = section("History", timeline(events));

  return [header, meta, ...banners, itemsSection, summary, paymentsSection, historySection].filter(Boolean);
}

function openInvoiceItem(invoice, customer) {
  const mode = select([{ value: "price", label: "From the product catalog" }, { value: "adhoc", label: "One-off item" }], "price");
  const priceSelect = select([{ value: "", label: "Loading prices…" }], "");
  const quantity = input({ type: "number", value: "1", min: 1 });
  const amount = amountInput({ currency: invoice.currency, currencies: [invoice.currency] });
  amount.select.disabled = true;
  const description = input({ placeholder: "What the customer is being billed for" });
  const fields = { price: field("Price", priceSelect), quantity: field("Quantity", quantity), amount: field("Amount", amount), description: field("Description", description, { optional: true }) };
  const toggle = () => {
    fields.price.hidden = mode.value !== "price";
    fields.amount.hidden = mode.value !== "adhoc";
    fields.description.querySelector(".field-optional").hidden = mode.value === "adhoc";
  };
  mode.addEventListener("change", toggle);
  toggle();
  void (async () => {
    try {
      // Currency is filtered by the server and product names come expanded, so no second bounded index is needed.
      const index = await indexAll("prices.list", { active: true, type: "one_time", currency: invoice.currency, expand: ["data.product"] });
      const prices = index.items;
      priceSelect.replaceChildren(el("option", { text: prices.length === 0 ? `No active one-time ${invoice.currency.toUpperCase()} prices` : "Choose a price", attrs: { value: "" } }));
      for (const price of prices) {
        const product = typeof price.product === "object" && price.product !== null ? price.product : undefined;
        priceSelect.append(el("option", { text: `${product?.name ?? price.product} — ${priceLabel(price)}${price.nickname ? ` (${price.nickname})` : ""}`, attrs: { value: price.id } }));
      }
      if (!index.complete) priceSelect.append(el("option", { text: `Showing the first ${prices.length.toLocaleString("en-US")} prices; more exist (use a one-off item or the product page)`, attrs: { value: "", disabled: "" } }));
    } catch (error) {
      priceSelect.replaceChildren(el("option", { text: "Could not load prices", attrs: { value: "" } }));
      fields.price.setError(error.message);
    }
  })();
  const idempotencyKey = key();
  openModal({
    title: "Add an item",
    body: [field("Item type", mode), fields.price, fields.amount, fields.quantity, fields.description],
    actions: [
      { label: "Cancel" },
      {
        label: "Add item",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          const args = { customer: customer.id, invoice: invoice.id, quantity: Number(quantity.value || 1) };
          if (mode.value === "price") {
            if (!priceSelect.value) {
              fields.price.setError("Choose a price.");
              return;
            }
            args.price = priceSelect.value;
          } else {
            const minor = amount.amount();
            if (minor === undefined) {
              fields.amount.setError("Enter a valid amount.");
              return;
            }
            args.amount = minor;
            args.currency = invoice.currency;
            if (!description.value.trim()) {
              fields.description.setError("Describe the item.");
              return;
            }
          }
          if (description.value.trim()) args.description = description.value.trim();
          return submitModal(api, fields, () => call("invoice_items.create", args, idempotencyKey), () => {
            toast("Item added");
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

async function finalize(invoice) {
  const ok = await confirmDialog("Finalize invoice?", `The invoice becomes payable for ${money(invoice.total, invoice.currency)} and can no longer be edited.`, "Finalize");
  if (!ok) return;
  await action(async () => {
    const finalized = await call("invoices.finalize", { invoice: invoice.id }, key());
    toast(`Invoice ${finalized.number} finalized`);
    invalidateCache();
    navigate(location.hash);
  });
}

function openPay(invoice, customer) {
  const picker = methodPicker({ customer: customer.id, value: invoice.default_payment_method?.id ?? customer.invoice_settings?.default_payment_method ?? "" });
  void picker.setCustomer(customer.id, customer.invoice_settings?.default_payment_method);
  const fields = { payment_method: field("Payment method", picker) };
  const idempotencyKey = key();
  openModal({
    title: "Charge customer",
    describedBy: `Collect ${money(invoice.amount_due, invoice.currency)} now with one of the customer's cards or a test card.`,
    body: [fields.payment_method],
    actions: [
      { label: "Cancel" },
      {
        label: `Charge ${money(invoice.amount_due, invoice.currency)}`,
        kind: "primary",
        submit: true,
        onClick: (api) => {
          if (!picker.value) {
            fields.payment_method.setError("Choose a payment method.");
            return;
          }
          return submitModal(api, fields, () => call("invoices.pay", { invoice: invoice.id, payment_method: picker.value }, idempotencyKey), () => {
            toast("Invoice paid");
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

async function payOutOfBand(invoice) {
  const ok = await confirmDialog("Mark as paid out of band?", "The invoice is marked paid without collecting a payment (for example a bank transfer received elsewhere).", "Mark as paid");
  if (!ok) return;
  await action(async () => {
    await call("invoices.pay", { invoice: invoice.id, paid_out_of_band: true }, key());
    toast("Invoice marked as paid");
    invalidateCache();
    navigate(location.hash);
  });
}

async function voidInvoice(invoice) {
  const ok = await confirmDialog("Void invoice?", "Voiding cancels the invoice and its payment; it cannot be undone.", "Void invoice", { danger: true });
  if (!ok) return;
  await action(async () => {
    await call("invoices.void", { invoice: invoice.id }, key());
    toast("Invoice voided");
    invalidateCache();
    navigate(location.hash);
  });
}

// ---------------------------------------------------------------------------------------------
// Create invoice
// ---------------------------------------------------------------------------------------------

registerPage("invoice-new", async (host, route) => {
  setTitle("Create an invoice");
  if (!canWrite("invoices")) {
    host.replaceChildren(pageInner(pageHeader("Create an invoice", { breadcrumbs: [{ label: "Invoices", href: "#/invoices" }] }), deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "invoices", level: "write" }), "invoices")));
    return;
  }
  app.editing += 1;
  const customer = customerPicker({ value: route.params.customer });
  const collection = select([{ value: "charge_automatically", label: "Charge a payment method on file" }, { value: "send_invoice", label: "Send invoice — customer pays by the due date" }], "charge_automatically");
  const days = input({ type: "number", value: "30", min: 1, max: 730 });
  const currency = select(["usd", "eur", "gbp", "cad", "aud", "chf", "sek", "nok", "dkk", "jpy", "nzd", "sgd"].map((code) => ({ value: code, label: code.toUpperCase() })), app.context?.account?.default_currency ?? "usd");
  const memo = textarea({ placeholder: "Thanks for your business", rows: 2 });
  const pendingItems = el("input", { attrs: { type: "checkbox" } });
  pendingItems.checked = true;
  const fields = {
    customer: field("Customer", el("div", { class: "inline-list" }, [customer, canWrite("customers") ? button("Add new customer", "link", { onClick: () => openCustomerForm(undefined, (record) => { customer.value = record.id; customer.customer = record; customer.control.value = record.name || record.email || record.id; }) }) : null])),
    collection_method: field("Collection method", collection),
    days_until_due: field("Days until due", days),
    currency: field("Currency", currency),
    description: field("Memo", memo, { optional: true }),
  };
  const toggle = () => {
    fields.days_until_due.hidden = collection.value !== "send_invoice";
  };
  collection.addEventListener("change", toggle);
  toggle();
  const errorHost = el("div", { class: "form-error", attrs: { role: "alert" } });
  errorHost.hidden = true;
  const api = { setError: (message) => { errorHost.textContent = message ?? ""; errorHost.hidden = !message; } };
  let idempotencyKey = key();
  const submit = button("Create draft invoice", "primary", {
    onClick: () =>
      action(async () => {
        for (const entry of Object.values(fields)) entry.setError(undefined);
        errorHost.hidden = true;
        if (!customer.value) {
          fields.customer.setError("Choose a customer.");
          return;
        }
        const args = { customer: customer.value, collection_method: collection.value, currency: currency.value, pending_invoice_items_behavior: pendingItems.checked ? "include" : "exclude" };
        if (collection.value === "send_invoice") args.days_until_due = Number(days.value || 30);
        if (memo.value.trim()) args.description = memo.value.trim();
        submit.classList.add("is-busy");
        submit.disabled = true;
        try {
          const invoice = await call("invoices.create", args, idempotencyKey);
          toast("Draft invoice created — add items, then finalize");
          invalidateCache();
          app.editing -= 1;
          navigate(`#/invoices/${invoice.id}`);
        } catch (error) {
          idempotencyKey = key();
          applyError(error, fields, api);
        } finally {
          submit.classList.remove("is-busy");
          submit.disabled = false;
        }
      }),
  });
  const form = el("div", { class: "editor-form" }, [
    fields.customer,
    fields.collection_method,
    fields.days_until_due,
    fields.currency,
    el("label", { class: "check-field" }, [pendingItems, el("span", { class: "check-label", text: "Include the customer's pending invoice items" }, [el("span", { class: "check-hint", text: "Invoice items created without an invoice are swept into this draft." })])]),
    fields.description,
    errorHost,
    el("div", { class: "sticky-footer" }, [button("Cancel", "secondary", { onClick: () => { app.editing -= 1; navigate("#/invoices"); } }), submit]),
  ]);
  const summary = el("div", { class: "editor-summary" }, [el("div", { class: "editor-summary-title", text: "How invoicing works here" }), el("div", { class: "muted", text: "The invoice starts as a draft. Add items from the catalog or one-off amounts, then finalize it. Finalizing assigns a number and a PaymentIntent; you can then charge a card, void it, or mark it paid out of band. No e-mail or PDF is produced." })]);
  host.replaceChildren(pageInner(pageHeader("Create an invoice", { breadcrumbs: [{ label: "Invoices", href: "#/invoices" }, { label: "Create" }] }), el("div", { class: "editor" }, [form, summary])));
  host.addEventListener("page-leave", () => { app.editing = Math.max(0, app.editing - 1); }, { once: true });
});

// ---------------------------------------------------------------------------------------------
// Subscriptions list
// ---------------------------------------------------------------------------------------------

const SUBSCRIPTION_TABS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "trialing", label: "Trialing" },
  { key: "past_due", label: "Past due" },
  { key: "incomplete", label: "Incomplete" },
  { key: "canceled", label: "Canceled" },
];

function subscriptionRows(subscriptions) {
  return table({
    select: { label: "subscriptions", rowLabel: (subscription) => `subscription ${subscription.id}` },
    columns: [
      { label: "Customer", class: "truncate", render: (subscription) => customerCell(subscription.customer) },
      { label: "Status", class: "nowrap", render: (subscription) => statusBadge(subscriptionStatus(subscription, now())) },
      { label: "Product", class: "truncate", render: (subscription) => subscription.items.data.map((item) => `${item.price.nickname ?? item.price.id}${item.quantity > 1 ? ` × ${item.quantity}` : ""}`).join(", ") },
      { label: "Amount", class: "nowrap", render: (subscription) => subscriptionAmount(subscription) },
      { label: "Current period", class: "nowrap muted", render: (subscription) => `${dateOnly(subscription.items.data[0]?.current_period_start, now())} – ${dateOnly(subscription.items.data[0]?.current_period_end, now())}` },
      { label: "Created", class: "nowrap", render: (subscription) => dateCell(subscription.created) },
      { label: "", class: "actions", render: (subscription) => subscriptionMenu(subscription) },
    ],
    rows: subscriptions,
    href: (subscription) => `#/subscriptions/${subscription.id}`,
    onOpen: (subscription) => navigate(`#/subscriptions/${subscription.id}`),
  });
}

function subscriptionMenu(subscription) {
  const trigger = button(undefined, "ghost", { icon: "more", size: "sm", ariaLabel: `Actions for ${subscription.id}`, class: "btn-icon-only" });
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(trigger, [
      { label: "View subscription", icon: "external", onSelect: () => navigate(`#/subscriptions/${subscription.id}`) },
      { label: "View customer", icon: "customers", onSelect: () => navigate(`#/customers/${typeof subscription.customer === "object" ? subscription.customer.id : subscription.customer}`) },
      ...(subscription.latest_invoice ? [{ label: "View latest invoice", icon: "invoices", onSelect: () => navigate(`#/invoices/${typeof subscription.latest_invoice === "object" ? subscription.latest_invoice.id : subscription.latest_invoice}`) }] : []),
      ...(canWrite("subscriptions") && subscription.status !== "canceled" ? ["divider", { label: "Cancel subscription", icon: "x-circle", danger: true, onSelect: () => openCancel(subscription) }] : []),
    ], { align: "end" });
  });
  return trigger;
}

registerPage("subscriptions", async (host, route) => {
  setTitle("Subscriptions");
  const tab = route.params.tab ?? "all";
  const actions = [];
  if (canWrite("subscriptions")) actions.push(button("Create subscription", "primary", { icon: "plus", onClick: () => navigate("#/subscriptions/new") }));
  const header = pageHeader("Subscriptions", { actions });
  const tabsHost = el("div");
  const filters = el("div", { class: "filters" }, [chip("Customer", { onClick: () => notSimulated("Customer filter") }), chip("Product", { onClick: () => notSimulated("Product filter") }), chip("Created date", { onClick: () => notSimulated("Created date filter") }), chip("More filters", { onClick: () => notSimulated("More filters") }), listTools()]);
  const listHost = el("div");
  host.replaceChildren(pageInner(header, tabsHost, filters, listHost));
  if (!canRead("subscriptions")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "subscriptions" }), "subscriptions"));
    return;
  }
  const select_ = (next) => navigate(routeHash("subscriptions", undefined, { tab: next === "all" ? undefined : next }));
  tabsHost.append(statTabs(SUBSCRIPTION_TABS, tab, select_));
  const args = { expand: ["data.customer"], status: tab === "all" ? "all" : tab };
  const list = pagedList({
    operation: "subscriptions.list",
    args,
    limit: 20,
    render: subscriptionRows,
    emptyNode: () => empty(tab === "all" ? "No subscriptions yet" : `No ${SUBSCRIPTION_TABS.find((entry) => entry.key === tab)?.label.toLowerCase()} subscriptions`, "Subscriptions bill a customer for recurring prices.", canWrite("subscriptions") && tab === "all" ? button("Create subscription", "primary", { icon: "plus", onClick: () => navigate("#/subscriptions/new") }) : undefined),
  });
  listHost.append(list.element);
  try {
    const index = await indexAll("subscriptions.list", { status: "all" });
    const counts = Object.fromEntries(SUBSCRIPTION_TABS.map((entry) => [entry.key, 0]));
    for (const subscription of index.items) {
      counts.all += 1;
      if (counts[subscription.status] !== undefined) counts[subscription.status] += 1;
    }
    tabsHost.replaceChildren(statTabs(SUBSCRIPTION_TABS.map((entry) => ({ ...entry, count: `${counts[entry.key]}${index.complete ? "" : "+"}` })), tab, select_));
  } catch {
    /* list shows the error */
  }
});

// ---------------------------------------------------------------------------------------------
// Subscription detail
// ---------------------------------------------------------------------------------------------

registerPage("subscription", async (host, route) => {
  setTitle(route.id);
  const inner = pageInner();
  host.replaceChildren(inner);
  await load(inner, async () => {
    const subscription = await call("subscriptions.retrieve", { subscription: route.id, expand: ["customer", "latest_invoice", "default_payment_method"] });
    return renderSubscription(subscription);
  }, { retry: () => navigate(location.hash) });
});

function renderSubscription(subscription) {
  const status = subscriptionStatus(subscription, now());
  const customer = typeof subscription.customer === "object" && subscription.customer !== null ? subscription.customer : { id: subscription.customer };
  const latest = typeof subscription.latest_invoice === "object" && subscription.latest_invoice !== null ? subscription.latest_invoice : undefined;
  const write = canWrite("subscriptions");
  const active = subscription.status !== "canceled" && subscription.status !== "incomplete_expired";
  const actions = [];
  if (write && active) {
    if (subscription.cancel_at_period_end) actions.push(button("Resume subscription", "primary", { onClick: () => resume(subscription) }));
    actions.push(button("Update subscription", "secondary", { icon: "edit", onClick: () => openUpdate(subscription) }));
    if (!subscription.cancel_at_period_end) actions.push(button("Cancel subscription", "secondary", { onClick: () => openCancel(subscription) }));
  }
  const more = button(undefined, "secondary", { icon: "more", ariaLabel: "More actions", class: "btn-icon-only" });
  more.addEventListener("click", () =>
    openMenu(more, [
      { label: "Copy subscription ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(subscription.id).then(() => toast("Copied to clipboard")) },
      { label: "View customer", icon: "customers", onSelect: () => navigate(`#/customers/${customer.id}`) },
      ...(latest ? [{ label: "View latest invoice", icon: "invoices", onSelect: () => navigate(`#/invoices/${latest.id}`) }] : []),
      ...(write && subscription.status === "trialing" ? ["divider", { label: "End trial now", icon: "check", onSelect: () => endTrial(subscription) }] : []),
      ...(write && subscription.cancel_at_period_end ? ["divider", { label: "Cancel immediately instead", icon: "x-circle", danger: true, onSelect: () => cancelNow(subscription) }] : []),
    ], { align: "end" }),
  );
  actions.push(more);
  const names = subscription.items.data.map((item) => item.price.nickname ?? item.price.id).join(" + ");
  const title = el("div", { class: "detail-title" }, [el("div", {}, [el("h1", { class: "page-title", text: customer.name || customer.email || customer.id }), el("div", { class: "page-subtitle", text: names })]), statusBadge(status)]);
  const header = pageHeader(title, { kind: "Subscription", actions, breadcrumbs: [{ label: "Subscriptions", href: "#/subscriptions" }, { label: subscription.id }] });
  const period = subscription.items.data[0];
  const meta = metaBar([
    ["Started", dateTime(subscription.start_date, now())],
    ["Current period", `${dateOnly(period?.current_period_start, now())} – ${dateOnly(period?.current_period_end, now())}`],
    subscription.trial_end && subscription.status === "trialing" ? ["Trial ends", dateOnly(subscription.trial_end, now())] : ["Next invoice", active && !subscription.cancel_at_period_end ? el("span", {}, [text(dateOnly(period?.current_period_end, now())), el("span", { class: "muted", text: " · not generated by this synthetic account" })]) : el("span", { class: "muted", text: "None" })],
    ["Billing method", subscription.collection_method === "send_invoice" ? `Send invoice (${subscription.days_until_due} days)` : typeof subscription.default_payment_method === "object" && subscription.default_payment_method !== null ? cardChip(subscription.default_payment_method) : "Customer's default payment method"],
  ]);
  const banners = [];
  if (subscription.status === "incomplete") banners.push(alert(el("span", {}, [text("The first invoice has not been paid. "), latest ? link(`#/invoices/${latest.id}`, "Pay the invoice") : null, text(" to activate the subscription, or cancel it.")]), "warning", { title: "Payment required" }));
  if (subscription.status === "past_due") banners.push(alert("The latest invoice is unpaid. Collect payment on the invoice to keep the subscription active.", "warning", { title: "Past due" }));
  if (subscription.cancel_at_period_end) banners.push(alert(`This subscription cancels on ${dateOnly(subscription.cancel_at, now())}. Resume it to keep billing.`, "neutral", { title: "Scheduled to cancel", iconName: "clock" }));
  if (subscription.status === "canceled") banners.push(alert(`Canceled ${dateTime(subscription.canceled_at ?? subscription.ended_at, now())}${subscription.cancellation_details?.comment ? ` — ${subscription.cancellation_details.comment}` : ""}.`, "neutral", { title: "This subscription is canceled", iconName: "minus-circle" }));

  const pricing = section("Pricing", el("div", { class: "line-items" }, [
    table({
      columns: [
        { label: "Product", render: (item) => el("span", { class: "customer-cell-text" }, [el("span", { text: item.price.nickname ?? item.price.id }), el("span", { class: "customer-cell-sub", text: item.price.product })]) },
        { label: "Qty", class: "num nowrap", render: (item) => String(item.quantity) },
        { label: "Unit price", class: "num nowrap", render: (item) => priceLabel(item.price) },
        { label: "Amount", class: "num nowrap", render: (item) => money(item.price.unit_amount * item.quantity, item.price.currency) },
      ],
      rows: subscription.items.data,
      stack: false,
    }),
    el("div", { class: "totals" }, [el("span", { class: "total-label total-strong", text: "Total per period" }), el("span", { class: "money total-strong" }, subscriptionAmount(subscription))]),
  ]), { actions: write && active ? [button("Update items", "secondary", { size: "sm", icon: "edit", onClick: () => openUpdate(subscription) })] : [] });

  const details = section("Subscription details", el("div", { class: "kv-cols" }, [
    kv([
      ["ID", idChip(subscription.id)],
      ["Customer", link(`#/customers/${customer.id}`, customer.name || customer.email || customer.id)],
      ["Created", dateTime(subscription.created, now())],
      ["Billing cycle anchor", dateTime(subscription.billing_cycle_anchor, now())],
      ["Description", subscription.description],
    ]),
    kv([
      ["Latest invoice", latest ? el("span", { class: "amount-status" }, [link(`#/invoices/${latest.id}`, latest.number ?? latest.id), statusBadge(invoiceStatus(latest, now()))]) : subscription.latest_invoice ? link(`#/invoices/${subscription.latest_invoice}`, subscription.latest_invoice) : null],
      ["Trial", subscription.trial_start ? `${dateOnly(subscription.trial_start, now())} – ${dateOnly(subscription.trial_end, now())}` : "No trial"],
      ["Cancel at", subscription.cancel_at ? dateTime(subscription.cancel_at, now()) : null],
      ["Cancellation reason", subscription.cancellation_details?.reason ? humanize(subscription.cancellation_details.reason) : null],
      ["Collection method", humanize(subscription.collection_method)],
    ]),
  ]));

  // Every invoice of the subscription, 20 per page with Previous/Next (cursor pagination, never one capped call).
  const invoicesBody = !canRead("invoices") ? el("p", { class: "muted", text: "This key cannot read invoices." }) : pagedList({ operation: "invoices.list", args: { subscription: subscription.id }, limit: 20, emptyNode: () => el("p", { class: "muted", text: "No invoices for this subscription." }), render: (invoices) => table({
    columns: [
      { label: "Amount", class: "nowrap", render: (invoice) => amountWithStatus(invoice.total, invoice.currency, statusBadge(invoiceStatus(invoice, now()))) },
      { label: "Invoice number", render: (invoice) => invoice.number ?? el("span", { class: "muted", text: "Draft" }) },
      { label: "Billing reason", render: (invoice) => humanize(invoice.billing_reason) },
      { label: "Created", class: "nowrap", render: (invoice) => dateCell(invoice.created) },
    ],
    rows: invoices,
    href: (invoice) => `#/invoices/${invoice.id}`,
    onOpen: (invoice) => navigate(`#/invoices/${invoice.id}`),
  }) }).element;
  const invoicesSection = section("Invoices", invoicesBody);

  const metadataRows = Object.entries(subscription.metadata ?? {});
  const metadataSection = section("Metadata", metadataRows.length > 0 ? kv(metadataRows) : el("p", { class: "muted", text: "No metadata" }));
  return [header, meta, ...banners, pricing, details, invoicesSection, metadataSection];
}

async function resume(subscription) {
  await action(async () => {
    await call("subscriptions.update", { subscription: subscription.id, cancel_at_period_end: false }, key());
    toast("Subscription resumed");
    invalidateCache();
    navigate(location.hash);
  });
}

async function endTrial(subscription) {
  const ok = await confirmDialog("End trial now?", "The subscription becomes active immediately. This synthetic account does not generate the first paid invoice at that point.", "End trial");
  if (!ok) return;
  await action(async () => {
    await call("subscriptions.update", { subscription: subscription.id, trial_end: "now" }, key());
    toast("Trial ended");
    invalidateCache();
    navigate(location.hash);
  });
}

async function cancelNow(subscription) {
  const ok = await confirmDialog("Cancel immediately?", "The subscription ends now; an open first invoice is voided.", "Cancel subscription", { danger: true });
  if (!ok) return;
  await action(async () => {
    await call("subscriptions.cancel", { subscription: subscription.id }, key());
    toast("Subscription canceled");
    invalidateCache();
    navigate(location.hash);
  });
}

function openCancel(subscription) {
  const when = el("div", { class: "radio-group" });
  const nowRadio = el("input", { attrs: { type: "radio", name: "when", value: "now" } });
  const endRadio = el("input", { attrs: { type: "radio", name: "when", value: "period_end" } });
  endRadio.checked = true;
  when.append(
    el("label", { class: "radio-field" }, [endRadio, el("span", { class: "radio-labels" }, [el("span", { class: "radio-label", text: "At the end of the current period" }), el("span", { class: "radio-description", text: `The customer keeps access until ${dateOnly(subscription.items.data[0]?.current_period_end, now())}.` })])]),
    el("label", { class: "radio-field" }, [nowRadio, el("span", { class: "radio-labels" }, [el("span", { class: "radio-label", text: "Immediately" }), el("span", { class: "radio-description", text: "Access ends now. An unpaid first invoice is voided." })])]),
  );
  const feedback = select([{ value: "", label: "Select feedback" }, { value: "too_expensive", label: "Too expensive" }, { value: "missing_features", label: "Missing features" }, { value: "switched_service", label: "Switched service" }, { value: "unused", label: "Unused" }, { value: "customer_service", label: "Customer service" }, { value: "too_complex", label: "Too complex" }, { value: "low_quality", label: "Low quality" }, { value: "other", label: "Other" }], "");
  const comment = textarea({ placeholder: "Internal note", rows: 2 });
  const fields = { when: field("Cancel", when), cancellation_details: field("Cancellation feedback", el("div", { class: "inline-list" }, [feedback, comment]), { optional: true }) };
  const idempotencyKey = key();
  openModal({
    title: "Cancel subscription",
    body: [fields.when, fields.cancellation_details],
    actions: [
      { label: "Keep subscription" },
      {
        label: "Cancel subscription",
        kind: "danger",
        submit: true,
        onClick: (api) =>
          submitModal(api, fields, async () => {
            const details = feedback.value || comment.value.trim() ? { cancellation_details: { ...(feedback.value ? { feedback: feedback.value } : {}), ...(comment.value.trim() ? { comment: comment.value.trim() } : {}) } } : {};
            if (nowRadio.checked) {
              if (details.cancellation_details) await call("subscriptions.update", { subscription: subscription.id, ...details }, key());
              return call("subscriptions.cancel", { subscription: subscription.id }, idempotencyKey);
            }
            return call("subscriptions.update", { subscription: subscription.id, cancel_at_period_end: true, ...details }, idempotencyKey);
          }, () => {
            toast(nowRadio.checked ? "Subscription canceled" : "Subscription will cancel at period end");
            invalidateCache();
            navigate(location.hash);
          }),
      },
    ],
  });
}

/** Update items (quantity / price / remove / add) and description. */
function openUpdate(subscription) {
  const rowsHost = el("div", { class: "inline-list" });
  const rows = subscription.items.data.map((item) => ({ id: item.id, price: item.price.id, quantity: item.quantity, label: `${item.price.nickname ?? item.price.id} — ${priceLabel(item.price)}`, deleted: false }));
  const added = [];
  let priceOptions = [];
  function draw() {
    rowsHost.replaceChildren();
    for (const row of rows) {
      if (row.deleted) continue;
      const quantity = input({ type: "number", value: String(row.quantity), min: 1 });
      quantity.setAttribute("aria-label", "Quantity");
      quantity.addEventListener("input", () => { row.quantity = Number(quantity.value || 1); });
      const remove = button(undefined, "ghost", { icon: "trash", ariaLabel: "Remove item", class: "btn-icon-only", onClick: () => { row.deleted = true; draw(); } });
      rowsHost.append(el("div", { class: "item-row" }, [el("span", { class: "truncate", text: row.label }), quantity, remove]));
    }
    for (const row of added) {
      const priceSelect = select([{ value: "", label: "Choose a recurring price" }, ...priceOptions], row.price);
      priceSelect.setAttribute("aria-label", "Recurring price");
      priceSelect.addEventListener("change", () => { row.price = priceSelect.value; });
      const quantity = input({ type: "number", value: String(row.quantity), min: 1 });
      quantity.setAttribute("aria-label", "Quantity");
      quantity.addEventListener("input", () => { row.quantity = Number(quantity.value || 1); });
      const remove = button(undefined, "ghost", { icon: "trash", ariaLabel: "Remove item", class: "btn-icon-only", onClick: () => { added.splice(added.indexOf(row), 1); draw(); } });
      rowsHost.append(el("div", { class: "item-row" }, [priceSelect, quantity, remove]));
    }
  }
  draw();
  void loadRecurringPrices(subscription.currency).then((options) => { priceOptions = options; draw(); });
  const description = input({ value: subscription.description ?? "", placeholder: "Shown on invoices" });
  const fields = { items: field("Items", el("div", { class: "inline-list" }, [rowsHost, button("Add a product", "link", { icon: "plus", onClick: () => { added.push({ price: "", quantity: 1 }); draw(); } })])), description: field("Description", description, { optional: true }) };
  const idempotencyKey = key();
  openModal({
    title: "Update subscription",
    describedBy: "Changes apply to the current period. This synthetic account does not create proration invoice items.",
    body: [fields.items, fields.description],
    actions: [
      { label: "Cancel" },
      {
        label: "Update subscription",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          const items = [];
          for (const row of rows) {
            if (row.deleted) items.push({ id: row.id, deleted: true });
            else items.push({ id: row.id, quantity: row.quantity });
          }
          for (const row of added) {
            if (!row.price) {
              fields.items.setError("Choose a price for every added item.");
              return;
            }
            items.push({ price: row.price, quantity: row.quantity });
          }
          return submitModal(api, fields, () => call("subscriptions.update", { subscription: subscription.id, items, proration_behavior: "none", description: description.value.trim() || "" }, idempotencyKey), () => {
            toast("Subscription updated");
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

async function loadRecurringPrices(currency) {
  try {
    const index = await indexAll("prices.list", { active: true, type: "recurring", expand: ["data.product"], ...(currency === undefined ? {} : { currency }) });
    const options = index.items.map((price) => {
      const product = typeof price.product === "object" && price.product !== null ? price.product : undefined;
      return { value: price.id, label: `${product?.name ?? price.product} — ${priceLabel(price)}${price.nickname ? ` (${price.nickname})` : ""}`, price: { ...price, product: product?.id ?? price.product } };
    });
    // A bounded index never truncates silently: the last option says the list stops here.
    if (!index.complete) options.push({ value: "", label: `Showing the first ${options.length.toLocaleString("en-US")} recurring prices; more exist`, disabled: true });
    return options;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Create subscription
// ---------------------------------------------------------------------------------------------

registerPage("subscription-new", async (host, route) => {
  setTitle("Create a subscription");
  if (!canWrite("subscriptions")) {
    host.replaceChildren(pageInner(pageHeader("Create a subscription", { breadcrumbs: [{ label: "Subscriptions", href: "#/subscriptions" }] }), deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "subscriptions", level: "write" }), "subscriptions")));
    return;
  }
  app.editing += 1;
  const customer = customerPicker({ value: route.params.customer, onChange: (record) => void picker.setCustomer(record?.id, record?.invoice_settings?.default_payment_method) });
  const items = [{ price: route.params.price ?? "", quantity: 1 }];
  let priceOptions = [];
  const rowsHost = el("div", { class: "inline-list" });
  const summaryLines = el("div");
  function draw() {
    rowsHost.replaceChildren();
    for (const row of items) {
      const priceSelect = select([{ value: "", label: priceOptions.length === 0 ? "Loading prices…" : "Choose a recurring price" }, ...priceOptions], row.price);
      priceSelect.setAttribute("aria-label", "Recurring price");
      priceSelect.addEventListener("change", () => { row.price = priceSelect.value; drawSummary(); });
      const quantity = input({ type: "number", value: String(row.quantity), min: 1 });
      quantity.setAttribute("aria-label", "Quantity");
      quantity.addEventListener("input", () => { row.quantity = Number(quantity.value || 1); drawSummary(); });
      const remove = button(undefined, "ghost", { icon: "trash", ariaLabel: "Remove item", class: "btn-icon-only", disabled: items.length === 1, onClick: () => { items.splice(items.indexOf(row), 1); draw(); } });
      rowsHost.append(el("div", { class: "item-row" }, [priceSelect, quantity, remove]));
    }
    drawSummary();
  }
  function drawSummary() {
    summaryLines.replaceChildren();
    let total = 0;
    let currency;
    for (const row of items) {
      const option = priceOptions.find((entry) => entry.value === row.price && entry.price);
      if (!option) continue;
      currency = option.price.currency;
      total += option.price.unit_amount * row.quantity;
      summaryLines.append(el("div", { class: "balance-row" }, [el("span", { text: `${option.price.nickname ?? option.price.id} × ${row.quantity}` }), el("span", { text: money(option.price.unit_amount * row.quantity, option.price.currency) })]));
    }
    if (currency) summaryLines.append(el("div", { class: "balance-row" }, [el("strong", { text: "Total per period" }), el("strong", { text: money(total, currency) })]));
    else summaryLines.append(el("div", { class: "muted", text: "Choose a price to see the total." }));
  }
  draw();
  void loadRecurringPrices(undefined).then((options) => { priceOptions = options; draw(); });
  const picker = methodPicker({ customer: route.params.customer, allowNone: true, noneLabel: "Use the customer's default payment method" });
  const trialDays = input({ type: "number", placeholder: "0", min: 1, max: 730 });
  const collection = select([{ value: "charge_automatically", label: "Charge automatically" }, { value: "send_invoice", label: "Send invoice" }], "charge_automatically");
  const days = input({ type: "number", value: "30", min: 1, max: 730 });
  const behavior = select([{ value: "default_incomplete", label: "Default incomplete — keep the subscription if the first payment fails" }, { value: "error_if_incomplete", label: "Error if incomplete — fail the request on a decline" }], "default_incomplete");
  const description = input({ placeholder: "Shown on invoices" });
  const fields = {
    customer: field("Customer", el("div", { class: "inline-list" }, [customer, canWrite("customers") ? button("Add new customer", "link", { onClick: () => openCustomerForm(undefined, (record) => { customer.value = record.id; customer.customer = record; customer.control.value = record.name || record.email || record.id; void picker.setCustomer(record.id); }) }) : null])),
    items: field("Pricing", el("div", { class: "inline-list" }, [rowsHost, button("Add another product", "link", { icon: "plus", onClick: () => { items.push({ price: "", quantity: 1 }); draw(); } })])),
    trial_period_days: field("Free trial days", trialDays, { optional: true }),
    collection_method: field("Collection method", collection),
    days_until_due: field("Days until due", days),
    default_payment_method: field("Payment method", picker),
    payment_behavior: field("Payment behaviour", behavior),
    description: field("Description", description, { optional: true }),
  };
  const toggle = () => {
    fields.days_until_due.hidden = collection.value !== "send_invoice";
    fields.default_payment_method.hidden = collection.value === "send_invoice";
  };
  collection.addEventListener("change", toggle);
  toggle();
  const errorHost = el("div", { class: "form-error", attrs: { role: "alert" } });
  errorHost.hidden = true;
  const api = { setError: (message) => { errorHost.textContent = message ?? ""; errorHost.hidden = !message; } };
  let idempotencyKey = key();
  const attachedTestCards = new Map();
  const submit = button("Create subscription", "primary", {
    onClick: () =>
      action(async () => {
        for (const entry of Object.values(fields)) entry.setError(undefined);
        errorHost.hidden = true;
        if (!customer.value) {
          fields.customer.setError("Choose a customer.");
          return;
        }
        if (items.some((row) => !row.price)) {
          fields.items.setError("Choose a price for every item.");
          return;
        }
        const args = { customer: customer.value, items: items.map((row) => ({ price: row.price, quantity: row.quantity })), collection_method: collection.value, payment_behavior: behavior.value };
        if (collection.value === "send_invoice") args.days_until_due = Number(days.value || 30);
        else if (picker.value) {
          if (picker.value.startsWith("pm_card_")) {
            const cacheKey = `${customer.value}:${picker.value}`;
            if (!attachedTestCards.has(cacheKey)) attachedTestCards.set(cacheKey, (await call("payment_methods.attach", { payment_method: picker.value, customer: customer.value }, key())).id);
            args.default_payment_method = attachedTestCards.get(cacheKey);
          } else args.default_payment_method = picker.value;
        }
        if (trialDays.value) args.trial_period_days = Number(trialDays.value);
        if (description.value.trim()) args.description = description.value.trim();
        submit.classList.add("is-busy");
        submit.disabled = true;
        try {
          const subscription = await call("subscriptions.create", args, idempotencyKey);
          toast(subscription.status === "incomplete" ? "Subscription created — the first payment is pending" : `Subscription ${subscription.status}`);
          invalidateCache();
          app.editing -= 1;
          navigate(`#/subscriptions/${subscription.id}`);
        } catch (error) {
          idempotencyKey = key();
          if (error instanceof ToolError && error.is("CARD_DECLINED")) api.setError(`Card declined: ${error.message} (${humanize(error.details.decline_code ?? "generic_decline")}). Nothing was created; choose another card or use the default-incomplete behaviour.`);
          else applyError(error, fields, api);
        } finally {
          submit.classList.remove("is-busy");
          submit.disabled = false;
        }
      }),
  });
  const form = el("div", { class: "editor-form" }, [fields.customer, fields.items, fields.trial_period_days, fields.collection_method, fields.days_until_due, fields.default_payment_method, fields.payment_behavior, fields.description, errorHost, el("div", { class: "sticky-footer" }, [button("Cancel", "secondary", { onClick: () => { app.editing -= 1; navigate("#/subscriptions"); } }), submit])]);
  const summary = el("div", { class: "editor-summary" }, [el("div", { class: "editor-summary-title", text: "Summary" }), summaryLines, el("div", { class: "muted", text: "The first invoice is created and, when charging automatically, paid in the same request." })]);
  host.replaceChildren(pageInner(pageHeader("Create a subscription", { breadcrumbs: [{ label: "Subscriptions", href: "#/subscriptions" }, { label: "Create" }] }), el("div", { class: "editor" }, [form, summary])));
  if (route.params.customer) void picker.setCustomer(route.params.customer);
  host.addEventListener("page-leave", () => { app.editing = Math.max(0, app.editing - 1); }, { once: true });
});

