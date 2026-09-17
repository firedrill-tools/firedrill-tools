// Fault and bound flows: intake rate limit (before), incident outage (after_commit), lowered state bounds.
import { D, M, NOW, U } from "./seed.mjs";

const LATENCY_BY_HOST = "avg(last_5m):avg:checkout.request.latency{env:prod,service:checkout} by {host} > 800";

export const faultFlows = {
  async "intake-rate-limited"({ api, ok, assert }) {
    const body = { series: [{ metric: "checkout.request.latency", type: 3, points: [{ timestamp: NOW, value: 2000 }], tags: ["env:prod", "service:checkout", "region:us-east-1"], resources: [{ name: "web-01", type: "host" }] }] };
    const limited = await api("POST", "/api/v2/series", { body, status: 429, contains: "Rate limit" });
    assert.equal(limited.headers.get("x-ratelimit-limit"), "1000");
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(limited.headers.get("x-ratelimit-name"), "metrics_submit");
    await api("POST", "/api/v2/series", { body, status: 429 });
    const monitor = await ok("monitors.get", { monitor_id: String(M.latency), group_states: "all" });
    assert.equal(monitor.state.groups["host:web-01"].status, "OK");
    const query = (await api("GET", `/api/v1/query?from=${NOW - 60}&to=${NOW}&query=${encodeURIComponent("max:checkout.request.latency{host:web-01}")}`)).body;
    assert.ok(query.series[0].pointlist.every(([, value]) => value < 1000));
  },
  async "incidents-outage"({ api, ok, assert }) {
    const body = { data: { type: "incidents", attributes: { title: "Payments API returning 500s", customer_impacted: true, customer_impact_scope: "Card payments fail", fields: { severity: { type: "dropdown", value: "SEV-2" } } } } };
    await api("POST", "/api/v2/incidents", { body, status: 503, contains: "Service Unavailable" });
    const found = await ok("incidents.search", { query: "Payments" });
    assert.equal(found.data.attributes.total, 1);
    assert.equal(found.data.attributes.incidents[0].data.attributes.public_id, 42);
    await api("POST", "/api/v2/incidents", { body, status: 503 });
    const again = await ok("incidents.search", { query: "Payments API" });
    assert.equal(again.data.attributes.total, 2);
  },
  async "tight-limits"({ api, ok, fails, qs }) {
    const bound = "supported bound";
    await fails("monitors.list", {}, "LIMIT_EXCEEDED", bound);
    await api("GET", "/api/v1/monitor", { status: 400, contains: bound });
    await fails("monitors.search", { query: "" }, "LIMIT_EXCEEDED", bound);
    await fails("monitors.create", { type: "query alert", query: LATENCY_BY_HOST.replace("> 800", "> 900"), options: { thresholds: { critical: 900 } } }, "LIMIT_EXCEEDED");
    await fails("monitors.update", { monitor_id: String(M.latency), options: { renotify_interval: 10 } }, "LIMIT_EXCEEDED");
    for (let i = 0; i < 4; i += 1) {
      await ok("monitors.create", { name: `Staging composite ${i}`, type: "composite", query: `${M.staging} || ${M.disk}` });
    }
    await fails("monitors.delete", { monitor_id: String(M.staging), force: "true" }, "LIMIT_EXCEEDED", bound);
    await fails("events.list", { start: NOW - 86400, end: NOW }, "LIMIT_EXCEEDED", bound);
    await fails("metrics.submit", { series: [{ metric: "checkout.request.latency", type: 3, points: [{ timestamp: NOW, value: 500 }], tags: ["env:prod", "service:checkout", "region:us-east-1"], resources: [{ name: "web-01", type: "host" }] }] }, "LIMIT_EXCEEDED");
    await fails("metrics.query", { from: NOW - 600, to: NOW, query: "avg:checkout.request.latency{*} by {host}" }, "LIMIT_EXCEEDED");
    await fails("metrics.list_active", { from: NOW - 3600 }, "LIMIT_EXCEEDED", bound);
    await fails("dashboards.list", {}, "LIMIT_EXCEEDED", bound);
    const note = { definition: { type: "note", content: "n".repeat(3000) } };
    await fails("dashboards.create", { title: "Too big", layout_type: "ordered", widgets: [note] }, "LIMIT_EXCEEDED", "supported size");
    await fails("dashboards.update", { dashboard_id: D.infra, title: "Too big", layout_type: "ordered", widgets: [note] }, "LIMIT_EXCEEDED", "supported size");
    const commander = { commander_user: { data: { type: "users", id: U.marco } } };
    await fails("incidents.create", { data: { type: "incidents", attributes: { title: "x", customer_impacted: false }, relationships: commander } }, "LIMIT_EXCEEDED", bound);
    await fails("incidents.list", { "page[size]": 2 }, "LIMIT_EXCEEDED", bound);
    await fails("incidents.search", { query: "state:active" }, "LIMIT_EXCEEDED", bound);
    const incident = await ok("incidents.get", { incident_id: "41" });
    await fails("incidents.update", { incident_id: "41", data: { type: "incidents", id: incident.data.id, relationships: commander } }, "LIMIT_EXCEEDED", bound);
    await api("GET", `/api/v1/dashboard${qs({ count: 1 })}`, { status: 400 });
  },
};
