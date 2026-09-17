// Invoice lifecycle and payments flows.
import assert from "node:assert/strict";
import { MISSING, acc, api, con, get, inv, mcp, mcpError, notFound, op, pay, post, put, q, replayed, validation, xeroError } from "./lib.mjs";

const line = (Description, Quantity, UnitAmount, AccountCode = "200", TaxType = "OUTPUT2") => ({ Description, Quantity, UnitAmount, AccountCode, TaxType });

export async function invoices() {
  const paged = await mcp("list-invoices", { page: 1 });
  assert.ok(Array.isArray(paged.Invoices[0].LineItems), "paged invoices carry LineItems");
  const plain = (await get("/Invoices")).json.Invoices;
  assert.equal(plain.length, 16);
  assert.equal(plain[0].LineItems, undefined, "unpaged invoices omit LineItems");
  assert.equal((await get(`/Invoices${q({ Statuses: "AUTHORISED", where: 'Type=="ACCREC"' })}`)).json.Invoices.length, 5);
  assert.equal((await get(`/Invoices${q({ where: 'Status=="AUTHORISED"&&AmountDue>0' })}`)).json.Invoices.length, 6);
  assert.equal((await get(`/Invoices${q({ where: "AmountDue>0" })}`)).json.Invoices.length, 9);
  const rimu = (await get(`/Invoices${q({ InvoiceNumbers: "INV-1003", page: 1, unitdp: 4 })}`)).json.Invoices[0];
  assert.equal(rimu.LineItems.length, 5);
  assert.ok(rimu.LineItems.some((l) => l.UnitAmount === 18.755), "unitdp=4 keeps four decimals");
  // A bad unitdp on the single-invoice read answers Xero's 400 ValidationException (declared on invoices.get).
  for (const bad of ["abc", "-1", "", "true", "1e999", "3"]) await validation("GET", `/Invoices/${inv(1)}${q({ unitdp: bad })}`, undefined, "unitdp");
  assert.equal((await get(`/Invoices/${inv(1)}${q({ unitdp: 4 })}`)).json.Invoices.length, 1, "unitdp=4 still reads one invoice");
  assert.equal(rimu.LineItems.find((l) => l.TaxType === "ZERORATED").TaxAmount, 0);
  assert.equal((await get(`/Invoices${q({ ContactIDs: con(7) })}`)).json.Invoices.length, 2);
  assert.equal((await get(`/Invoices${q({ order: "Date DESC" })}`)).json.Invoices[0].Date, "/Date(1789344000000+0000)/");
  assert.equal((await get("/Invoices/INV-1006")).json.Invoices[0].AmountDue, 2025);
  await notFound("GET", `/Invoices/${MISSING}`);
  await validation("GET", `/Invoices${q({ Statuses: "BOGUS" })}`, undefined, "Statuses");
  await xeroError("GET", `/Invoices${q({ where: "Total >" })}`, 16);

  const draft = (await put("/Invoices", { Invoices: [{ Type: "ACCREC", Contact: { ContactID: con(12) }, Date: "2026-09-15", LineItems: [line("Kauri coffee table", 1, 1200), line("Coasters", 4, 62.5)] }] })).json.Invoices[0];
  assert.deepEqual([draft.InvoiceNumber, draft.Status, draft.SubTotal, draft.TotalTax, draft.Total], ["INV-1015", "DRAFT", 1450, 217.5, 1667.5]);
  await validation("POST", `/Invoices/${draft.InvoiceID}`, { Status: "AUTHORISED" }, "Due Date is required.");
  assert.equal((await post(`/Invoices/${draft.InvoiceID}`, { Status: "AUTHORISED", DueDate: "2026-10-20" })).json.Invoices[0].Status, "AUTHORISED");
  await validation("PUT", "/Invoices", { Type: "ACCREC", Contact: { ContactID: con(1) }, LineItems: [line("x", 1, 5, "090")] }, "Account code '090' is not a valid code for this document.");
  await validation("PUT", "/Invoices", { Type: "ACCREC", Contact: { ContactID: con(1) }, LineItems: [line("x", 1, 5, "205")] }, "Account code '205'");
  await validation("PUT", "/Invoices", { Type: "ACCREC", InvoiceNumber: "INV-1001", Contact: { ContactID: con(1) } }, "Invoice # must be unique.");
  assert.equal((await put("/Invoices", { Type: "ACCREC", InvoiceNumber: "INV-1005", Contact: { ContactID: con(1) } })).json.Invoices[0].InvoiceNumber, "INV-1005");
  const florist = (await put("/Invoices", { Type: "ACCREC", Contact: { Name: "Fantail Florists" }, LineAmountTypes: "Inclusive", LineItems: [line("Planter boxes", 2, 115)] })).json.Invoices[0];
  assert.deepEqual([florist.SubTotal, florist.TotalTax, florist.Total, florist.Contact.Name], [200, 30, 230, "Fantail Florists"]);
  const emailed = await api("POST", `/Invoices/${inv(9)}/Email`, { body: {}, status: 204 });
  assert.equal(emailed.text, "");
  assert.equal((await get(`/Invoices/${inv(9)}`)).json.Invoices[0].SentToContact, true);
  await validation("POST", `/Invoices/${inv(10)}/Email`, {}, "does not have an email address");
  await validation("POST", `/Invoices/${inv(13)}/Email`, {}, "DRAFT");
  await notFound("POST", `/Invoices/${MISSING}/Email`, {});
  assert.equal((await post(`/Invoices/${inv(10)}`, { Status: "VOIDED" })).json.Invoices[0].Status, "VOIDED");
  const replayInvoice = await replayed("PUT", "/Invoices", { Invoices: [{ Type: "ACCREC", Contact: { ContactID: con(12) }, Date: "2026-09-15", DueDate: "2026-10-15", Status: "AUTHORISED", LineItems: [line("Replay probe", 2, 10)] }] }, "invoices-replay-order");
  assert.deepEqual(Object.keys(replayInvoice.Invoices[0]).slice(0, 4), ["Type", "InvoiceID", "InvoiceNumber", "Payments"]);
  assert.deepEqual(Object.keys(replayInvoice.Invoices[0].LineItems[0]).slice(0, 3), ["LineItemID", "Description", "Quantity"]);
  const replayPayment = await replayed("PUT", "/Payments", { Payments: [{ Invoice: { InvoiceID: replayInvoice.Invoices[0].InvoiceID }, Account: { Code: "090" }, Date: "2026-09-16", Amount: 5, Reference: "replay" }] }, "payments-replay-order");
  assert.deepEqual(Object.keys(replayPayment.Payments[0]).slice(0, 3), ["PaymentID", "Date", "DateString"]);
  assert.deepEqual(Object.keys(replayPayment.Payments[0].Invoice), ["InvoiceID", "InvoiceNumber", "Type", "Contact"]);
  assert.equal((await post(`/Invoices/${inv(13)}`, { Status: "DELETED" })).json.Invoices[0].Status, "DELETED");
  await validation("POST", `/Invoices/${inv(1)}`, { Reference: "Changed" }, "Invoice not of valid status for modification");
  await validation("POST", `/Invoices/${inv(6)}`, { Reference: "Changed" }, "has a payment or credit allocated to it");
  await validation("PUT", "/Invoices", { Type: "ACCREC", Status: "AUTHORISED", Date: "2026-03-15", DueDate: "2026-04-15", Contact: { ContactID: con(1) }, LineItems: [line("Old", 1, 10)] }, "period lock date");
  await validation("PUT", "/Invoices", { InvoiceID: inv(11), Reference: "x" }, "already exists");
  await notFound("POST", `/Invoices/${MISSING}`, { Reference: "x" });
  await xeroError("PUT", "/Invoices", 17, { raw: "[1,2]" });

  const bill = await mcp("create-invoice", { contactId: con(8), type: "ACCPAY", lineItems: [{ description: "Kauri offcuts", quantity: 3, unitAmount: 80, accountCode: "453", taxType: "INPUT2" }] });
  assert.deepEqual([bill.Type, bill.Status, bill.Total], ["ACCPAY", "DRAFT", 276]);
  await mcpError("create-invoice", { contactId: MISSING, type: "ACCREC", lineItems: [{ description: "x", quantity: 1, unitAmount: 1, accountCode: "200", taxType: "OUTPUT2" }] }, "NOT_FOUND");
  await op("invoices.create", { contactId: con(1), type: "ACCREC", lineItems: [{ description: "x", quantity: 1, unitAmount: 1, accountCode: "200", taxType: "OUTPUT2", tracking: [{ trackingCategoryId: "a", trackingOptionId: "b" }] }] }, { code: "VALIDATION_EXCEPTION" });
  assert.equal((await mcp("update-invoice", { invoiceId: inv(14), lineItems: [{ description: "Plinth", quantity: 1, unitAmount: 300, accountCode: "200", taxType: "OUTPUT2" }] })).Total, 300);
  await mcpError("update-invoice", { invoiceId: inv(8), reference: "x" }, "VALIDATION_EXCEPTION");
  await op("invoices.update", { invoiceId: MISSING, reference: "x" }, { code: "NOT_FOUND" });
  const mixed = (await post(`/Invoices${q({ summarizeErrors: "false" })}`, { Invoices: [{ Type: "ACCREC", Contact: { ContactID: con(2) } }, { Type: "ACCREC", InvoiceNumber: "INV-1002", Contact: { ContactID: con(2) } }] })).json.Invoices;
  assert.deepEqual(mixed.map((i) => i.StatusAttributeString), ["OK", "ERROR"]);
}

export async function payments() {
  assert.equal((await get("/Payments")).json.Payments.length, 6);
  assert.equal((await get(`/Payments${q({ where: 'Status=="AUTHORISED"' })}`)).json.Payments.length, 5);
  assert.equal((await get(`/Payments${q({ where: 'Invoice.InvoiceNumber=="INV-1006"' })}`)).json.Payments.length, 1);
  assert.equal((await mcp("list-payments", { invoiceNumber: "INV-1006" })).Payments.length, 1);
  assert.equal((await mcp("list-payments", { reference: "DC-4471" })).Payments[0].PaymentID, pay(4));
  assert.equal((await get(`/Payments/${pay(4)}`)).json.Payments[0].Amount, 2000);
  await notFound("GET", `/Payments/${MISSING}`);
  await xeroError("GET", `/Payments${q({ where: "Amount == true" })}`, 16);
  await validation("GET", `/Payments${q({ page: 1, pageSize: 5000 })}`, undefined, "pageSize");

  const paid = (await put("/Payments", { Payments: [{ Invoice: { InvoiceID: inv(6) }, Account: { Code: "090" }, Date: "2026-09-15", Amount: 2025 }] })).json.Payments[0];
  const settled = (await get(`/Invoices/${inv(6)}`)).json.Invoices[0];
  assert.deepEqual([settled.Status, settled.AmountDue, settled.FullyPaidOnDate], ["PAID", 0, "/Date(1789430400000+0000)/"]);
  await validation("PUT", "/Payments", { Invoice: { InvoiceID: inv(8) }, Account: { Code: "090" }, Amount: 9999 }, "Payment amount exceeds the amount outstanding on this document.");
  await validation("PUT", "/Payments", { Invoice: { InvoiceNumber: "INV-1014" }, Account: { Code: "090" }, Amount: 10 }, "AUTHORISED");
  await validation("PUT", "/Payments", { Invoice: { InvoiceID: inv(8) }, Account: { Code: "200" }, Amount: 10 }, "Account code '200'");
  await validation("PUT", "/Payments", { Invoice: { InvoiceID: inv(8) }, Account: { Code: "090" }, Amount: 0 }, "greater than zero");
  await notFound("PUT", "/Payments", { Invoice: { InvoiceID: MISSING }, Account: { Code: "090" }, Amount: 10 });
  await xeroError("PUT", "/Payments", 17, { raw: "42" });
  const part = await mcp("create-payment", { invoiceId: inv(8), accountId: acc(1), amount: 100, reference: "Part payment" });
  assert.equal(part.Invoice.InvoiceNumber, "INV-1008");
  await mcpError("create-payment", { invoiceId: MISSING, accountId: acc(1), amount: 1 }, "NOT_FOUND");
  await op("payments.record", { invoiceId: inv(8), accountId: acc(1), amount: 5000 }, { code: "VALIDATION_EXCEPTION" });
  assert.equal((await post(`/Payments/${paid.PaymentID}`, { Status: "DELETED" })).json.Payments[0].Status, "DELETED");
  const reopened = (await get("/Invoices/INV-1006")).json.Invoices[0];
  assert.deepEqual([reopened.Status, reopened.AmountPaid], ["AUTHORISED", 2000]);
  await validation("POST", `/Payments/${paid.PaymentID}`, { Status: "DELETED" }, "already been deleted");
  await validation("POST", `/Payments/${pay(2)}`, { Status: "DELETED" }, "reconciled");
  await validation("POST", `/Payments/${pay(4)}`, { Status: "AUTHORISED" }, "Status must be DELETED");
  await notFound("POST", `/Payments/${MISSING}`, { Status: "DELETED" });
}
