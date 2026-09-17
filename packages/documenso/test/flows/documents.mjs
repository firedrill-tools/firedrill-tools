// documents flow: find/get/create/update/distribute/redistribute/duplicate/delete/cancel and the audit log (admin, baseline).
import assert from "node:assert/strict";
import { ENV, create, get, post } from "../client.mjs";

async function find() {
  let r = await get("/api/v2/document");
  assert.deepEqual([r.body.count, r.body.totalPages, r.body.currentPage, r.body.perPage, r.body.data.length], [15, 2, 1, 10, 10]);
  assert.equal(r.body.data[0].id, 1001, "newest first");
  assert.ok(r.body.data.every((d) => d.team.id === 1 && d.deletedAt === null));
  r = await get("/api/v2/document?page=2");
  assert.equal(r.body.data.length, 5);
  r = await get("/api/v2/document?page=3");
  assert.deepEqual([r.body.data.length, r.body.count], [0, 15]);
  assert.equal((await get("/api/v2/document?status=DRAFT")).body.count, 5);
  assert.equal((await get("/api/v2/document?query=BLUEFIN")).body.count, 1);
  assert.equal((await get(`/api/v2/document?query=${encodeURIComponent("東京")}`)).body.data[0].id, 1011);
  assert.equal((await get("/api/v2/document?query=kenji.watanabe")).body.count, 1, "matches recipient e-mail");
  assert.equal((await get("/api/v2/document?source=TEMPLATE&templateId=2001")).body.data[0].id, 1012);
  assert.equal((await get("/api/v2/document?orderByDirection=asc&perPage=1")).body.data[0].id, 1013);
  await get("/api/v2/document?perPage=0", [400, "BAD_REQUEST"]);
  await get("/api/v2/document?folderId=f1", [400, "BAD_REQUEST"]);
  await get("/api/v2/document?query=%ZZ%E0%A4", [400, "BAD_REQUEST"]);
}

async function readAndCreate() {
  const nda = (await get("/api/v2/document/1001")).body;
  assert.deepEqual([nda.status, nda.recipients.length, nda.fields.length, nda.envelopeId], ["DRAFT", 2, 3, ENV(1001)]);
  assert.match(nda.documentData.data, /^Mutual NDA/);
  await get("/api/v2/document/abc", [400, "BAD_REQUEST"]);
  await get("/api/v2/document/9999", [404, "NOT_FOUND"]);
  await get("/api/v2/document/1017", [404, "NOT_FOUND"]);
  await get("/api/v2/document/1016", [404, "NOT_FOUND"]);
  const payload = {
    title: "Master services agreement — Kestrel", externalId: "MSA-KESTREL-01",
    recipients: [{ email: "Ops@Kestrel.example.com", name: "Kestrel Ops", role: "SIGNER",
      fields: [{ type: "SIGNATURE", pageNumber: 2, pageX: 10, pageY: 80, width: 30, height: 8 }] }],
    meta: { subject: "Please sign the MSA", timezone: "Europe/Berlin", dateFormat: "yyyy-MM-dd" },
  };
  const created = (await create(payload, "Master services agreement\n\nPage one\fPage two")).body;
  assert.equal(created.id, 1019);
  assert.match(created.envelopeId, /^envelope_[a-z0-9]{16}$/);
  const doc = (await get("/api/v2/document/1019")).body;
  assert.deepEqual([doc.status, doc.recipients[0].email, doc.fields[0].page, doc.documentMeta.timezone, doc.createdAt],
    ["DRAFT", "ops@kestrel.example.com", 2, "Europe/Berlin", "2026-09-15T09:00:00.000Z"]);
  assert.match(doc.recipients[0].token, /^[A-Za-z0-9_-]{21}$/);
  await create({ ...payload, recipients: [{ ...payload.recipients[0], fields: [{ type: "SIGNATURE", pageNumber: 3, pageX: 1, pageY: 1, width: 5, height: 5 }] }] },
    "one\ftwo", [400, "INVALID_REQUEST"]);
  await create({ title: "Dup", recipients: [{ email: "a@example.com", role: "SIGNER" }, { email: "A@example.com", role: "VIEWER" }] }, "x", [400, "INVALID_REQUEST"]);
  await create({ title: "Bad", visibility: "SECRET" }, "x", [400, "BAD_REQUEST"]);
  const bad = await fetch(`${process.env.FIREDRILL_HTTP_URL}/api/v2/document/create`, {
    method: "POST", headers: { authorization: process.env.FIREDRILL_HTTP_TOKEN, "content-type": "multipart/form-data" }, body: "garbage" });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "BAD_REQUEST");
}

async function updateAndSend() {
  const updated = (await post("/api/v2/document/update", { documentId: 1001, data: { title: "Mutual NDA — Bluefin Analytics (v2)", externalId: "NDA-7" },
    meta: { subject: "NDA for signature" } })).body;
  assert.deepEqual([updated.title, updated.externalId, updated.updatedAt], ["Mutual NDA — Bluefin Analytics (v2)", "NDA-7", "2026-09-15T09:00:00.000Z"]);
  await post("/api/v2/document/update", { documentId: 1006, data: { title: "Renamed" } }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/update", { documentId: 1001, data: { visibility: "SECRET" } }, [400, "BAD_REQUEST"]);
  await post("/api/v2/document/update", { documentId: 9999, data: { title: "x" } }, [404, "NOT_FOUND"]);
  const sent = (await post("/api/v2/document/distribute", { documentId: 1001, meta: { message: "Please review before Friday" } })).body;
  assert.equal(sent.status, "PENDING");
  assert.ok(sent.recipients.every((r) => r.sendStatus === "SENT"));
  await post("/api/v2/document/distribute", { documentId: 1001 }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/distribute", { documentId: 1002 }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/distribute", { documentId: 1003 }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/distribute", { documentId: 1005, meta: { signingOrder: "SEQUENTIAL" } }, [400, "BAD_REQUEST"]);
  await post("/api/v2/document/distribute", { documentId: 9999 }, [404, "NOT_FOUND"]);
  assert.equal((await get("/api/v2/document/1001")).body.documentMeta.message, "Please review before Friday");
  await post("/api/v2/document/redistribute", { documentId: 1006, recipients: [3008] });
  const log = (await get(`/api/v2/envelope/${ENV(1006)}/audit-log?perPage=1`)).body.data[0];
  assert.deepEqual([log.type, log.data.recipientId, log.data.isResending], ["EMAIL_SENT", 3008, true]);
  await post("/api/v2/document/redistribute", { documentId: 1006, recipients: [3007] }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/redistribute", { documentId: 1008, recipients: [3012] }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/document/redistribute", { documentId: 1006, recipients: [] }, [400, "BAD_REQUEST"]);
  await post("/api/v2/document/redistribute", { documentId: 9999, recipients: [1] }, [404, "NOT_FOUND"]);
}

async function copyDeleteCancel() {
  const copy = (await post("/api/v2/document/duplicate", { documentId: 1011 })).body;
  assert.equal(copy.documentId, 1020);
  const dup = (await get("/api/v2/document/1020")).body;
  assert.deepEqual([dup.status, dup.fields.every((f) => !f.inserted), dup.recipients[0].signingStatus, dup.envelopeId], ["DRAFT", true, "NOT_SIGNED", copy.id]);
  assert.notEqual(dup.recipients[0].token, "tok_1011_1xxxxxxxxxxx");
  await post("/api/v2/document/duplicate", { documentId: "x" }, [400, "BAD_REQUEST"]);
  await post("/api/v2/document/duplicate", { documentId: 9999 }, [404, "NOT_FOUND"]);
  await post("/api/v2/document/delete", { documentId: 1020 });
  await get("/api/v2/document/1020", [404, "NOT_FOUND"]);
  await get(`/api/v2/document/recipient/${dup.recipients[0].id}`, [404, "NOT_FOUND"]);
  await post("/api/v2/document/delete", { documentId: 1013 });
  await get("/api/v2/document/1013", [404, "NOT_FOUND"]);
  assert.equal((await get("/api/v2/document")).body.count, 15, "1019 created, 1013 hidden");
  await post("/api/v2/document/delete", { documentId: 9999 }, [404, "NOT_FOUND"]);
  await post("/api/v2/document/delete", { documentId: "x" }, [400, "BAD_REQUEST"]);
  await post("/api/v2/envelope/cancel", { envelopeId: ENV(1006), reason: "Scope changed" });
  assert.equal((await get("/api/v2/document/1006")).body.status, "CANCELLED");
  await post("/api/v2/envelope/cancel", { envelopeId: ENV(1011) }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/envelope/cancel", { envelopeId: "envelope_zzzzzzzzzzzzzzzz" }, [404, "NOT_FOUND"]);
  await post("/api/v2/envelope/cancel", { envelopeId: ENV(1007), reason: "r".repeat(501) }, [400, "BAD_REQUEST"]);
}

async function auditLog() {
  let r = await get(`/api/v2/envelope/${ENV(1007)}/audit-log`);
  assert.deepEqual([r.body.count, r.body.totalPages, r.body.data.length, r.body.data[0].type], [12, 2, 10, "DOCUMENT_RECIPIENT_COMPLETED"]);
  r = await get(`/api/v2/envelope/${ENV(1007)}/audit-log?page=2&orderByDirection=desc`);
  assert.equal(r.body.data.at(-1).type, "DOCUMENT_CREATED");
  r = await get(`/api/v2/envelope/${ENV(1007)}/audit-log?orderByDirection=asc&perPage=1`);
  assert.deepEqual([r.body.data[0].type, r.body.data[0].userId, r.body.data[0].ipAddress], ["DOCUMENT_CREATED", 2, null]);
  await get(`/api/v2/envelope/${ENV(1007)}/audit-log?perPage=0`, [400, "BAD_REQUEST"]);
  await get(`/api/v2/envelope/${ENV(9999)}/audit-log`, [404, "NOT_FOUND"]);
  await get(`/api/v2/envelope/${ENV(2001, "t")}/audit-log`, [404, "NOT_FOUND"]);
}

export const FLOWS = {
  documents: async () => {
    await find();
    await readAndCreate();
    await updateAndSend();
    await copyDeleteCancel();
    await auditLog();
  },
};
