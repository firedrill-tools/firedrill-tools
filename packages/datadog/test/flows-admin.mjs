// Monitors (admin), dashboards (standard) and hostile-input (admin) flows.
import { D, M, NOW } from "./seed.mjs";

const Q = (query) => encodeURIComponent(query);

export const adminFlows = {
  async monitors({ api, ok, fails, qs, assert }) {
    assert.equal((await api("GET", "/api/v1/monitor")).body.length, 9);
    const page0 = (await api("GET", `/api/v1/monitor${qs({ page: 0, page_size: 4 })}`)).body;
    assert.deepEqual(page0.map((m) => m.id), [M.latency, M.cpu, M.disk, M.payments]);
    assert.deepEqual((await api("GET", `/api/v1/monitor${qs({ page: 2, page_size: 4 })}`)).body.map((m) => m.id), [M.staging]);
    assert.deepEqual((await api("GET", `/api/v1/monitor${qs({ name: "cpu" })}`)).body.map((m) => m.id), [M.cpu, M.staging]);
    assert.equal((await api("GET", `/api/v1/monitor${qs({ monitor_tags: "team:checkout" })}`)).body.length, 4);
    assert.deepEqual((await api("GET", `/api/v1/monitor${qs({ tags: "env:prod" })}`)).body.map((m) => m.id), [M.latency, M.cpu]);
    await api("GET", `/api/v1/monitor${qs({ page_size: 0, page: 0 })}`, { status: 400 });
    const alerting = await ok("monitors.search", { query: "status:alert", sort: "id,asc" });
    assert.deepEqual(alerting.monitors.map((m) => m.id), [M.latency, M.payments, M.composite]);
    assert.equal((await ok("monitors.search", { query: "tag:\"team:checkout\"" })).metadata.total_count, 4);
    assert.deepEqual((await ok("monitors.search", { query: "muted:true" })).monitors.map((m) => m.id), [M.payments]);
    assert.equal((await ok("monitors.search", { query: "type:composite" })).monitors[0].id, M.composite);
    const all = await ok("monitors.search", { query: "", per_page: 4, page: 1, sort: "id,desc" });
    assert.deepEqual(all.metadata, { page: 1, page_count: 3, per_page: 4, total_count: 9 });
    assert.deepEqual(all.counts.status.find((f) => f.name === "alert"), { name: "alert", count: 3 });
    assert.equal((await ok("monitors.search", { query: "(status:warn OR status:\"no data\") prod" })).monitors[0].id, M.cpu);
    await fails("monitors.search", { query: "status:broken" }, "BAD_REQUEST");
    const latency = (await api("GET", `/api/v1/monitor/${M.latency}${qs({ group_states: "alert" })}`)).body;
    assert.deepEqual(Object.keys(latency.state.groups), ["host:web-02"]);
    await api("GET", "/api/v1/monitor/148599999", { status: 404, contains: "Monitor not found" });
    await api("GET", "/api/v1/monitor/abc", { status: 404 });
    await fails("monitors.get", { monitor_id: String(M.latency), group_states: "bogus" }, "BAD_REQUEST");
    const valid = { type: "metric alert", query: "avg(last_5m):avg:checkout.request.latency{host:web-02} > 850" };
    assert.deepEqual((await api("POST", "/api/v1/monitor/validate", { body: valid })).body, {});
    await api("POST", "/api/v1/monitor/validate", { body: { ...valid, options: { thresholds: { critical: 900 } } }, status: 400, contains: "does not match" });
    await api("POST", "/api/v1/monitor/validate", { body: { ...valid, options: { thresholds: { critical: 850, warning: 900 } } }, status: 400, contains: "Warning threshold" });
    await api("POST", "/api/v1/monitor/validate", { body: { ...valid, query: "avg(last_2w):avg:x{*} > 1" }, status: 400 });
    await api("POST", "/api/v1/monitor/validate", { body: { type: "composite", query: `${M.latency} && 148599999` }, status: 404 });
    const created = (await api("POST", "/api/v1/monitor", { body: { ...valid, name: "web-02 latency critical", tags: ["team:checkout"], message: "{{#is_alert}}{{value}} ms{{/is_alert}}" } })).body;
    assert.equal(created.id, 148500010);
    assert.equal(created.overall_state, "Alert");
    await api("POST", "/api/v1/monitor", { body: { ...valid, id: 5 }, status: 400, contains: "read-only" });
    await fails("monitors.create", { type: "composite", query: `${M.latency} || 148599999` }, "NOT_FOUND");
    const raised = (await api("PUT", `/api/v1/monitor/${created.id}`, { body: { query: valid.query.replace("850", "950"), options: { thresholds: { critical: 950 } } } })).body;
    assert.equal(raised.overall_state, "OK");
    await api("PUT", `/api/v1/monitor/${created.id}`, { body: { type: "composite" }, status: 400 });
    await api("PUT", "/api/v1/monitor/148599999", { body: { name: "x" }, status: 404 });
    const history = (await api("GET", `/api/v1/events${qs({ start: NOW - 60, end: NOW, tags: `monitor:${created.id}`, unaggregated: true })}`)).body.events;
    assert.deepEqual(history.map((e) => e.title), ["[Recovered] web-02 latency critical", "[Triggered] web-02 latency critical"]);
    await api("DELETE", `/api/v1/monitor/${M.payments}`, { status: 400, contains: "referenced in composite" });
    await api("DELETE", `/api/v1/monitor/${M.payments}${qs({ force: "maybe" })}`, { status: 400 });
    assert.deepEqual((await api("DELETE", `/api/v1/monitor/${M.payments}${qs({ force: "true" })}`)).body, { deleted_monitor_id: M.payments });
    assert.equal((await ok("monitors.get", { monitor_id: String(M.composite) })).overall_state, "No Data");
    await api("DELETE", `/api/v1/monitor/${M.payments}`, { status: 404 });
    assert.equal((await api("PUT", `/api/v1/monitor/${M.disk}`, { body: { priority: 2 } })).body.priority, 2);
    const board = (await api("GET", `/api/v1/dashboard/${D.payments}`)).body;
    const widgets = board.widgets.map(({ definition, layout }) => ({ definition, ...(layout ? { layout } : {}) }));
    assert.equal((await api("PUT", `/api/v1/dashboard/${D.payments}`, { body: { title: "Payments (restricted)", layout_type: "ordered", widgets, restricted_roles: ["Datadog Admin Role"], is_read_only: true, tags: ["team:payments"] } })).body.title, "Payments (restricted)");
  },
  async dashboards({ api, ok, fails, qs, assert }) {
    const listed = (await api("GET", `/api/v1/dashboard${qs({ count: 2 })}`)).body;
    assert.equal(listed.dashboards.length, 2);
    assert.equal(listed.total_rows, 3);
    assert.equal((await api("GET", `/api/v1/dashboard${qs({ count: 2, start: 2 })}`)).body.dashboards.length, 1);
    assert.deepEqual((await api("GET", `/api/v1/dashboard${qs({ "filter[deleted]": true })}`)).body.dashboards.map((d) => d.id), [D.old]);
    await api("GET", `/api/v1/dashboard${qs({ count: 0 })}`, { status: 400 });
    assert.equal((await ok("dashboards.list", { query: "infra" })).dashboards[0].id, D.infra);
    assert.equal((await api("GET", `/api/v1/dashboard/${D.checkout}`)).body.widgets.length, 4);
    await api("GET", "/api/v1/dashboard/zzz-zzz-zzz", { status: 404, contains: "Dashboard not found" });
    await api("GET", `/api/v1/dashboard/${D.old}`, { status: 404 });
    const body = {
      title: "Checkout drill board", layout_type: "ordered", tags: ["team:checkout"], template_variables: [{ name: "host", prefix: "host", available_values: [], defaults: ["web-01"] }],
      widgets: [
        { definition: { type: "note", content: "Drill notes" } },
        { definition: { type: "query_value", title: "p95", requests: [{ q: "avg:checkout.request.latency{$host}", aggregator: "last" }], precision: 1 } },
        { definition: { type: "timeseries", title: "Latency", requests: [{ queries: [{ data_source: "metrics", name: "q1", query: "avg:checkout.request.latency{*} by {host}" }], formulas: [{ formula: "q1" }] }] } },
        { definition: { type: "toplist", title: "CPU", requests: [{ q: "max:system.cpu.user{*} by {host}" }] } },
      ],
    };
    const created = (await api("POST", "/api/v1/dashboard", { body })).body;
    assert.match(created.id, /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/);
    assert.equal(created.url, `/dashboard/${created.id}/checkout-drill-board`);
    assert.deepEqual(created.widgets.map((w) => w.definition.type), ["note", "query_value", "timeseries", "toplist"]);
    await api("POST", "/api/v1/dashboard", { body: { ...body, layout_type: "free" }, status: 400, contains: "layout" });
    await api("POST", "/api/v1/dashboard", { body: { ...body, widgets: [{ definition: { type: "heatmap" } }] }, status: 400, contains: "Invalid widget definition" });
    await api("POST", "/api/v1/dashboard", { body: { ...body, tags: ["env:prod"] }, status: 400 });
    await api("POST", "/api/v1/dashboard", { body: { ...body, widgets: [{ definition: { type: "toplist", requests: [{ q: "avg:x" }] } }] }, status: 400, contains: "Error parsing query" });
    const updated = (await api("PUT", `/api/v1/dashboard/${created.id}`, { body: { ...body, title: "Checkout drill board v2", widgets: body.widgets.slice(0, 1) } })).body;
    assert.equal((await ok("dashboards.get", { dashboard_id: created.id })).title, "Checkout drill board v2");
    assert.equal(updated.widgets.length, 1);
    await api("PUT", "/api/v1/dashboard/zzz-zzz-zzz", { body, status: 404 });
    await api("PUT", `/api/v1/dashboard/${created.id}`, { body: { ...body, reflow_type: "sideways" }, status: 400, contains: "reflow_type" });
    await api("PUT", `/api/v1/dashboard/${D.payments}`, { body, status: 403, contains: "restricted" });
    await api("DELETE", `/api/v1/dashboard/${D.payments}`, { status: 403 });
    assert.deepEqual((await api("DELETE", `/api/v1/dashboard/${created.id}`)).body, { deleted_dashboard_id: created.id });
    await api("DELETE", `/api/v1/dashboard/${created.id}`, { status: 404 });
    assert.equal((await api("GET", `/api/v1/dashboard${qs({ "filter[deleted]": "true" })}`)).body.dashboards.length, 2);
    await fails("dashboards.create", { title: "x", layout_type: "grid", widgets: [] }, "BAD_REQUEST");
  },
  async "hostile-input"({ api, fails, assert }) {
    const base = { type: "metric alert", query: "avg(last_5m):avg:system.cpu.user{*} > 95" };
    await api("POST", "/api/v1/monitor", { body: { ...base, tags: ["__proto__:x"] }, status: 400, contains: "reserved" });
    await api("POST", "/api/v1/monitor", { body: { ...base, options: { silenced: { constructor: null } } }, status: 400 });
    await fails("monitors.create", { ...base, options: { thresholds: { critical: 95, prototype: 1 } } }, "BAD_REQUEST");
    const deep = `{"type":"metric alert","query":"x","options":${"[".repeat(600)}${"]".repeat(600)}}`;
    await api("POST", "/api/v1/monitor", { raw: deep, status: 400 });
    await api("GET", `/api/v1/query?from=${NOW - 60}&to=${NOW}&query=avg:system.cpu.user%7Bhost:%E0%A4%7D`, { status: 400 });
    // Malformed percent-encoding reaches the Tool as U+FFFD (a correctly encoded %EF%BF%BD is rejected too); %ZZ stays literal.
    for (const path of [`/api/v1/events?start=${NOW - 3600}&end=${NOW}&tags=env:prod%E0%A4%A`, `/api/v1/events?start=${NOW - 3600}&end=${NOW}&sources=my_apps%EF%BF%BD`,
      "/api/v1/monitor?name=cpu%E0%A4%A", "/api/v1/monitor?tags=env:prod%E0%A4%A", "/api/v1/monitor?monitor_tags=team%E0%A4%A",
      `/api/v1/metrics?from=${NOW - 3600}&host=web%E0%A4%A`, `/api/v1/metrics?from=${NOW - 3600}&tag_filter=env:prod%E0%A4%A`]) {
      await api("GET", path, { status: 400, contains: "malformed encoding" });
    }
    for (const [operation, args] of [["monitors.search", { query: "cpu\uFFFD" }], ["incidents.search", { query: "state:active\uFFFD" }], ["dashboards.list", { query: "x\uFFFD" }]]) {
      const mangled = await fails(operation, args, "BAD_REQUEST");
      assert.match(mangled.error.message, /malformed encoding/);
    }
    assert.equal((await api("GET", "/api/v1/monitor?name=cpu%ZZ")).body.length, 0, "%ZZ stays literal");
    await api("GET", "/api/v1/monitor?name=caf%C3%A9%20%E6%BC%A2%E5%AD%97%20%F0%9F%94%A5");
    await api("GET", `/api/v1/monitor/${"9".repeat(600)}`, { status: 404 });
    await api("GET", `/api/v1/dashboard/${"a".repeat(600)}`, { status: 404 });
    await api("GET", `/api/v2/incidents/${"b".repeat(600)}`, { status: 404 });
    await api("GET", `/api/v1/metrics/${"m".repeat(600)}`, { status: 400, contains: "Invalid metric name" });
    await api("POST", "/api/v2/series", { body: { series: [{ metric: "a", points: [{ timestamp: NOW, value: 1 }] }] }, headers: { "content-encoding": "gzip" }, status: 400 });
    const search = await fails("monitors.search", { query: "name:\"unterminated" }, "BAD_REQUEST");
    assert.ok(search.error.message.length < 200);
    assert.equal((await api("GET", "/api/v1/monitor")).body.length, 9);
  },
};
