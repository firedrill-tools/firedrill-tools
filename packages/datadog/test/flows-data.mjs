// Metrics (standard) and events (standard) flows; the incidents flow lives in ./flows-incidents.mjs.
import { incidentFlows } from "./flows-incidents.mjs";
import { M, NOW } from "./seed.mjs";

const web01 = (value, offsets) => ({
  metric: "checkout.request.latency", type: 3, unit: "millisecond", tags: ["env:prod", "service:checkout", "region:us-east-1"], resources: [{ name: "web-01", type: "host" }],
  points: offsets.map((offset) => ({ timestamp: NOW - offset, value })),
});

export const dataFlows = {
  ...incidentFlows,
  async metrics({ api, ok, fails, qs, assert }) {
    const window = [240, 180, 120, 60, 0];
    assert.deepEqual((await api("POST", "/api/v2/series", { body: { series: [web01(1500, window)] }, status: 202 })).body, { errors: [] });
    const query = (await api("GET", `/api/v1/query${qs({ from: NOW - 300, to: NOW, query: "max:checkout.request.latency{env:prod,!host:web-03,region:us-*} by {host}.rollup(max, 60)" })}`)).body;
    assert.deepEqual(query.group_by, ["host"]);
    assert.deepEqual(query.series.map((s) => s.tag_set), [["host:web-01"], ["host:web-02"]]);
    assert.equal(query.series[0].interval, 60);
    assert.equal(query.series[0].pointlist.at(-1)[1], 1500);
    assert.deepEqual(query.series[0].unit[0].short_name, "ms");
    const filled = (await api("GET", `/api/v1/query${qs({ from: NOW - 3600, to: NOW, query: "sum:payments.errors{*}.rollup(sum, 600).fill(zero)" })}`)).body.series[0];
    assert.equal(filled.pointlist.length, 7);
    const monitor = await ok("monitors.get", { monitor_id: String(M.latency), group_states: "all" });
    assert.equal(monitor.state.groups["host:web-01"].status, "Alert");
    const triggered = (await api("GET", `/api/v1/events${qs({ start: NOW - 60, end: NOW, tags: `monitor:${M.latency}`, unaggregated: "true" })}`)).body.events;
    assert.equal(triggered[0].title, "[Triggered on host:web-01] Checkout p95 latency high on web-01");
    assert.ok(triggered[0].text.startsWith("Latency on web-01 is "));
    await api("POST", "/api/v2/series", { body: { series: [web01(100, [300, ...window])] }, status: 202 });
    assert.equal((await ok("monitors.get", { monitor_id: String(M.latency), group_states: "all" })).state.groups["host:web-01"].status, "OK");
    await api("POST", "/api/v2/series", { body: { series: [{ ...web01(1, [0]), metric: "1bad" }] }, status: 400, contains: "Invalid metric name" });
    await api("POST", "/api/v2/series", { body: { series: [{ ...web01(1, [0]), points: [{ timestamp: NOW, value: "high" }] }] }, status: 400 });
    await fails("metrics.submit", { series: [{ ...web01(1, [0]), type: 7 }] }, "BAD_REQUEST");
    const many = Array.from({ length: 1001 }, () => ({ metric: "a", points: [{ timestamp: NOW, value: 1 }] }));
    await api("POST", "/api/v2/series", { body: { series: many }, status: 413, contains: "Payload too large" });
    await api("POST", "/api/v2/series", { body: { series: [{ metric: "probe.stale", type: 3, points: [{ timestamp: NOW - 7200, value: 5 }] }] }, status: 202 });
    await api("GET", "/api/v1/metrics/probe.stale", { status: 404, contains: "Metric not found" });
    assert.deepEqual((await api("GET", `/api/v1/metrics${qs({ from: NOW - 3600, host: "web-01" })}`)).body.metrics, ["checkout.request.latency", "system.cpu.user"]);
    assert.deepEqual((await api("GET", `/api/v1/metrics${qs({ from: NOW - 3600, tag_filter: "env:staging" })}`)).body, { metrics: ["system.cpu.user"], from: String(NOW - 3600) });
    await api("GET", `/api/v1/metrics${qs({ from: NOW, tag_filter: "{" })}`, { status: 400 });
    await api("GET", "/api/v1/metrics", { status: 400 });
    assert.equal((await api("GET", "/api/v1/metrics/system.cpu.user")).body.unit, "percent");
    await api("GET", "/api/v1/metrics/bad!name", { status: 400 });
    await api("GET", `/api/v1/query${qs({ from: NOW - 60, to: NOW, query: "avg:system.cpu.user" })}`, { status: 400, contains: "Error parsing query" });
    await api("GET", `/api/v1/query${qs({ from: NOW, to: NOW, query: "avg:system.cpu.user{*}" })}`, { status: 400 });
    assert.equal((await ok("metrics.query", { from: NOW - 600, to: NOW, query: "avg:no.such.metric{*}" })).series.length, 0);
  },
  async events({ api, ok, fails, qs, assert }) {
    const posted = (await api("POST", "/api/v1/events", { body: { title: "Rollback checkout 2026.09.15-3", text: "Rolling back after latency alert.", tags: ["service:checkout", "env:prod"], source_type_name: "deploy", aggregation_key: "deploy-checkout", alert_type: "warning" }, status: 202 })).body;
    assert.equal(posted.status, "ok");
    assert.equal(posted.event.id_str, String(posted.event.id));
    assert.equal((await api("GET", `/api/v1/events/${posted.event.id}`)).body.event.title, "Rollback checkout 2026.09.15-3");
    await api("GET", "/api/v1/events/7412399999999999", { status: 404, contains: "Event not found" });
    await api("POST", "/api/v1/events", { body: { title: "old", text: "x", date_happened: NOW - 20 * 3600 }, status: 400 });
    await api("POST", "/api/v1/events", { body: { title: "t".repeat(101), text: "x" }, status: 400 });
    await api("POST", "/api/v1/events", { body: { title: "t", text: "x", alert_type: "panic" }, status: 400 });
    await fails("events.create", { title: "t", text: "x", related_event_id: 7412399999999999 }, "BAD_REQUEST");
    const day = { start: NOW - 86400, end: NOW };
    const flat = (await api("GET", `/api/v1/events${qs({ ...day, unaggregated: true })}`)).body.events;
    const grouped = (await api("GET", `/api/v1/events${qs(day)}`)).body.events;
    assert.equal(flat.length, 13);
    assert.ok(grouped.length < flat.length);
    const deploys = (await api("GET", `/api/v1/events${qs({ ...day, sources: "deploy" })}`)).body.events;
    assert.equal(deploys[0].id, posted.event.id);
    assert.equal(deploys[0].children.length, 2);
    assert.ok((await api("GET", `/api/v1/events${qs({ ...day, exclude_aggregate: true })}`)).body.events.every((e) => !e.is_aggregate));
    assert.deepEqual((await api("GET", `/api/v1/events${qs({ ...day, priority: "low" })}`)).body.events.map((e) => e.title), ["Feature flag checkout-v2 at 25%"]);
    assert.ok((await ok("events.list", { ...day, tags: "service:checkout,env:prod", unaggregated: true })).events.every((e) => e.tags.includes("env:prod")));
    assert.deepEqual((await api("GET", `/api/v1/events${qs({ start: NOW - 40 * 86400, end: NOW - 31 * 86400 })}`)).body.events.map((e) => e.title), ["Quarterly failover test"]);
    await api("GET", `/api/v1/events${qs({ end: NOW })}`, { status: 400 });
    await api("GET", `/api/v1/events${qs({ start: NOW - 33 * 86400, end: NOW })}`, { status: 400, contains: "32 days" });
  },
};
