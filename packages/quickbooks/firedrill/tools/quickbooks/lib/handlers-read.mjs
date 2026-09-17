// Read operations: company info, the query endpoint, entity reads, MCP-shaped searches and the invoice PDF.
import { NOT_FOUND_DETAIL, load, open } from "./access.mjs";
import { compileCriteria, paymentSearchAst } from "./criteria.mjs";
import { renderCustomer } from "./customers.mjs";
import { renderInvoice } from "./invoices.mjs";
import { renderItem } from "./items.mjs";
import { base64FromBinary, invoicePdf } from "./pdf.mjs";
import { renderPayment } from "./payments.mjs";
import { parseQuery } from "./query-parse.mjs";
import { evaluate } from "./query-eval.mjs";
import { renderAccount, renderCompany } from "./views.mjs";

function search(s, entity, criteria, topLevel) {
  const { ast, all, count } = compileCriteria(s, entity, criteria, topLevel);
  const { entities, total } = evaluate(s, ast, { all });
  return count ? { results: [], totalCount: total } : { results: entities };
}

export const readOperations = {
  "company-info.get": (input, context) => {
    const s = open(context, input, "company.read");
    if (input.company_id !== undefined && input.company_id !== s.company.Id && input.company_id !== s.realmId) {
      s.fail("OBJECT_NOT_FOUND", NOT_FOUND_DETAIL, "Id");
    }
    return { CompanyInfo: renderCompany(s.company), time: s.clock.time };
  },
  "query.run": (input, context) => {
    const s = open(context, input, "query");
    const ast = parseQuery(input.query, (detail) => s.fail("QUERY_PARSE_ERROR", detail, "query"));
    const { meta, entities, total } = evaluate(s, ast);
    let response;
    if (ast.select.kind === "count") response = { totalCount: total };
    else if (entities.length === 0) response = {};
    else {
      response = { startPosition: ast.start, maxResults: entities.length };
      response[meta.name] = entities;
    }
    return { QueryResponse: response, time: s.clock.time };
  },
  "customers.get": (input, context) => {
    const s = open(context, input, "customers.read");
    return { Customer: renderCustomer(s, load(s, "customers", input.id)), time: s.clock.time };
  },
  "customers.search": (input, context) => {
    const s = open(context, input, "customers.read");
    const topLevel = { limit: input.limit, offset: input.offset, asc: input.asc, desc: input.desc, fetchAll: input.fetchAll, count: input.count };
    return search(s, "Customer", input.criteria, topLevel);
  },
  "items.get": (input, context) => {
    const s = open(context, input, "items.read");
    return { Item: renderItem(s, load(s, "items", input.item_id, "item_id")), time: s.clock.time };
  },
  "items.search": (input, context) => search(open(context, input, "items.read"), "Item", input.criteria, {}),
  "invoices.get": (input, context) => {
    const s = open(context, input, "invoices.read");
    return { Invoice: renderInvoice(s, load(s, "invoices", input.invoice_id, "invoice_id")), time: s.clock.time };
  },
  "invoices.search": (input, context) => search(open(context, input, "invoices.read"), "Invoice", input.criteria, {}),
  "invoices.pdf": (input, context) => {
    const s = open(context, input, "invoices.read");
    const row = load(s, "invoices", input.invoice_id, "invoice_id");
    if (input.output_path !== undefined) {
      s.fail("BUSINESS_VALIDATION", "output_path is not supported: a Firedrill Tool cannot write files; use the returned base64 content.", "output_path");
    }
    const file = invoicePdf(s.company, renderInvoice(s, row));
    return { invoice_id: row.Id, content_type: "application/pdf", size_bytes: file.length, base64: base64FromBinary(file) };
  },
  "payments.get": (input, context) => {
    const s = open(context, input, "payments.read");
    return { Payment: renderPayment(s, load(s, "payments", input.id)), time: s.clock.time };
  },
  "payments.search": (input, context) => {
    const s = open(context, input, "payments.read");
    return { results: evaluate(s, paymentSearchAst(s, input)).entities };
  },
  "accounts.get": (input, context) => {
    const s = open(context, input, "accounts.read");
    return { Account: renderAccount(s, load(s, "accounts", input.id)), time: s.clock.time };
  },
  "accounts.search": (input, context) => search(open(context, input, "accounts.read"), "Account", input.criteria, {}),
};
