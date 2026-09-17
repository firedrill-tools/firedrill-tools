// Identity and permission flows: Read Only role, unknown and disabled users, fresh-install fallback, framework denial.
import { D, M, NOW, U } from "./seed.mjs";

const ALL_OPERATIONS = {
  "monitors.list": {}, "monitors.search": {}, "monitors.get": { monitor_id: String(M.latency) }, "monitors.create": { type: "metric alert", query: "avg(last_5m):avg:system.cpu.user{*} > 95" },
  "monitors.update": { monitor_id: String(M.staging), name: "x" }, "monitors.delete": { monitor_id: String(M.staging) }, "monitors.validate": { type: "metric alert", query: "avg(last_5m):avg:system.cpu.user{*} > 95" },
  "events.create": { title: "t", text: "x" }, "events.list": { start: NOW - 3600, end: NOW }, "events.get": { event_id: "7412300000000001" },
  "metrics.submit": { series: [{ metric: "system.cpu.user", points: [{ timestamp: NOW, value: 1 }] }] }, "metrics.query": { from: NOW - 600, to: NOW, query: "avg:system.cpu.user{*}" },
  "metrics.list_active": { from: NOW - 3600 }, "metrics.get_metadata": { metric_name: "system.cpu.user" },
  "dashboards.list": {}, "dashboards.get": { dashboard_id: D.checkout }, "dashboards.create": { title: "x", layout_type: "ordered", widgets: [] },
  "dashboards.update": { dashboard_id: D.infra, title: "x", layout_type: "free", widgets: [] }, "dashboards.delete": { dashboard_id: D.infra },
  "incidents.create": { data: { type: "incidents", attributes: { title: "x", customer_impacted: false } } }, "incidents.list": {}, "incidents.search": { query: "state:active" },
  "incidents.get": { incident_id: "41" }, "incidents.update": { incident_id: "41", data: { type: "incidents", attributes: { title: "x" } } }, "org.context": {},
};
const WRITES = ["monitors.create", "monitors.update", "monitors.delete", "events.create", "metrics.submit", "dashboards.create", "dashboards.update", "dashboards.delete", "incidents.create", "incidents.update"];

export const identityFlows = {
  async readonly({ api, ok, fails, qs, assert }) {
    const context = await ok("org.context");
    assert.equal(context.user.role, "Datadog Read Only Role");
    assert.equal(context.permissions.monitors_write, false);
    const monitors = (await api("GET", "/api/v1/monitor")).body;
    assert.equal(monitors.length, 9);
    await ok("monitors.validate", ALL_OPERATIONS["monitors.validate"]);
    for (const operation of WRITES) await fails(operation, ALL_OPERATIONS[operation], "FORBIDDEN", "required permission");
    await api("POST", "/api/v1/monitor", { body: ALL_OPERATIONS["monitors.create"], status: 403, contains: "Forbidden" });
    await api("POST", "/api/v2/series", { body: ALL_OPERATIONS["metrics.submit"], status: 403 });
    assert.equal((await api("GET", "/api/v1/monitor")).body.length, 9);
    assert.equal((await api("GET", `/api/v1/dashboard${qs({})}`)).body.dashboards.length, 3);
  },
  async ghost({ api, fails }) {
    for (const [operation, args] of Object.entries(ALL_OPERATIONS)) await fails(operation, args, "FORBIDDEN");
    await api("GET", "/api/v1/monitor", { status: 403, contains: "Forbidden" });
    await api("GET", `/api/v2/incidents/${"41"}`, { status: 403 });
  },
  async disabled({ api, fails }) {
    await fails("org.context", {}, "FORBIDDEN");
    await fails("monitors.search", { query: "status:alert" }, "FORBIDDEN");
    await api("GET", `/api/v1/dashboard/${D.checkout}`, { status: 403 });
  },
  async "fresh-install"({ api, ok, assert }) {
    const context = await ok("org.context");
    assert.equal(context.user.handle, "priya.raman@example.com");
    assert.equal(context.user.uuid, U.priya);
    assert.equal(context.now, "2026-09-15T14:00:00.000Z");
    const search = await ok("monitors.search", {});
    assert.equal(search.metadata.total_count, 9);
    const incidents = (await api("GET", "/api/v2/incidents")).body;
    assert.equal(incidents.data.length, 4);
  },
  async denied({ api, canonical, assert }) {
    const read = await canonical("monitors.list", {});
    assert.equal(read.status, "denied");
    const write = await canonical("events.create", { title: "t", text: "x" });
    assert.equal(write.status, "denied");
    const response = await api("GET", "/api/v1/monitor", { status: 403 });
    assert.ok(response.body.errors[0].includes("not granted"));
  },
};
