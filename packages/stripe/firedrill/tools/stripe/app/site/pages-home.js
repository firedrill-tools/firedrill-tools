// Home, Balances, Transactions, Developers and Settings screens.
import { icon } from "./icons.js";
import { app, canRead, canWrite, indexAll, navigate, now, registerPage, setTitle } from "./store.js";
import { ToolError, button, call, cardChip, dateOnly, dateTime, el, humanize, idChip, intentStatus, link, money, refundStatus, statusBadge, text } from "./ui.js";
import { alert, amountWithStatus, chip, customerCell, dateCell, deniedPanel, empty, errorPanel, boundNote, kv, mergedList, listTools, load, notSimulated, pageHeader, pageInner, pagedList, section, table, tabs } from "./widgets.js";
import { chargeOf } from "./pages-payments.js";

const DAY = 86400;

function dayStart(seconds) {
  return seconds - (seconds % DAY);
}

/** Line chart drawn with SVG DOM nodes (no markup strings), the Dashboard's purple line over a dotted baseline. */
function lineChart(points, { height = 110, format }) {
  const svgNs = "http://www.w3.org/2000/svg";
  const width = 600;
  const pad = 6;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", points.map((point) => `${point.label}: ${format ? format(point.value) : point.value}`).join(", "));
  const max = Math.max(1, ...points.map((point) => point.value));
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((point, index) => [pad + index * step, height - pad - (point.value / max) * (height - pad * 2 - 4)]);
  const grid = document.createElementNS(svgNs, "line");
  grid.setAttribute("x1", "0");
  grid.setAttribute("x2", String(width));
  grid.setAttribute("y1", String(height - pad));
  grid.setAttribute("y2", String(height - pad));
  grid.setAttribute("class", "chart-line");
  svg.append(grid);
  const area = document.createElementNS(svgNs, "path");
  area.setAttribute("d", `M ${coords[0][0]} ${height - pad} ${coords.map(([x, y]) => `L ${x} ${y}`).join(" ")} L ${coords[coords.length - 1][0]} ${height - pad} Z`);
  area.setAttribute("class", "chart-area");
  svg.append(area);
  const line = document.createElementNS(svgNs, "polyline");
  line.setAttribute("points", coords.map(([x, y]) => `${x},${y}`).join(" "));
  line.setAttribute("class", "chart-stroke");
  line.setAttribute("vector-effect", "non-scaling-stroke");
  svg.append(line);
  coords.forEach(([x, y], index) => {
    const dot = document.createElementNS(svgNs, "circle");
    dot.setAttribute("cx", String(x));
    dot.setAttribute("cy", String(y));
    dot.setAttribute("r", "3");
    dot.setAttribute("class", "chart-dot");
    dot.setAttribute("vector-effect", "non-scaling-stroke");
    const title = document.createElementNS(svgNs, "title");
    title.textContent = `${points[index].label}: ${format ? format(points[index].value) : points[index].value}`;
    dot.append(title);
    svg.append(dot);
  });
  const axis = el("div", { class: "chart-axis" }, [el("span", { text: points[0]?.label ?? "" }), el("span", { text: points[points.length - 1]?.label ?? "" })]);
  return el("div", {}, [svg, axis]);
}

// ---------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------

registerPage("home", async (host) => {
  setTitle("Home");
  const account = app.context?.account;
  const currency = account?.default_currency ?? "usd";
  const updated = `Updated ${dateTime(now(), now())}`;
  const header = pageHeader("Today");
  const todayMain = el("div", { class: "card today-main" });
  const balanceCard = el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text(`${currency.toUpperCase()} balance`), link("#/balances", "View", { class: "link" })])]);
  const payoutsCard = el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text("Payouts")]), el("div", { class: "card-note", text: "Payouts are not simulated by this synthetic account." })]);
  const todayHost = el("div", { class: "today-grid" }, [todayMain, el("div", { class: "today-side" }, [balanceCard, payoutsCard])]);
  const overviewHost = el("div");
  const recentHost = el("div");
  const addWidget = button("Add", "secondary", { size: "sm", icon: "plus" });
  const editWidgets = button("Edit", "secondary", { size: "sm", icon: "edit" });
  const widgetNote = "The overview shows a fixed set of widgets computed from charges, refunds and customers in this Tool.";
  addWidget.addEventListener("click", () => notSimulated("Add widgets", widgetNote));
  editWidgets.addEventListener("click", () => notSimulated("Edit widgets", widgetNote));
  const controls = el("div", { class: "overview-controls" }, [
    chip("Date range", { active: true, value: "Last 7 days", onClick: () => notSimulated("Date range", "The overview always covers the last 7 virtual days.") }),
    chip("Daily", { active: true, value: "Daily", onClick: () => notSimulated("Granularity", "The overview charts one point per virtual day.") }),
    chip("Compare", { onClick: () => notSimulated("Comparison period", "Period comparisons are not simulated.") }),
  ]);
  host.replaceChildren(pageInner(header, todayHost, section("Your overview", [controls, overviewHost], { actions: [addWidget, editWidgets] }), section("Recent payments", recentHost, { actions: [link("#/payments", "View all", { class: "btn btn-link" })] })));

  if (!canRead("balance")) balanceCard.append(el("div", { class: "muted", text: "This key cannot read the balance." }));
  else {
    try {
      const balance = await call("balance.retrieve", {});
      const available = balance.available.find((row) => row.currency === currency)?.amount ?? 0;
      const pending = balance.pending.find((row) => row.currency === currency)?.amount ?? 0;
      balanceCard.append(el("div", { class: "card-value", text: money(available + pending, currency) }), el("div", { class: "card-note", text: `${money(available, currency)} available · ${money(pending, currency)} pending` }));
      const others = balance.available.filter((row) => row.currency !== currency && row.amount !== 0);
      if (others.length > 0) balanceCard.append(el("div", { class: "card-note", text: `Also ${others.map((row) => money(row.amount, row.currency)).join(", ")} available` }));
    } catch (error) {
      balanceCard.append(el("div", { class: "muted", text: error instanceof ToolError && error.is("PERMISSION_DENIED") ? "This key cannot read the balance." : "Balance unavailable right now." }));
    }
  }

  const overview = el("div", { class: "overview-row" });
  overviewHost.append(overview);
  if (!canRead("charges")) {
    todayMain.append(el("div", { class: "home-card-title" }, [text("Gross volume")]), el("div", { class: "muted", text: "This key cannot read charges." }));
    overview.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "charges" }), "charges"));
  } else {
    try {
      const since = dayStart(now()) - 6 * DAY;
      const chargeIndex = await indexAll("charges.list", { created: { gte: since - DAY } });
      const charges = chargeIndex.items;
      // The index is bounded (store.indexAll); past the bound every figure is a lower bound and says so.
      const plus = chargeIndex.complete ? "" : "+";
      const partial = chargeIndex.complete ? undefined : `Partial: first ${charges.length.toLocaleString("en-US")} charges of this window`;
      const counted = (charge) => charge.status === "succeeded" && charge.captured;
      const days = Array.from({ length: 7 }, (_, index) => since + index * DAY);
      const volume = days.map((day) => ({ label: dateOnly(day, now()), value: charges.filter((charge) => counted(charge) && charge.currency === currency && dayStart(charge.created) === day).reduce((sum, charge) => sum + charge.amount_captured, 0) }));
      const counts = days.map((day) => ({ label: dateOnly(day, now()), value: charges.filter((charge) => counted(charge) && dayStart(charge.created) === day).length }));
      const failed = charges.filter((charge) => charge.status === "failed" && charge.created >= since).length;
      const gross = volume.reduce((sum, point) => sum + point.value, 0);
      const successful = counts.reduce((sum, point) => sum + point.value, 0);
      // Today: cumulative gross volume per hour from 12:00 AM (UTC) up to the world's virtual now, beside yesterday's total.
      const today = dayStart(now());
      const hours = Math.max(1, Math.floor((now() - today) / 3600) + 1);
      let running = 0;
      const todaySeries = Array.from({ length: hours + 1 }, (_, index) => {
        const end = Math.min(now(), today + index * 3600);
        running = charges.filter((charge) => counted(charge) && charge.currency === currency && charge.created >= today && charge.created <= end).reduce((sum, charge) => sum + charge.amount_captured, 0);
        return { label: index === 0 ? "12:00 AM" : dateTime(end, now()).split(", ").pop(), value: running };
      });
      const yesterday = charges.filter((charge) => counted(charge) && charge.currency === currency && dayStart(charge.created) === today - DAY).reduce((sum, charge) => sum + charge.amount_captured, 0);
      todayMain.append(
        el("div", { class: "today-stats" }, [
          el("div", {}, [el("div", { class: "today-stat-label", text: "Gross volume" }), el("div", { class: "today-stat-value", text: money(running, currency) + plus })]),
          el("div", {}, [el("div", { class: "today-stat-label", text: "Yesterday" }), el("div", { class: "today-stat-value muted", text: money(yesterday, currency) })]),
        ]),
        lineChart(todaySeries, { height: 160, format: (value) => money(value, currency) }),
        ...[boundNote(chargeIndex, "charges of the last 8 days", "#/transactions?tab=charges")].filter(Boolean),
      );
      const footer = (href, note) => el("div", { class: "card-footer" }, [el("span", { text: note ?? updated }), href ? link(href, "More details", { class: "link" }) : null]);
      const widget = (title, big, delta, series, href, format, note) => el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text(title)]), el("div", { class: "stat-row" }, [el("span", { class: "stat-big", text: big }), el("span", { class: "stat-delta", text: delta })]), lineChart(series, { format }), footer(href, note)]);
      const moneyFormat = (value) => money(value, currency);
      overview.append(
        widget("Gross volume", money(gross, currency) + plus, currency.toUpperCase(), volume, "#/transactions", moneyFormat, partial),
        widget("Successful payments", String(successful) + plus, failed > 0 ? `${failed}${plus} failed` : plus ? "failures not fully counted" : "no failures", counts, "#/payments?tab=succeeded", undefined, partial),
      );
      // Failed payments per day, from the same charges.
      const failedSeries = days.map((day) => ({ label: dateOnly(day, now()), value: charges.filter((charge) => charge.status === "failed" && dayStart(charge.created) === day).length }));
      overview.append(widget("Failed payments", String(failedSeries.reduce((sum, point) => sum + point.value, 0)) + plus, "declined charges", failedSeries, "#/payments?tab=failed", undefined, partial));
      // Net volume: captured charges minus succeeded refunds per day (Stripe fees are not modelled, so no fee is subtracted).
      const netCard = el("div");
      overview.append(netCard);
      if (!canRead("refunds")) netCard.replaceWith(el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text("Net volume")]), el("div", { class: "muted", text: "This key cannot read refunds." })]));
      else {
        try {
          const refundIndex = await indexAll("refunds.list", { created: { gte: since } });
          const refunds = refundIndex.items.filter((refund) => refund.status === "succeeded" && refund.currency === currency);
          const net = volume.map((point, index) => ({ label: point.label, value: point.value - refunds.filter((refund) => dayStart(refund.created) === days[index]).reduce((sum, refund) => sum + refund.amount, 0) }));
          const refunded = refunds.reduce((sum, refund) => sum + refund.amount, 0);
          netCard.replaceWith(widget("Net volume", money(net.reduce((sum, point) => sum + point.value, 0), currency), `${money(refunded, currency)}${refundIndex.complete ? "" : "+"} refunded · no fees modelled`, net, "#/balances", moneyFormat, refundIndex.complete && chargeIndex.complete ? undefined : `Partial: first ${refundIndex.items.length.toLocaleString("en-US")} refunds and ${charges.length.toLocaleString("en-US")} charges of this window`));
        } catch (error) {
          netCard.replaceWith(el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text("Net volume")]), el("div", { class: "muted", text: error instanceof ToolError && error.is("PERMISSION_DENIED") ? "This key cannot read refunds." : "Unavailable right now." })]));
        }
      }
      // New customers per day.
      const customersCard = el("div");
      overview.append(customersCard);
      if (!canRead("customers")) customersCard.replaceWith(el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text("New customers")]), el("div", { class: "muted", text: "This key cannot read customers." })]));
      else {
        try {
          const customerIndex = await indexAll("customers.list", { created: { gte: since } });
          const created = customerIndex.items;
          const series = days.map((day) => ({ label: dateOnly(day, now()), value: created.filter((customer) => dayStart(customer.created) === day).length }));
          customersCard.replaceWith(widget("New customers", String(created.length) + (customerIndex.complete ? "" : "+"), "created in the last 7 days", series, "#/customers", undefined, customerIndex.complete ? undefined : `Partial: first ${created.length.toLocaleString("en-US")} customers of this window`));
        } catch (error) {
          customersCard.replaceWith(el("div", { class: "card" }, [el("div", { class: "home-card-title" }, [text("New customers")]), el("div", { class: "muted", text: error instanceof ToolError && error.is("PERMISSION_DENIED") ? "This key cannot read customers." : "Unavailable right now." })]));
        }
      }
      // Widgets that need data the Tool does not model.
      for (const [title, detail] of [["Dispute activity", "Disputes are not modelled by this synthetic account."], ["MRR", "Billing analytics (MRR, churn, trials) are not computed by this Tool."]]) {
        const card = el("button", { class: "card card-not-simulated", attrs: { type: "button", "aria-label": `${title} (not simulated)` }, title: `${title} (not simulated)` }, [el("div", { class: "home-card-title" }, [text(title)]), el("div", { class: "card-placeholder" }, [icon("flask"), el("span", { text: "Not simulated by this Tool" })])]);
        card.addEventListener("click", () => notSimulated(title, detail));
        overview.append(card);
      }
    } catch (error) {
      todayMain.append(el("div", { class: "muted", text: "Unavailable right now." }));
      overview.append(errorPanel(error, () => navigate(location.hash)));
    }
  }

  // Recent payments
  if (!canRead("payment_intents")) recentHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "payment_intents" }), "payment_intents"));
  else {
    await load(recentHost, async () => {
      const page = await call("payment_intents.list", { limit: 5, expand: ["data.latest_charge", "data.customer"] });
      if (page.data.length === 0) return empty("No payments yet", "Payments appear here as soon as your integration or the Create button makes one.", canWrite("payment_intents") ? button("Create payment", "primary", { icon: "plus", onClick: () => navigate("#/payments/new") }) : undefined);
      return table({
        columns: [
          { label: "Amount", class: "nowrap", render: (intent) => amountWithStatus(intent.amount, intent.currency, statusBadge(intentStatus(intent, chargeOf(intent)))) },
          { label: "Description", class: "truncate", render: (intent) => intent.description },
          { label: "Customer", class: "truncate", render: (intent) => customerCell(intent.customer) },
          { label: "Date", class: "nowrap", render: (intent) => dateCell(intent.created) },
        ],
        rows: page.data,
        href: (intent) => `#/payments/${intent.id}`,
        onOpen: (intent) => navigate(`#/payments/${intent.id}`),
      });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------------------------

registerPage("balances", async (host) => {
  setTitle("Balances");
  const header = pageHeader("Balances", { subtitle: "Available funds are captured charges older than two virtual days, minus their refunds; newer captures are pending." });
  const balanceHost = el("div");
  const activityHost = el("div");
  host.replaceChildren(pageInner(header, balanceHost, section("Recent activity", activityHost, { actions: [link("#/transactions", "View all transactions", { class: "btn btn-link" })] })));
  if (!canRead("balance")) balanceHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "balance" }), "balance"));
  else {
    await load(balanceHost, async () => {
      const balance = await call("balance.retrieve", {});
      const currencies = [...new Set([...balance.available.map((row) => row.currency), ...balance.pending.map((row) => row.currency)])];
      if (currencies.length === 0) return empty("No balance yet", "Captured payments build up a balance per currency.");
      const cards = el("div", { class: "cards" });
      for (const currency of currencies) {
        const available = balance.available.find((row) => row.currency === currency)?.amount ?? 0;
        const pending = balance.pending.find((row) => row.currency === currency)?.amount ?? 0;
        cards.append(el("div", { class: "card" }, [el("div", { class: "card-label", text: `${currency.toUpperCase()} balance` }), el("div", { class: "card-value", text: money(available + pending, currency) }), el("div", { class: "balance-row" }, [el("span", { class: "muted", text: "Available" }), el("span", { text: money(available, currency) })]), el("div", { class: "balance-row" }, [el("span", { class: "muted", text: "Pending" }), el("span", { text: money(pending, currency) })]), el("div", { class: "balance-row" }, [el("span", { class: "muted", text: "Reserved" }), el("span", { text: money(balance.connect_reserved.find((row) => row.currency === currency)?.amount ?? 0, currency) })])]));
      }
      return [cards, alert("Payouts are not modelled by this synthetic account; the balance only grows and shrinks with captures and refunds.", "neutral", { iconName: "info" })];
    });
  }
  await renderActivity(activityHost, 10);
});

async function renderActivity(host, limit) {
  if (!canRead("charges")) {
    host.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "charges" }), "charges"));
    return;
  }
  await load(host, async () => {
    const charges = (await call("charges.list", { limit })).data;
    let refunds = [];
    if (canRead("refunds")) {
      try {
        refunds = (await call("refunds.list", { limit })).data;
      } catch {
        refunds = [];
      }
    }
    const rows = [...charges.map((charge) => ({ kind: "charge", at: charge.created, record: charge })), ...refunds.map((refund) => ({ kind: "refund", at: refund.created, record: refund }))].sort((left, right) => right.at - left.at).slice(0, limit);
    if (rows.length === 0) return empty("No activity yet");
    return transactionsTable(rows);
  });
}

function transactionsTable(rows) {
  return table({
    columns: [
      { label: "Type", class: "nowrap", render: (row) => (row.kind === "charge" ? el("span", { class: "amount-status" }, [icon("payments"), text(row.record.captured ? "Charge" : row.record.status === "failed" ? "Failed charge" : "Authorization")]) : el("span", { class: "amount-status" }, [icon("arrow-return"), text("Refund")])) },
      { label: "Amount", class: "nowrap", render: (row) => (row.kind === "charge" ? amountWithStatus(row.record.amount, row.record.currency, statusBadge(chargeStatus(row.record))) : amountWithStatus(-row.record.amount, row.record.currency, statusBadge(refundStatus(row.record)))) },
      { label: "Description", class: "truncate", render: (row) => (row.kind === "charge" ? row.record.description : row.record.reason ? humanize(row.record.reason) : "Refund") },
      { label: "Payment", render: (row) => link(`#/payments/${row.record.payment_intent}`, row.record.payment_intent ?? "—", { class: "link-quiet" }) },
      { label: "Method", class: "nowrap", render: (row) => (row.kind === "charge" && row.record.payment_method_details?.card ? cardChip({ card: row.record.payment_method_details.card }) : null) },
      { label: "Date", class: "nowrap", render: (row) => dateCell(row.at) },
    ],
    rows,
    href: (row) => `#/payments/${row.record.payment_intent}`,
    onOpen: (row) => navigate(`#/payments/${row.record.payment_intent}`),
  });
}

function chargeStatus(charge) {
  if (charge.status === "failed") return { label: "Failed", tone: "red", icon: "x-circle" };
  if (charge.refunded) return { label: "Refunded", tone: "gray", icon: "arrow-return" };
  if (charge.amount_refunded > 0) return { label: "Partial refund", tone: "gray", icon: "arrow-return" };
  if (!charge.captured) return { label: "Uncaptured", tone: "yellow", icon: "clock" };
  return { label: "Succeeded", tone: "green", icon: "check-circle" };
}

// ---------------------------------------------------------------------------------------------
// Transactions (charges + refunds)
// ---------------------------------------------------------------------------------------------

registerPage("transactions", async (host, route) => {
  setTitle("Transactions");
  const tab = route.params.tab ?? "all";
  const header = pageHeader("Transactions");
  const tabsHost = tabs([{ key: "all", label: "All activity" }, { key: "charges", label: "Charges" }, { key: "refunds", label: "Refunds" }], tab, (next) => navigate(`#/transactions${next === "all" ? "" : `?tab=${next}`}`));
  const listHost = el("div");
  const filters = el("div", { class: "filters" }, [chip("Date and time", { onClick: () => notSimulated("Date filter") }), chip("Amount", { onClick: () => notSimulated("Amount filter") }), chip("Type", { onClick: () => notSimulated("Type filter", "Use the tabs above to separate charges from refunds.") }), chip("More filters", { onClick: () => notSimulated("More filters") }), listTools()]);
  host.replaceChildren(pageInner(header, tabsHost, filters, listHost));
  if (tab === "refunds") {
    if (!canRead("refunds")) {
      listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "refunds" }), "refunds"));
      return;
    }
    listHost.append(pagedList({ operation: "refunds.list", args: {}, limit: 20, render: (refunds) => transactionsTable(refunds.map((refund) => ({ kind: "refund", at: refund.created, record: refund }))), emptyNode: () => empty("No refunds yet") }).element);
    return;
  }
  if (!canRead("charges")) {
    listHost.append(deniedPanel(new ToolError("tool_error", "tool.PERMISSION_DENIED", "", { group: "charges" }), "charges"));
    return;
  }
  if (tab === "charges") {
    listHost.append(pagedList({ operation: "charges.list", args: {}, limit: 20, render: (charges) => transactionsTable(charges.map((charge) => ({ kind: "charge", at: charge.created, record: charge }))), emptyNode: () => empty("No charges yet") }).element);
    return;
  }
  const streams = [{ operation: "charges.list", args: {}, map: (charge) => ({ kind: "charge", at: charge.created, record: charge }) }];
  if (canRead("refunds")) streams.push({ operation: "refunds.list", args: {}, map: (refund) => ({ kind: "refund", at: refund.created, record: refund }) });
  listHost.append(mergedList({ streams, render: transactionsTable, emptyNode: () => empty("No transactions yet", "Charges and refunds appear here."), note: "charges and refunds, newest first" }).element);
});

// ---------------------------------------------------------------------------------------------
// Developers
// ---------------------------------------------------------------------------------------------

const ROUTES = [
  ["GET", "/v1/balance"],
  ["POST", "/v1/customers"], ["GET", "/v1/customers"], ["GET", "/v1/customers/{id}"], ["POST", "/v1/customers/{id}"], ["GET", "/v1/customers/{id}/payment_methods"],
  ["GET", "/v1/payment_methods"], ["POST", "/v1/payment_methods/{id}/attach"], ["POST", "/v1/payment_methods/{id}/detach"],
  ["POST", "/v1/payment_intents"], ["GET", "/v1/payment_intents"], ["GET", "/v1/payment_intents/{id}"], ["POST", "/v1/payment_intents/{id}/confirm"], ["POST", "/v1/payment_intents/{id}/capture"], ["POST", "/v1/payment_intents/{id}/cancel"],
  ["GET", "/v1/charges"], ["GET", "/v1/charges/{id}"], ["POST", "/v1/refunds"], ["GET", "/v1/refunds"],
  ["POST", "/v1/products"], ["GET", "/v1/products"], ["GET", "/v1/products/{id}"], ["POST", "/v1/products/{id}"], ["POST", "/v1/prices"], ["GET", "/v1/prices"], ["GET", "/v1/prices/{id}"],
  ["POST", "/v1/invoiceitems"], ["POST", "/v1/invoices"], ["GET", "/v1/invoices"], ["GET", "/v1/invoices/{id}"], ["POST", "/v1/invoices/{id}/finalize"], ["POST", "/v1/invoices/{id}/pay"], ["POST", "/v1/invoices/{id}/void"],
  ["POST", "/v1/subscriptions"], ["GET", "/v1/subscriptions"], ["GET", "/v1/subscriptions/{id}"], ["POST", "/v1/subscriptions/{id}"], ["DELETE", "/v1/subscriptions/{id}"],
];

registerPage("developers", async (host) => {
  setTitle("Developers");
  const context = app.context;
  const header = pageHeader("Developers", { subtitle: "How to point an integration at this synthetic account." });
  const overview = section("Overview", kv([
    ["API version", el("code", { class: "id-code", text: context?.api_version ?? "—" })],
    ["Mode", context?.livemode ? "Live" : "Test (sandbox)"],
    ["Account", context?.account ? idChip(context.account.id) : null],
    ["Virtual time", context ? dateTime(context.now, undefined) : null],
    ["Secret key", el("span", { class: "muted", text: "The HTTP token printed by `firedrill serve` — never shown in this app." })],
  ]));
  const snippet = section("Connect an SDK", [
    el("p", { class: "muted", text: "Point the official SDK at the base URL and token that `firedrill serve` prints. Requests are form-encoded /v1 calls with a Bearer secret key and an optional Idempotency-Key header, answered with Stripe-shaped objects and error envelopes." }),
    el("pre", { class: "code-block", text: "# stripe-node\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { host, port, protocol }); // parsed from STRIPE_API_BASE\n\n# stripe-python\nstripe.api_base = os.environ[\"STRIPE_API_BASE\"]\n\n# curl\ncurl \"$STRIPE_API_BASE/v1/customers\" -H \"Authorization: Bearer $STRIPE_SECRET_KEY\" -d name=\"Jane Diaz\"" }),
  ]);
  const routes = section("Supported endpoints", el("ul", { class: "route-list inline-list" }, ROUTES.map(([method, path]) => el("li", {}, [el("span", { class: `method method-${method.toLowerCase()}`, text: method }), el("code", { text: path })]))), { count: ROUTES.length });
  const mcp = section("MCP", el("p", { class: "muted", text: "The same operations are exposed as MCP tools under their canonical names (stripe.<operation>) and as the per-resource tool names of the Stripe agent toolkit (create_customer, list_invoices, create_refund, …)." }));
  host.replaceChildren(pageInner(header, alert("Everything on this page is served by Firedrill: no request leaves the machine, no card network is contacted and no e-mail is sent.", "info"), overview, snippet, routes, mcp));
});

// ---------------------------------------------------------------------------------------------
// Settings (business details)
// ---------------------------------------------------------------------------------------------

registerPage("settings", async (host) => {
  setTitle("Settings");
  const account = app.context?.account;
  const header = pageHeader("Settings", { subtitle: "Business details of the simulated account (read-only in this synthetic account)." });
  host.replaceChildren(pageInner(header, section("Business details", kv([
    ["Business name", account?.business_name],
    ["Account ID", account ? idChip(account.id) : null],
    ["Country", account?.country],
    ["Default currency", account?.default_currency?.toUpperCase()],
    ["Statement descriptor", account?.statement_descriptor],
    ["Support email", account?.support_email],
  ])), section("Your key", kv([
    ["Actor", app.connection?.actorId],
    ["Permissions", el("div", { class: "inline-list" }, Object.entries(app.context?.permissions ?? {}).map(([group, level]) => el("div", { class: "balance-row" }, [el("span", { text: humanize(group) }), el("span", { class: level === "none" ? "muted" : "", text: level })])))],
  ]))));
});

