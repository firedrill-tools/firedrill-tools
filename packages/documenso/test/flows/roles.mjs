// Identity and permission flows: member, manager, harbor (team isolation), unauthorized, fresh-install, denied.
import assert from "node:assert/strict";
import { ENV, TOKEN_OF, create, everyApiOperation, get, op, post } from "../client.mjs";

async function member() {
  const list = (await get("/api/v2/document?perPage=100")).body;
  assert.equal(list.count, 13);
  assert.ok(!list.data.some((d) => d.id === 1004 || d.id === 1010), "ADMIN and MANAGER_AND_ABOVE documents stay hidden");
  await get("/api/v2/document/1010", [404, "NOT_FOUND"]);
  await get("/api/v2/document/1004", [404, "NOT_FOUND"]);
  await create({ title: "Escalated", visibility: "ADMIN" }, "text", [403, "FORBIDDEN"]);
  await post("/api/v2/document/update", { documentId: 1003, data: { visibility: "ADMIN" } }, [403, "FORBIDDEN"]);
  await post("/api/v2/document/delete", { documentId: 1002 }, [403, "FORBIDDEN"]);
  await post("/api/v2/envelope/cancel", { envelopeId: ENV(1006) }, [403, "FORBIDDEN"]);
  await post("/api/v2/envelope/recipient/3008/reject", { envelopeId: ENV(1006), reason: "Not mine to reject" }, [403, "FORBIDDEN"]);
  await post("/api/v2/template/use", { templateId: 2003, recipients: [{ id: 3031, email: "freelancer@example.com" }] }, [403, "FORBIDDEN"]);
  assert.equal((await get("/api/v2/template")).body.count, 3, "own MANAGER_AND_ABOVE template is visible to its owner");
  await post("/api/v2/document/delete", { documentId: 1003 });
  await post("/api/v2/envelope/cancel", { envelopeId: ENV(1009), reason: "Shoot cancelled" });
  assert.equal((await get("/api/v2/document/1009")).body.status, "CANCELLED");
}

async function manager() {
  assert.equal((await get("/api/v2/document?perPage=100")).body.count, 14);
  assert.equal((await get("/api/v2/document/1010")).body.visibility, "MANAGER_AND_ABOVE");
  await get("/api/v2/document/1004", [404, "NOT_FOUND"]);
  await post("/api/v2/document/delete", { documentId: 1003 });
  await get("/api/v2/document/1003", [404, "NOT_FOUND"]);
}

async function harbor() {
  await get("/api/v2/document/1001", [404, "NOT_FOUND"]);
  await get("/api/v2/template/2001", [404, "NOT_FOUND"]);
  await get("/api/v2/document/recipient/3001", [404, "NOT_FOUND"]);
  await get("/api/v2/document/field/4001", [404, "NOT_FOUND"]);
  const list = (await get("/api/v2/document")).body;
  assert.deepEqual(list.data.map((d) => d.id), [1018, 1017]);
  const context = await op("workspace.context", {});
  assert.deepEqual([context.team.id, context.team.plan, context.usage.documentsCreated, context.usage.monthlyDocumentLimit], [2, "free", 4, 5]);
  await create({ title: "Studio booking terms — Northlight" }, "Booking terms");
  await create({ title: "One too many" }, "Booking terms", [400, "LIMIT_EXCEEDED"]);
  assert.equal((await op("workspace.context", {})).usage.documentsCreated, 5);
}

async function unauthorized() {
  const count = await everyApiOperation(() => [401, "UNAUTHORIZED"]);
  assert.equal(count, 21);
  await op("workspace.context", {}, "UNAUTHORIZED");
}

async function freshInstall() {
  const context = await op("workspace.context", {});
  assert.deepEqual([context.user.id, context.team.id, context.team.role, context.teams.length, context.now], [1, 1, "ADMIN", 2, "2026-09-15T09:00:00.000Z"]);
  assert.equal((await get("/api/v2/document")).body.count, 15);
}

async function denied() {
  await everyApiOperation(() => [403, "FORBIDDEN"]);
  await op("signing.get", { token: TOKEN_OF(1006, 2) }, "denied");
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [] }, "denied");
  await op("workspace.context", {}, "denied");
}

export const FLOWS = { member, manager, harbor, unauthorized, "fresh-install": freshInstall, denied };
