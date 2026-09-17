// signing and templates flows (admin, baseline).
import assert from "node:assert/strict";
import { ENV, TOKEN_OF, get, op, post } from "../client.mjs";

const auditCount = async (docId) => (await get(`/api/v2/envelope/${ENV(docId)}/audit-log?perPage=1`)).body.count;

async function signing() {
  const before = await auditCount(1006);
  const view = await op("signing.get", { token: TOKEN_OF(1006, 2) });
  assert.deepEqual([view.canSign, view.reasonIfNot, view.recipient.readStatus, view.document.teamName, view.document.senderName],
    [true, null, "OPENED", "Northwind Legal", "Priya Raman"]);
  assert.deepEqual(view.fields.filter((f) => f.own).map((f) => f.id), [4011, 4012]);
  await op("signing.get", { token: TOKEN_OF(1006, 2) });
  assert.equal(await auditCount(1006), before + 1, "DOCUMENT_OPENED is recorded once");
  await op("signing.get", { token: "no-such-token" }, "NOT_FOUND");
  await op("signing.get", { token: TOKEN_OF(1001, 1) }, "NOT_FOUND");
  const lena = await op("signing.get", { token: TOKEN_OF(1007, 3) });
  assert.deepEqual([lena.canSign, lena.reasonIfNot], [false, "It is not your turn to sign"]);
  await op("signing.complete", { token: TOKEN_OF(1007, 3), values: [{ fieldId: 4016, value: "Lena Park" }] }, "INVALID_REQUEST");
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [{ fieldId: 4011, value: "Tomas Okafor" }] }, "INVALID_REQUEST");
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [], reject: { reason: "No" } }, "BAD_REQUEST");
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [{ fieldId: 4009, value: "Not mine" }] }, "INVALID_REQUEST");
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [{ fieldId: "x", value: "bad" }] }, "BAD_REQUEST");
  await op("signing.complete", { token: "missing" }, "NOT_FOUND");
  const done = await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [{ fieldId: 4011, value: "Tomas Okafor" }, { fieldId: 4012, value: true }] });
  assert.deepEqual(done, { recipientStatus: "SIGNED", documentStatus: "COMPLETED", completedAt: "2026-09-15T09:00:00.000Z" });
  const sow = (await get("/api/v2/document/1006")).body;
  assert.deepEqual([sow.status, sow.fields.find((f) => f.id === 4012).customText, sow.recipients[1].signingStatus], ["COMPLETED", "true", "SIGNED"]);
  await op("signing.complete", { token: TOKEN_OF(1006, 2), values: [] }, "INVALID_REQUEST");
  const mei = await op("signing.complete", { token: TOKEN_OF(1007, 2), values: [{ fieldId: 4014, value: "Mei Chen" }, { fieldId: 4015, value: "MC" }] });
  assert.deepEqual([mei.documentStatus, mei.completedAt], ["PENDING", null]);
  assert.equal((await op("signing.get", { token: TOKEN_OF(1007, 3) })).canSign, true, "sequential order advances");
  const rejected = await op("signing.complete", { token: TOKEN_OF(1009, 1), reject: { reason: "Wrong photos attached" } });
  assert.equal(rejected.documentStatus, "REJECTED");
  const release = (await get("/api/v2/document/1009")).body;
  assert.deepEqual([release.status, release.recipients[0].rejectionReason], ["REJECTED", "Wrong photos attached"]);
}

async function rejectOnBehalf() {
  const url = "/api/v2/envelope/recipient/3011/reject";
  await post(url, { envelopeId: ENV(1007), reason: "Terms not agreed", actAsEmail: "stranger@example.com" }, [400, "INVALID_REQUEST"]);
  await post(url, { envelopeId: ENV(1007), reason: "" }, [400, "BAD_REQUEST"]);
  await post(url, { envelopeId: ENV(1010), reason: "Wrong envelope" }, [404, "NOT_FOUND"]);
  await post(url, { envelopeId: ENV(1007), reason: "Terms not agreed", actAsEmail: "tomas.okafor@northwind.test" });
  const spa = (await get("/api/v2/document/1007")).body;
  assert.deepEqual([spa.status, spa.recipients[2].signingStatus], ["REJECTED", "REJECTED"]);
  const log = (await get(`/api/v2/envelope/${ENV(1007)}/audit-log?perPage=1`)).body.data[0];
  assert.deepEqual([log.type, log.email, log.data.reason], ["DOCUMENT_RECIPIENT_REJECTED", "tomas.okafor@northwind.test", "Terms not agreed"]);
  await post("/api/v2/envelope/recipient/3016/reject", { envelopeId: ENV(1010), reason: "Not pending", actAsEmail: null });
  await post("/api/v2/envelope/recipient/3017/reject", { envelopeId: ENV(1010), reason: "Already rejected" }, [400, "INVALID_REQUEST"]);
}

async function templates() {
  let r = await get("/api/v2/template");
  assert.deepEqual([r.body.count, r.body.data.map((t) => t.id)], [3, [2003, 2002, 2001]]);
  assert.equal((await get("/api/v2/template?type=PUBLIC")).body.data[0].publicTitle, "Work with Northwind");
  assert.equal((await get("/api/v2/template?query=offer")).body.count, 1);
  r = await get("/api/v2/template?perPage=1&page=2");
  assert.deepEqual([r.body.data[0].id, r.body.totalPages], [2002, 3]);
  await get("/api/v2/template?type=SHARED", [400, "BAD_REQUEST"]);
  const nda = (await get("/api/v2/template/2001")).body;
  assert.deepEqual([nda.recipients.length, nda.fields.length, nda.user.id, nda.directLink], [2, 4, 1, null]);
  await get("/api/v2/template/2004", [404, "NOT_FOUND"]);
  await get("/api/v2/template/abc", [400, "BAD_REQUEST"]);
  const doc = (await post("/api/v2/template/use", { templateId: 2001, externalId: "NDA-CEDAR",
    recipients: [{ id: 3027, email: "priya.raman@northwind.test", name: "Priya Raman" }, { id: 3028, email: "legal@cedar.example.com", name: "Cedar Legal" }] })).body;
  assert.deepEqual([doc.id, doc.status, doc.source, doc.templateId, doc.recipients.length, doc.fields.length, doc.title], [1019, "DRAFT", "TEMPLATE", 2001, 2, 4, "Mutual NDA (standard)"]);
  assert.deepEqual(doc.fields.map((f) => f.recipientId), [doc.recipients[0].id, doc.recipients[0].id, doc.recipients[1].id, doc.recipients[1].id]);
  const offer = (await post("/api/v2/template/use", { templateId: 2002, distributeDocument: true,
    recipients: [{ id: 3029, email: "jo.candidate@example.com", name: "Jo Candidate" }], override: { title: "Offer letter — Jo Candidate", subject: "Your offer" } })).body;
  assert.deepEqual([offer.status, offer.title, offer.documentMeta.subject, offer.recipients.map((x) => x.email)],
    ["PENDING", "Offer letter — Jo Candidate", "Your offer", ["jo.candidate@example.com", "people-ops@northwind.test"]]);
  await post("/api/v2/template/use", { templateId: 2001, recipients: [{ id: 3027, email: "solo@example.com" }] }, [400, "INVALID_REQUEST"]);
  await post("/api/v2/template/use", { templateId: 2001, recipients: [], prefillFields: [] }, [400, "BAD_REQUEST"]);
  await post("/api/v2/template/use", { templateId: 9999, recipients: [] }, [404, "NOT_FOUND"]);
  assert.equal((await get("/api/v2/document?source=TEMPLATE")).body.count, 3);
}

export const FLOWS = {
  signing: async () => {
    await signing();
    await rejectOnBehalf();
  },
  templates,
};
