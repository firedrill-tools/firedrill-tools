// Payments list, payment detail, "Create a payment" page and the Refunds list. Every action is a Tool operation.
import { icon } from "./icons.js";
import { app, canRead, canWrite, indexAll, invalidateCache, navigate, now, registerPage, routeHash, setTitle } from "./store.js";
import { ToolError, action, amountString, badge, button, call, cardChip, confirmDialog, dateTime, el, field, humanize, idChip, input, intentStatus, key, link, money, moneyCell, openMenu, openModal, refundStatus, select, statusBadge, text, toast } from "./ui.js";
import { alert, amountInput, amountWithStatus, applyError, chip, customerCell, customerPicker, dateCell, deniedPanel, empty, errorPanel, boundNote, indexedList, kv, load, metaBar, methodPicker, listTools, notSimulated, pageHeader, pageInner, pagedList, section, statTabs, submitModal, table, timeline } from "./widgets.js";

const PAYMENT_TABS = [
  { key: "all", label: "All" },
  { key: "succeeded", label: "Succeeded" },
  { key: "refunded", label: "Refunded" },
  { key: "uncaptured", label: "Uncaptured" },
  { key: "failed", label: "Failed" },
  { key: "incomplete", label: "Incomplete" },
  { key: "canceled", label: "Canceled" },
];

const LIST_EXPAND = ["data.latest_charge", "data.customer"];

function chargeOf(intent) {
  return typeof intent.latest_charge === "object" && intent.latest_charge !== null ? intent.latest_charge : undefined;
}

function paymentRows(intents) {
  return table({
    select: { label: "payments", rowLabel: (intent) => `payment ${intent.id}` },
    columns: [
      { label: "Amount", class: "nowrap", render: (intent) => amountWithStatus(intent.amount, intent.currency, statusBadge(intentStatus(intent, chargeOf(intent)))) },
      { label: "Payment method", class: "nowrap", render: (intent) => methodCell(intent) },
      { label: "Description", class: "truncate", render: (intent) => intent.description ?? el("span", { class: "muted", text: "—" }) },
      { label: "Customer", class: "truncate", render: (intent) => customerCell(intent.customer) },
      { label: "Date", class: "nowrap", render: (intent) => dateCell(intent.created) },
      { label: "", class: "actions", render: (intent) => rowMenu(intent) },
    ],
    rows: intents,
    href: (intent) => `#/payments/${intent.id}`,
    onOpen: (intent) => navigate(`#/payments/${intent.id}`),
  });
}

function methodCell(intent) {
  const charge = chargeOf(intent);
  const card = charge?.payment_method_details?.card;
  if (card) return cardChip({ card });
  if (intent.last_payment_error?.payment_method?.card) return cardChip(intent.last_payment_error.payment_method);
  return el("span", { class: "muted", text: "—" });
}

function rowMenu(intent) {
  const trigger = button(undefined, "ghost", { icon: "more", size: "sm", ariaLabel: `Actions for ${intent.id}`, class: "btn-icon-only" });
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    openMenu(trigger, [
      { label: "View payment details", icon: "external", onSelect: () => navigate(`#/payments/${intent.id}`) },
      { label: "Copy payment ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(intent.id).then(() => toast("Copied to clipboard")) },
      ...(intent.customer ? [{ label: "View customer", icon: "customers", onSelect: () => navigate(`#/customers/${typeof intent.customer === "string" ? intent.customer : intent.customer.id}`) }] : []),
    ], { align: "end" });
  });
  return trigger;
}

// ---------------------------------------------------------------------------------------------
// Payments list
// ---------------------------------------------------------------------------------------------

registerPage("payments", async (host, route) => {
  setTitle("Payments");
  const tab = route.params.tab ?? "all";
  const actions = [];
  if (canWrite("payment_intents")) actions.push(button("Create payment", "primary", { icon: "plus", onClick: () => navigate("#/payments/new") }));
  const headerNode = pageHeader("Payments", { actions });
  const tabsHost = el("div");
  const filtersHost = el("div", { class: "filters" });
  const listHost = el("div");
  host.replaceChildren(pageInner(headerNode, tabsHost, filtersHost, listHost));
  if (!canRead("payment_intents")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "payment_intents" }), "payment_intents"));
    return;
  }

  const dateFilter = route.params.since;
  const created = dateFilter ? { gte: Number(dateFilter) } : undefined;
  const baseArgs = { expand: LIST_EXPAND, ...(created ? { created } : {}) };

  // Status counts come from a bounded index of the account (PaymentIntents carry no server-side status filter).
  tabsHost.replaceChildren(statTabs(PAYMENT_TABS.map((entry) => ({ ...entry })), tab, (next) => navigate(routeHash("payments", undefined, { ...route.params, tab: next === "all" ? undefined : next }))));
  const ranges = [
    { label: "All time", value: undefined },
    { label: "Last 7 days", value: now() - 7 * 86400 },
    { label: "Last 30 days", value: now() - 30 * 86400 },
    { label: "Last 90 days", value: now() - 90 * 86400 },
  ];
  const activeRange = ranges.find((range) => String(range.value ?? "") === String(dateFilter ?? "")) ?? ranges[0];
  const dateChip = chip("Date and time", {
    active: activeRange.value !== undefined,
    value: activeRange.value === undefined ? undefined : activeRange.label,
    onClear: () => navigate(routeHash("payments", undefined, { ...route.params, since: undefined })),
    onClick: () => openMenu(dateChip, ranges.map((range) => ({ label: range.label, onSelect: () => navigate(routeHash("payments", undefined, { ...route.params, since: range.value })) }))),
  });
  filtersHost.append(
    dateChip,
    chip("Amount", { onClick: () => notSimulated("Amount filter", "PaymentIntents have no amount filter in this Tool's list operation, and the app does not fake one.") }),
    chip("Currency", { onClick: () => notSimulated("Currency filter", "PaymentIntents have no currency filter in this Tool's list operation, and the app does not fake one.") }),
    chip("Status", { onClick: () => notSimulated("Status filter", "Use the status cards above; they count and filter a bounded index of this account's payments.") }),
    chip("Payment method", { onClick: () => notSimulated("Payment method filter", "Cards are the only payment method type in this synthetic account.") }),
    chip("More filters", { onClick: () => notSimulated("More filters") }),
    listTools(),
  );

  const emptyNode = () => empty(tab === "all" ? "No payments yet" : `No ${PAYMENT_TABS.find((entry) => entry.key === tab)?.label.toLowerCase()} payments`, tab === "all" ? "Payments you create or that your integration creates appear here." : "Try another status or a wider date range.", canWrite("payment_intents") && tab === "all" ? button("Create payment", "primary", { icon: "plus", onClick: () => navigate("#/payments/new") }) : undefined);

  if (tab === "all") {
    const list = pagedList({ operation: "payment_intents.list", args: baseArgs, limit: 20, render: paymentRows, emptyNode });
    listHost.append(list.element);
  } else {
    listHost.append(el("div", { class: "list-loading" }, [icon("spinner", "spin"), text("Loading…")]));
  }
  try {
    const index = await indexAll("payment_intents.list", baseArgs);
    const counts = Object.fromEntries(PAYMENT_TABS.map((entry) => [entry.key, 0]));
    for (const intent of index.items) {
      counts.all += 1;
      counts[intentStatus(intent, chargeOf(intent)).key] += 1;
    }
    tabsHost.replaceChildren(statTabs(PAYMENT_TABS.map((entry) => ({ ...entry, count: `${counts[entry.key]}${index.complete ? "" : "+"}` })), tab, (next) => navigate(routeHash("payments", undefined, { ...route.params, tab: next === "all" ? undefined : next }))));
    if (tab !== "all") {
      const filtered = index.items.filter((intent) => intentStatus(intent, chargeOf(intent)).key === tab);
      listHost.replaceChildren(indexedList({ items: filtered, complete: index.complete, render: paymentRows, emptyNode, note: "status filtered client-side" }));
    }
  } catch (error) {
    if (tab !== "all") listHost.replaceChildren(errorPanel(error, () => navigate(location.hash)));
  }
});

// ---------------------------------------------------------------------------------------------
// Payment detail
// ---------------------------------------------------------------------------------------------

registerPage("payment", async (host, route) => {
  const id = route.id;
  setTitle(id);
  const inner = pageInner();
  host.replaceChildren(inner);
  await load(inner, async () => {
    const intent = await call("payment_intents.retrieve", { payment_intent: id, expand: ["customer", "payment_method", "latest_charge"] });
    const charge = chargeOf(intent);
    let refunds = [];
    let refundsComplete = true;
    if (charge && canRead("refunds")) {
      try {
        const refundIndex = await indexAll("refunds.list", { payment_intent: intent.id });
        refunds = refundIndex.items;
        refundsComplete = refundIndex.complete;
      } catch {
        refunds = [];
      }
    }
    return renderPayment(intent, charge, refunds, refundsComplete);
  }, { retry: () => navigate(location.hash) });
});

function renderPayment(intent, charge, refunds, refundsComplete = true) {
  const status = intentStatus(intent, charge);
  const customer = typeof intent.customer === "object" ? intent.customer : undefined;
  const method = typeof intent.payment_method === "object" && intent.payment_method !== null ? intent.payment_method : charge?.payment_method_details?.card ? { card: charge.payment_method_details.card, id: charge.payment_method } : intent.last_payment_error?.payment_method ?? undefined;
  const refundable = intent.status === "succeeded" && charge && charge.captured && charge.status === "succeeded" ? charge.amount_captured - charge.amount_refunded : 0;
  const actions = [];
  const canPay = canWrite("payment_intents");
  if (canWrite("refunds") && refundable > 0) actions.push(button("Refund", "secondary", { icon: "arrow-return", onClick: () => openRefund(intent, charge, refundable) }));
  if (canPay && intent.status === "requires_capture") actions.push(button("Capture", "primary", { onClick: () => openCapture(intent) }));
  if (canPay && (intent.status === "requires_confirmation" || intent.status === "requires_payment_method")) actions.push(button("Confirm payment", "primary", { onClick: () => openConfirm(intent, customer) }));
  if (canPay && ["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"].includes(intent.status)) actions.push(button("Cancel payment", "secondary", { onClick: () => cancelIntent(intent) }));
  const more = button(undefined, "secondary", { icon: "more", ariaLabel: "More actions", class: "btn-icon-only" });
  more.addEventListener("click", () =>
    openMenu(more, [
      { label: "Copy payment ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(intent.id).then(() => toast("Copied to clipboard")) },
      ...(customer ? [{ label: "View customer", icon: "customers", onSelect: () => navigate(`#/customers/${customer.id}`) }] : []),
      ...(charge ? [{ label: "Copy charge ID", icon: "copy", onSelect: () => navigator.clipboard?.writeText(charge.id).then(() => toast("Copied to clipboard")) }] : []),
      "divider",
      { label: "Receipt (synthetic, not served)", icon: "receipt", disabled: true },
    ], { align: "end" }),
  );
  actions.push(more);

  const title = el("div", { class: "detail-title" }, [el("h1", { class: "page-title" }, moneyCell(intent.amount, intent.currency)), statusBadge(status)]);
  const header = pageHeader(title, { kind: "Payment", actions, breadcrumbs: [{ label: "Payments", href: "#/payments" }, { label: intent.id }] });

  const meta = metaBar([
    ["Last update", dateTime(lastUpdate(intent, charge), now())],
    ["Customer", customer ? link(`#/customers/${customer.id}`, customer.name || customer.email || customer.id) : intent.customer ? link(`#/customers/${intent.customer}`, intent.customer) : el("span", { class: "muted", text: "Guest" })],
    ["Payment method", method ? cardChip(method) : el("span", { class: "muted", text: "No payment method" })],
    charge?.outcome ? ["Risk evaluation", riskCell(charge.outcome)] : undefined,
  ]);

  const banners = [];
  if (intent.last_payment_error) banners.push(alert(`${intent.last_payment_error.message} (${humanize(intent.last_payment_error.decline_code ?? intent.last_payment_error.code)})`, "danger", { title: "The last payment attempt failed" }));
  if (intent.status === "requires_action") banners.push(alert("The customer must complete 3D Secure authentication. This synthetic account cannot complete it; cancel the payment or retry with another card.", "warning", { title: "Requires action" }));
  if (intent.status === "requires_capture") banners.push(alert(`${money(intent.amount_capturable, intent.currency)} is authorised and will be released if it is not captured.`, "warning", { title: "Uncaptured", iconName: "clock" }));

  const details = section("Payment details", kv([
    ["Amount", moneyCell(intent.amount, intent.currency)],
    ["Amount received", money(intent.amount_received, intent.currency)],
    ...(charge ? [["Net (fees not modelled)", money(charge.amount_captured - charge.amount_refunded, intent.currency)]] : []),
    ["Status", statusBadge(status)],
    ["Description", intent.description],
    ["Statement descriptor", charge?.calculated_statement_descriptor ?? intent.statement_descriptor_suffix],
    ["Capture method", humanize(intent.capture_method)],
    ["Receipt email", intent.receipt_email],
    ["ID", idChip(intent.id)],
    ["Client secret", el("span", { class: "muted", text: "Hidden — usable nowhere" })],
  ]));

  const methodSection = section("Payment method", method?.card ? kv([
    ["ID", method.id ? idChip(method.id) : null],
    ["Number", cardChip(method)],
    ["Fingerprint", el("code", { class: "id-code", text: method.card.fingerprint ?? "—" })],
    ["Expires", `${String(method.card.exp_month).padStart(2, "0")} / ${method.card.exp_year}`],
    ["Type", `${humanize(method.card.funding)} card`],
    ["Issuer country", method.card.country],
    ["CVC check", humanize(method.card.checks?.cvc_check ?? charge?.payment_method_details?.card?.checks?.cvc_check ?? "unavailable")],
    ["Owner", method.billing_details?.name ?? charge?.billing_details?.name],
    ["Owner email", method.billing_details?.email ?? charge?.billing_details?.email],
  ]) : el("p", { class: "muted", text: "No payment method has been attached to this payment yet." }));

  const events = [];
  if (intent.status === "succeeded") events.push({ title: "Payment succeeded", at: lastUpdate(intent, charge), tone: "green", icon: "check-circle" });
  if (intent.status === "canceled") events.push({ title: "Payment canceled", at: intent.canceled_at ?? undefined, text: intent.cancellation_reason ? humanize(intent.cancellation_reason) : undefined, tone: "", icon: "minus-circle" });
  if (intent.status === "requires_capture") events.push({ title: "Payment authorised", at: charge?.created, text: "Awaiting capture", tone: "yellow", icon: "clock" });
  if (intent.last_payment_error) events.push({ title: "Payment failed", at: charge?.created, text: intent.last_payment_error.message, tone: "red", icon: "x-circle" });
  if (intent.status === "requires_action") events.push({ title: "Customer authentication required", at: charge?.created ?? intent.created, tone: "yellow", icon: "alert-circle" });
  for (const refund of refunds) events.push({ title: `${money(refund.amount, refund.currency)} refunded`, at: refund.created, text: refund.reason ? humanize(refund.reason) : undefined, tone: "", icon: "arrow-return" });
  events.push({ title: "Payment started", at: intent.created, tone: "blue", icon: "dot" });
  events.sort((left, right) => (right.at ?? 0) - (left.at ?? 0));
  const timelineSection = section("Timeline", timeline(events), { actions: [button("Add note", "secondary", { size: "sm", icon: "plus", onClick: () => notSimulated("Notes", "Dashboard notes are not stored by this synthetic account.") })] });
  const logsSection = section("Events and logs", el("div", { class: "empty" }, [el("div", { class: "empty-title", text: "Events and request logs are not simulated" }), el("div", { text: "The Tool emits Firedrill events (payment_intent.succeeded, …) to drills, but keeps no Stripe event or request-log objects to list here." })]));

  const refundsNote = boundNote({ items: refunds, complete: refundsComplete }, "refunds of this payment", "#/refunds");
  const refundsSection = refunds.length > 0 ? section("Refunds", [...(refundsNote ? [refundsNote] : []), table({
    columns: [
      { label: "Amount", class: "nowrap", render: (refund) => amountWithStatus(refund.amount, refund.currency, statusBadge(refundStatus(refund))) },
      { label: "Reason", render: (refund) => (refund.reason ? humanize(refund.reason) : el("span", { class: "muted", text: "—" })) },
      { label: "ID", render: (refund) => idChip(refund.id) },
      { label: "Date", class: "nowrap", render: (refund) => dateCell(refund.created) },
    ],
    rows: refunds,
  })], { count: `${refunds.length}${refundsComplete ? "" : "+"}` }) : null;

  const metadataRows = Object.entries(intent.metadata ?? {});
  const metadataSection = section("Metadata", metadataRows.length > 0 ? kv(metadataRows) : el("p", { class: "muted", text: "No metadata" }));

  return [header, meta, ...banners, timelineSection, details, methodSection, refundsSection, metadataSection, logsSection].filter(Boolean);
}

function lastUpdate(intent, charge) {
  return Math.max(intent.created, charge?.created ?? 0, intent.canceled_at ?? 0);
}

function riskCell(outcome) {
  const level = outcome.risk_level ?? "normal";
  const tone = level === "elevated" ? "yellow" : level === "highest" ? "red" : "green";
  return el("span", { class: "meta-value" }, [badge(`${outcome.risk_score ?? "–"}`, tone), el("span", { class: "muted", text: humanize(level) })]);
}

// ---------------------------------------------------------------------------------------------
// Refund / capture / confirm / cancel
// ---------------------------------------------------------------------------------------------

function openRefund(intent, charge, refundable) {
  const amount = amountInput({ amount: amountString(refundable, intent.currency), currency: intent.currency, currencies: [intent.currency] });
  amount.select.disabled = true;
  const reason = select([{ value: "", label: "Select a reason" }, { value: "duplicate", label: "Duplicate" }, { value: "fraudulent", label: "Fraudulent" }, { value: "requested_by_customer", label: "Requested by customer" }], "");
  const fields = { amount: field("Refund", amount, { hint: `Up to ${money(refundable, intent.currency)} can be refunded.` }), reason: field("Reason", reason, { optional: true }) };
  // The key is fixed for the life of the dialog so a retry after an outage replays instead of refunding twice.
  const idempotencyKey = key();
  openModal({
    title: "Refund payment",
    describedBy: "Refunds take 5–10 days to appear on a customer's statement. This synthetic account credits the balance immediately.",
    body: [fields.amount, fields.reason],
    actions: [
      { label: "Cancel" },
      {
        label: "Refund",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          const minor = amount.amount();
          if (minor === undefined || minor <= 0) {
            fields.amount.setError("Enter a valid amount.");
            return;
          }
          return submitModal(api, fields, () => call("refunds.create", { payment_intent: intent.id, amount: minor, ...(reason.value ? { reason: reason.value } : {}) }, idempotencyKey), () => {
            toast(`${money(minor, intent.currency)} refunded`);
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

function openCapture(intent) {
  const amount = amountInput({ amount: amountString(intent.amount_capturable, intent.currency), currency: intent.currency, currencies: [intent.currency] });
  amount.select.disabled = true;
  const fields = { amount_to_capture: field("Amount to capture", amount, { hint: `Up to ${money(intent.amount_capturable, intent.currency)}. Capturing less releases the remainder.` }) };
  const idempotencyKey = key();
  openModal({
    title: "Capture payment",
    body: [fields.amount_to_capture],
    actions: [
      { label: "Cancel" },
      {
        label: "Capture",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          const minor = amount.amount();
          if (minor === undefined || minor <= 0) {
            fields.amount_to_capture.setError("Enter a valid amount.");
            return;
          }
          return submitModal(api, fields, () => call("payment_intents.capture", { payment_intent: intent.id, amount_to_capture: minor }, idempotencyKey), () => {
            toast(`Captured ${money(minor, intent.currency)}`);
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

function openConfirm(intent, customer) {
  const picker = methodPicker({ customer: customer?.id ?? intent.customer ?? undefined, value: typeof intent.payment_method === "string" ? intent.payment_method : intent.payment_method?.id ?? "" });
  if (customer) void picker.setCustomer(customer.id, customer.invoice_settings?.default_payment_method);
  const fields = { payment_method: field("Payment method", picker) };
  const idempotencyKey = key();
  openModal({
    title: "Confirm payment",
    describedBy: `Confirm ${money(intent.amount, intent.currency)} with a saved card or one of Stripe's test cards.`,
    body: [fields.payment_method],
    actions: [
      { label: "Cancel" },
      {
        label: "Confirm",
        kind: "primary",
        submit: true,
        onClick: (api) => {
          if (!picker.value) {
            fields.payment_method.setError("Choose a payment method.");
            return;
          }
          return submitModal(api, fields, () => call("payment_intents.confirm", { payment_intent: intent.id, payment_method: picker.value }, idempotencyKey), (value) => {
            toast(value.status === "succeeded" ? "Payment succeeded" : `Payment is now ${humanize(value.status)}`);
            invalidateCache();
            navigate(location.hash);
          });
        },
      },
    ],
  });
}

async function cancelIntent(intent) {
  const ok = await confirmDialog("Cancel payment?", `${money(intent.amount, intent.currency)} will not be collected. ${intent.status === "requires_capture" ? "The authorisation is released." : ""}`.trim(), "Cancel payment", { danger: true });
  if (!ok) return;
  await action(async () => {
    await call("payment_intents.cancel", { payment_intent: intent.id, cancellation_reason: "requested_by_customer" }, key());
    toast("Payment canceled");
    invalidateCache();
    navigate(location.hash);
  });
}

// ---------------------------------------------------------------------------------------------
// Create a payment (full page, like the Dashboard's "Create payment")
// ---------------------------------------------------------------------------------------------

registerPage("payment-new", async (host, route) => {
  setTitle("Create a payment");
  if (!canWrite("payment_intents")) {
    host.replaceChildren(pageInner(pageHeader("Create a payment", { breadcrumbs: [{ label: "Payments", href: "#/payments" }] }), deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "payment_intents", level: "write" }), "payment_intents")));
    return;
  }
  app.editing += 1;
  const amount = amountInput({ currency: app.context?.account?.default_currency ?? "usd" });
  const customer = customerPicker({ value: route.params.customer, onChange: (record) => void picker.setCustomer(record?.id, record?.invoice_settings?.default_payment_method) });
  const description = input({ placeholder: "Order #1234 — what the customer bought" });
  const picker = methodPicker({ customer: route.params.customer, allowNone: true, noneLabel: "Create without a payment method (requires_payment_method)" });
  const capture = select([{ value: "automatic", label: "Automatically (charge now)" }, { value: "manual", label: "Manually (authorise now, capture later)" }], "automatic");
  const receipt = input({ type: "email", placeholder: "customer@example.com" });
  const statement = input({ placeholder: "ORDER 1234", maxlength: 22 });
  const confirmNow = el("input", { attrs: { type: "checkbox" } });
  confirmNow.checked = true;
  const fields = {
    amount: field("Amount", amount),
    customer: field("Customer", customer, { optional: true }),
    description: field("Description", description, { optional: true }),
    payment_method: field("Payment method", picker),
    capture_method: field("Capture method", capture),
    receipt_email: field("Receipt email", receipt, { optional: true }),
    statement_descriptor_suffix: field("Statement descriptor suffix", statement, { optional: true, hint: "Up to 22 characters shown after the account's descriptor." }),
  };
  const errorHost = el("div", { class: "form-error", attrs: { role: "alert" } });
  errorHost.hidden = true;
  const api = { setError: (message) => { errorHost.textContent = message ?? ""; errorHost.hidden = !message; }, setBusy() {}, close() {} };
  let idempotencyKey = key();
  const summary = el("div", { class: "editor-summary" }, [el("div", { class: "editor-summary-title", text: "Summary" }), el("div", { class: "muted", text: "The payment is created in this synthetic account; no card network is contacted." })]);
  const submit = button("Create payment", "primary", {
    onClick: () =>
      action(async () => {
        errorHost.hidden = true;
        for (const entry of Object.values(fields)) entry.setError(undefined);
        const minor = amount.amount();
        if (minor === undefined) {
          fields.amount.setError("Enter a valid amount, for example 18.90.");
          return;
        }
        const args = { amount: minor, currency: amount.currency(), capture_method: capture.value };
        if (customer.value) args.customer = customer.value;
        if (description.value.trim()) args.description = description.value.trim();
        if (picker.value) args.payment_method = picker.value;
        if (receipt.value.trim()) args.receipt_email = receipt.value.trim();
        if (statement.value.trim()) args.statement_descriptor_suffix = statement.value.trim();
        if (confirmNow.checked && picker.value) args.confirm = true;
        submit.classList.add("is-busy");
        submit.disabled = true;
        try {
          const intent = await call("payment_intents.create", args, idempotencyKey);
          toast(intent.status === "succeeded" ? `Payment of ${money(intent.amount, intent.currency)} succeeded` : `Payment created (${humanize(intent.status)})`);
          invalidateCache();
          app.editing -= 1;
          navigate(`#/payments/${intent.id}`);
        } catch (error) {
          if (error instanceof ToolError && error.is("CARD_DECLINED")) {
            idempotencyKey = key();
            // A creation-time decline names no PaymentIntent: none was created, so there is no id to show or link.
            errorHost.hidden = false;
            errorHost.replaceChildren(el("strong", { text: `Card declined: ` }), text(`${error.message} (${humanize(error.details.decline_code ?? "generic_decline")}). No payment was created — choose another card and try again.`));
          } else {
            idempotencyKey = key();
            applyError(error, fields, api);
          }
        } finally {
          submit.classList.remove("is-busy");
          submit.disabled = false;
        }
      }),
  });
  const form = el("div", { class: "editor-form" }, [
    fields.amount,
    fields.customer,
    fields.description,
    fields.payment_method,
    el("label", { class: "check-field" }, [confirmNow, el("span", { class: "check-label", text: "Confirm immediately" }, [el("span", { class: "check-hint", text: "Uncheck to create a PaymentIntent in requires_confirmation and confirm it later." })])]),
    fields.capture_method,
    fields.receipt_email,
    fields.statement_descriptor_suffix,
    errorHost,
    el("div", { class: "sticky-footer" }, [button("Cancel", "secondary", { onClick: () => { app.editing -= 1; navigate("#/payments"); } }), submit]),
  ]);
  host.replaceChildren(pageInner(pageHeader("Create a payment", { breadcrumbs: [{ label: "Payments", href: "#/payments" }, { label: "Create" }] }), el("div", { class: "editor" }, [form, summary])));
  if (route.params.customer) void picker.setCustomer(route.params.customer);
  amount.input.focus();
  host.addEventListener("page-leave", () => { app.editing = Math.max(0, app.editing - 1); }, { once: true });
});

// ---------------------------------------------------------------------------------------------
// Refunds list
// ---------------------------------------------------------------------------------------------

registerPage("refunds", async (host) => {
  setTitle("Refunds");
  const header = pageHeader("Refunds");
  const listHost = el("div");
  host.replaceChildren(pageInner(header, listHost));
  if (!canRead("refunds")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "refunds" }), "refunds"));
    return;
  }
  const list = pagedList({
    operation: "refunds.list",
    args: {},
    limit: 20,
    emptyNode: () => empty("No refunds yet", "Refunds you issue from a payment appear here."),
    render: (refunds) =>
      table({
        columns: [
          { label: "Amount", class: "nowrap", render: (refund) => amountWithStatus(refund.amount, refund.currency, statusBadge(refundStatus(refund))) },
          { label: "Payment", render: (refund) => link(`#/payments/${refund.payment_intent}`, refund.payment_intent ?? refund.charge, { class: "link-quiet" }) },
          { label: "Reason", render: (refund) => (refund.reason ? humanize(refund.reason) : null) },
          { label: "Reference", render: (refund) => el("code", { class: "id-code", text: refund.destination_details?.card?.reference ?? "—" }) },
          { label: "Date", class: "nowrap", render: (refund) => dateCell(refund.created) },
        ],
        rows: refunds,
        href: (refund) => `#/payments/${refund.payment_intent}`,
        onOpen: (refund) => navigate(`#/payments/${refund.payment_intent}`),
      }),
  });
  listHost.append(list.element);
});

export { chargeOf, paymentRows, openRefund };
