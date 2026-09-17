// recipients-fields flow: recipient and field editing rules on drafts, pending and completed documents (admin, baseline).
import assert from "node:assert/strict";
import { get, post } from "../client.mjs";

const many = (documentId, recipients, expect) => post("/api/v2/document/recipient/create-many", { documentId, recipients }, expect);
const update = (documentId, recipient, expect) => post("/api/v2/document/recipient/update", { documentId, recipient }, expect);
const addFields = (documentId, fields, expect) => post("/api/v2/document/field/create-many", { documentId, fields }, expect);
const box = (recipientId, extra = {}) => ({ recipientId, type: "TEXT", pageNumber: 1, pageX: 10, pageY: 30, width: 30, height: 5, ...extra });

async function recipients() {
  const ana = (await get("/api/v2/document/recipient/3001")).body;
  assert.deepEqual([ana.email, ana.documentId, ana.fields.map((f) => f.id)], ["ana.silva@bluefin.example.com", 1001, [4001, 4002]]);
  await get("/api/v2/document/recipient/99999", [404, "NOT_FOUND"]);
  await get("/api/v2/document/recipient/abc", [400, "BAD_REQUEST"]);
  await get("/api/v2/document/recipient/3027", [404, "NOT_FOUND"]);
  const added = (await many(1001, [{ email: "legal@bluefin.example.com", name: "Bluefin Legal", role: "CC" },
    { email: "cfo@bluefin.example.com", name: "Bluefin CFO", role: "APPROVER", signingOrder: 2 }])).body.recipients;
  assert.deepEqual(added.map((r) => [r.id, r.role, r.sendStatus, r.signingOrder]), [[3034, "CC", "NOT_SENT", null], [3035, "APPROVER", "NOT_SENT", 2]]);
  assert.equal((await get("/api/v2/document/1001")).body.recipients.length, 4);
  await many(1001, [{ email: "ANA.SILVA@bluefin.example.com", name: "Again", role: "SIGNER" }], [400, "INVALID_REQUEST"]);
  await many(1001, [], [400, "BAD_REQUEST"]);
  await many(1001, Array.from({ length: 22 }, (_, i) => ({ email: `extra${i}@example.com`, role: "VIEWER" })), [400, "INVALID_REQUEST"]);
  await many(1011, [{ email: "late@example.com", role: "SIGNER" }], [400, "INVALID_REQUEST"]);
  await many(9999, [{ email: "late@example.com", role: "SIGNER" }], [404, "NOT_FOUND"]);
  const pendingAdd = (await many(1006, [{ email: "observer@maple.example.com", name: "Maple Observer", role: "VIEWER" }])).body.recipients[0];
  assert.equal(pendingAdd.sendStatus, "SENT", "recipients added to a pending e-mail document are sent");
  const renamed = (await update(1001, { id: 3001, name: "Ana M. Silva", signingOrder: 1 })).body;
  assert.deepEqual([renamed.name, renamed.signingOrder, renamed.fields.length], ["Ana M. Silva", 1, 2]);
  assert.equal((await get("/api/v2/document/recipient/3001")).body.name, "Ana M. Silva");
  await update(1006, { id: 3007, name: "Signed already" }, [400, "INVALID_REQUEST"]);
  await update(1001, { id: 3001, role: "OWNER" }, [400, "BAD_REQUEST"]);
  await update(1001, { id: 99999, name: "Nobody" }, [404, "NOT_FOUND"]);
  await update(1001, { id: 3001, email: "priya.raman@northwind.test" }, [400, "INVALID_REQUEST"]);
  await update(1001, { id: 3007, name: "Wrong document" }, [400, "INVALID_REQUEST"]);
}

async function fields() {
  const [po] = (await addFields(1001, [box(3035, { fieldMeta: { label: "PO number", required: true, type: "text" } })])).body.fields;
  assert.deepEqual([po.id, po.type, po.recipientId, po.fieldMeta.label, po.inserted], [4042, "TEXT", 3035, "PO number", false]);
  assert.equal((await get("/api/v2/document/field/4042")).body.positionY, 30);
  await addFields(1001, [box(3034)], [400, "INVALID_REQUEST"]);
  await addFields(1001, [box(3035, { pageNumber: 2 })], [400, "INVALID_REQUEST"]);
  await addFields(1001, [box(3035, { pageX: 90, width: 20 })], [400, "INVALID_REQUEST"]);
  await addFields(1001, [box(3035, { type: "RADIO" })], [400, "BAD_REQUEST"]);
  await addFields(1001, [box(3035, { fieldMeta: { type: "checkbox" } })], [400, "INVALID_REQUEST"]);
  await addFields(1001, [box(3007)], [400, "INVALID_REQUEST"]);
  await addFields(1001, [], [400, "BAD_REQUEST"]);
  await addFields(1011, [box(3018)], [400, "INVALID_REQUEST"]);
  await addFields(9999, [box(3018)], [404, "NOT_FOUND"]);
  await get("/api/v2/document/field/99999", [404, "NOT_FOUND"]);
  await get("/api/v2/document/field/x", [400, "BAD_REQUEST"]);
  await get("/api/v2/document/field/4034", [404, "NOT_FOUND"]);
  const heavy = (n) => Array.from({ length: n }, (_, i) => box(3005, { type: "TEXT", pageNumber: 1 + (i % 3), pageY: i % 90, fieldMeta: { text: "\u0001".repeat(1000) } }));
  assert.equal((await addFields(1005, heavy(100))).body.fields.length, 100);
  const tooBig = await addFields(1005, heavy(90), [400, "INVALID_REQUEST"]);
  assert.match(tooBig.body.message, /too large/);
  assert.equal((await get("/api/v2/document/1005")).body.fields.length, 103, "the rejected batch wrote nothing");
  await post("/api/v2/document/field/delete", { fieldId: 4042 });
  await get("/api/v2/document/field/4042", [404, "NOT_FOUND"]);
  await post("/api/v2/document/field/delete", { fieldId: 4009 }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/field/delete", { fieldId: "x" }, [400, "BAD_REQUEST"]);
  await post("/api/v2/document/field/delete", { fieldId: 99999 }, [404, "NOT_FOUND"]);
}

async function removals() {
  await post("/api/v2/document/recipient/delete", { recipientId: 3002 });
  await get("/api/v2/document/field/4003", [404, "NOT_FOUND"]);
  await get("/api/v2/document/recipient/3002", [404, "NOT_FOUND"]);
  assert.deepEqual((await get("/api/v2/document/1001")).body.fields.map((f) => f.id), [4001, 4002]);
  await post("/api/v2/document/recipient/delete", { recipientId: 3007 }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/recipient/delete", { recipientId: 3014 }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/recipient/delete", { recipientId: 99999 }, [404, "NOT_FOUND"]);
  await post("/api/v2/document/recipient/delete", { recipientId: "abc" }, [400, "BAD_REQUEST"]);
}

export const FLOWS = {
  "recipients-fields": async () => {
    await recipients();
    await fields();
    await removals();
  },
};
