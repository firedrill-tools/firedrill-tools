// Fault and limit flows: rate-limited, distribution-outage, limit-reached, tight-limits, response-budget, byte-budget.
import assert from "node:assert/strict";
import { ENV, TOKEN_OF, create, everyApiOperation, get, op, post } from "../client.mjs";

const NDA_USE = { templateId: 2001, recipients: [{ id: 3027, email: "priya.raman@northwind.test" }, { id: 3028, email: "legal@cedar.example.com" }] };

async function rateLimited() {
  for (const call of [
    () => create({ title: "Rate limited" }, "text", [429, "TOO_MANY_REQUESTS"]),
    () => post("/api/v2/document/distribute", { documentId: 1001 }, [429, "TOO_MANY_REQUESTS"]),
    () => post("/api/v2/template/use", NDA_USE, [429, "TOO_MANY_REQUESTS"]),
  ]) {
    const r = await call();
    assert.deepEqual([r.headers.get("retry-after"), r.headers.get("x-ratelimit-remaining")], ["60", "0"]);
  }
  assert.equal((await get("/api/v2/document/1001")).body.status, "DRAFT");
}

async function distributionOutage() {
  await post("/api/v2/document/distribute", { documentId: 1001 }, [500, "UNKNOWN_ERROR"]);
  assert.equal((await get("/api/v2/document/1001")).body.status, "PENDING", "the send committed before the error");
  const retry = await post("/api/v2/document/distribute", { documentId: 1001 }, [400, "INVALID_REQUEST"]);
  assert.equal(retry.body.message, "Document is not a draft");
}

async function limitReached() {
  await create({ title: "Over the limit" }, "text", [400, "LIMIT_EXCEEDED"]);
  await post("/api/v2/document/duplicate", { documentId: 1011 }, [400, "LIMIT_EXCEEDED"]);
  await post("/api/v2/template/use", NDA_USE, [400, "LIMIT_EXCEEDED"]);
}

async function tightLimitsMember() {
  const skip = new Set(["documents.create"]);
  let calls = 0;
  await everyApiOperation((operationId) => {
    calls += 1;
    return skip.has(operationId) ? [403, "FORBIDDEN"] : [500, "UNKNOWN_ERROR"];
  }, { createPayload: { title: "Probe", visibility: "ADMIN" } });
  assert.equal(calls, 21);
  await op("signing.get", { token: TOKEN_OF(1006, 2) }, "UNKNOWN_ERROR");
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [] }, "UNKNOWN_ERROR");
  const context = await op("workspace.context", {});
  assert.equal(context.teams.length, 1, "a one-membership scan stays within the bound");
}

async function tightLimitsFresh() {
  await op("workspace.context", {}, "UNKNOWN_ERROR");
}

async function responseBudget() {
  await get("/api/v2/document", [400, "LIMIT_EXCEEDED"]);
  assert.equal((await get("/api/v2/document?query=no-such-title")).body.count, 0);
  await get("/api/v2/template", [400, "LIMIT_EXCEEDED"]);
  assert.equal((await get("/api/v2/template?query=no-such-template")).body.count, 0);
  await get(`/api/v2/envelope/${ENV(1007)}/audit-log`, [400, "LIMIT_EXCEEDED"]);
  assert.equal((await get(`/api/v2/envelope/${ENV(1002)}/audit-log?perPage=1`)).body.count, 1);
}

async function byteBudget() {
  const name = "契約書署名者東京支社".repeat(26).slice(0, 255);
  for (let i = 0; i < 40; i += 1) {
    const recipients = Array.from({ length: 25 }, (_, j) => ({ email: `signer${j + 1}@bulk${i + 1}.example.com`, name, role: "SIGNER" }));
    await create({ title: `Bulk agreement ${i + 1} — 東京`, recipients }, `Bulk agreement ${i + 1}`);
  }
  const tooLarge = await get("/api/v2/document?perPage=100", [400, "LIMIT_EXCEEDED"]);
  assert.match(tooLarge.body.message, /smaller perPage/);
  const page = await get("/api/v2/document?perPage=20");
  assert.equal(page.body.data.length, 20);
  assert.ok(page.bytes > 500_000 && page.bytes < 900_000, `a 20-document page is ${page.bytes} bytes`);
  assert.equal(page.body.count, 55);
}

export const FLOWS = {
  "rate-limited": rateLimited, "distribution-outage": distributionOutage, "limit-reached": limitReached,
  "tight-limits-member": tightLimitsMember, "tight-limits-fresh": tightLimitsFresh, "response-budget": responseBudget, "byte-budget": byteBudget,
};
