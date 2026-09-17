// Incidents flow (standard role): declare, list, search, get, update and resolve.
import { U, UNKNOWN_UUID } from "./seed.mjs";

const dropdown = (value) => ({ type: "dropdown", value });

export const incidentFlows = {
  async incidents({ api, ok, fails, qs, assert }) {
    const body = {
      data: {
        type: "incidents",
        attributes: { title: "Checkout 502s from the EU edge", customer_impacted: true, customer_impact_scope: "EU customers see intermittent 502", fields: { severity: dropdown("SEV-3") } },
        relationships: { commander_user: { data: { type: "users", id: U.priya } } },
      },
    };
    const created = (await api("POST", "/api/v2/incidents", { body, status: 201 })).body;
    const id = created.data.id;
    assert.equal(created.data.attributes.public_id, 42);
    assert.equal(created.data.attributes.state, "active");
    assert.equal(created.data.relationships.commander_user.data.id, U.priya);
    assert.ok(created.included.some((user) => user.attributes.handle === "marco.silva@example.com"));
    await api("POST", "/api/v2/incidents", { body: { data: { type: "incidents", attributes: { title: "x" } } }, status: 400, contains: "customer_impacted" });
    await api("POST", "/api/v2/incidents", { body: { data: { type: "incidents", attributes: { title: "x", customer_impacted: true } } }, status: 400, contains: "customer_impact_scope" });
    await api("POST", "/api/v2/incidents", { body: { data: { ...body.data, relationships: { commander_user: { data: { type: "users", id: UNKNOWN_UUID } } } } }, status: 404, contains: "User not found" });
    const first = (await api("GET", `/api/v2/incidents${qs({ "page[size]": 2, include: "users" })}`)).body;
    assert.deepEqual(first.data.map((i) => i.attributes.public_id), [42, 41]);
    assert.deepEqual(first.meta.pagination, { offset: 0, next_offset: 2, size: 2 });
    assert.ok(first.included.length >= 2);
    const tail = (await api("GET", `/api/v2/incidents${qs({ "page[size]": 2, "page[offset]": 4 })}`)).body;
    assert.deepEqual(tail.data.map((i) => i.attributes.public_id), [38]);
    assert.deepEqual(tail.meta.pagination, { offset: 4, next_offset: 5, size: 2 });
    await api("GET", `/api/v2/incidents${qs({ "page[size]": 0 })}`, { status: 400 });
    const active = await ok("incidents.search", { query: "state:active" });
    assert.equal(active.data.attributes.total, 2);
    assert.deepEqual(active.data.attributes.facets.severity, [{ name: "SEV-2", count: 1 }, { name: "SEV-3", count: 1 }]);
    assert.equal((await ok("incidents.search", { query: "severity:SEV-1" })).data.attributes.incidents[0].data.attributes.public_id, 39);
    assert.equal((await ok("incidents.search", { query: "checkout", sort: "created" })).data.attributes.total, 4);
    assert.equal((await ok("incidents.search", { query: "(state:active OR state:stable) customer_impacted:false" })).data.attributes.total, 1);
    await fails("incidents.search", { query: "priority:high" }, "BAD_REQUEST");
    assert.equal((await api("GET", `/api/v2/incidents/${id}`)).body.data.attributes.title, "Checkout 502s from the EU edge");
    assert.equal((await api("GET", "/api/v2/incidents/42")).body.data.id, id);
    await api("GET", `/api/v2/incidents/${UNKNOWN_UUID}`, { status: 404, contains: "Incident not found" });
    await api("GET", `/api/v2/incidents/41${qs({ include: "todos" })}`, { status: 400 });
    const patch = (attributes) => ({ data: { type: "incidents", id, attributes } });
    assert.equal((await api("PATCH", `/api/v2/incidents/${id}`, { body: patch({ fields: { severity: dropdown("SEV-2") } }) })).body.data.attributes.severity, "SEV-2");
    const resolved = (await api("PATCH", `/api/v2/incidents/${id}`, { body: patch({ fields: { state: dropdown("resolved") } }) })).body.data.attributes;
    assert.equal(resolved.state, "resolved");
    assert.equal(resolved.resolved, "2026-09-15T14:00:00.000Z");
    assert.equal(resolved.customer_impact_end, "2026-09-15T14:00:00.000Z");
    await api("PATCH", `/api/v2/incidents/${id}`, { body: { data: { type: "incidents", id: UNKNOWN_UUID, attributes: { title: "x" } } }, status: 400, contains: "does not match" });
    await api("PATCH", `/api/v2/incidents/${UNKNOWN_UUID}`, { body: patch({ title: "x" }), status: 404 });
    await api("PATCH", `/api/v2/incidents/${id}`, { body: patch({ customer_impact_start: "2026-09-15T13:00:00Z", customer_impact_end: "2026-09-15T12:00:00Z" }), status: 400 });
    await api("PATCH", `/api/v2/incidents/${id}`, { body: patch({ customer_impact_start: "2026-09-15T13:00:00" }), status: 400, contains: "time zone" });
    assert.equal((await ok("incidents.get", { incident_id: id })).data.attributes.state, "resolved");
  },
};
