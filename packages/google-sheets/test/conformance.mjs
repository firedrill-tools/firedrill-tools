// Google Sheets Tool conformance target. A scripted Tool test, not a model-driven agent.
// Node built-ins only: fetch against the Sheets API v4 and Drive API v3-shaped routes and the canonical
// /v1/operations endpoint (for operations without a REST route).
//
// `firedrill tool test` requires every declared operation, declared error, event and fault to be observed, so each flow
// deliberately triggers its share of them. Expected values derive from the starter data (4 users, 7 spreadsheets).
import assert from "node:assert/strict";

let task = "";
for await (const chunk of process.stdin) task += chunk;
const invocation = JSON.parse(task);
const instruction = String(invocation.instruction ?? "");
const selected = /`([a-z-]+)`/.exec(instruction)?.[1];

const HTTP = process.env.FIREDRILL_HTTP_URL;
const TOKEN = process.env.FIREDRILL_HTTP_TOKEN;
assert.ok(HTTP && TOKEN, "the HTTP binding is required");

const BUDGET = "1BxQ3MarketingBudgetSeedA7kLm2Np0123456789ab";
const PIPELINE = "1CxCustomerPipeline2026SeedB4tR0123456789abc";
const OFFSITE = "1DxTeamOffsitePlanningSeedC9wQ0123456789abcd";
const INVENTORY = "1ExWarehouseBInventorySeedD3hJ0123456789abcd";
const UNTITLED = "1FxUntitledSpreadsheetSeedE6vZ0123456789abcd";
const VENDORS = "1GxOldVendorListSeedF1pX0123456789abcdefghij";
const HIRING = "1HxHiringTrackerSeedG8mK0123456789abcdefghij";
const MISSING = "1ZxNoSuchSpreadsheetSeedZ0000123456789abcdef";
const ASSUMPTIONS = 1843712905;
const AVERY = "avery.chen@example.test";
const SAM = "sam.okafor@example.test";

// ---------------------------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------------------------

async function request(method, path, { body, status = 200 } = {}) {
  const response = await fetch(`${HTTP}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path} -> ${response.status} ${text.slice(0, 600)}`);
  const json = text.length > 0 && (response.headers.get("content-type") ?? "").includes("json") ? JSON.parse(text) : undefined;
  return { json, headers: response.headers, text };
}

const enc = encodeURIComponent;
const sheets = async (method, path, body) => (await request(method, `/v4/spreadsheets${path}`, { body })).json;
const drive = async (method, path, body) => (await request(method, `/drive/v3${path}`, { body, status: method === "DELETE" ? 204 : 200 })).json;

/** Expects the google.rpc envelope. */
async function sheetsError(method, path, status, statusName, body) {
  const { json, headers } = await request(method, `/v4/spreadsheets${path}`, { body, status });
  assert.equal(json?.error?.code, status, JSON.stringify(json));
  assert.equal(json.error.status, statusName, JSON.stringify(json));
  return { ...json.error, headers };
}

/** Expects Drive's classic envelope. */
async function driveError(method, path, status, reason, body) {
  const { json, headers } = await request(method, `/drive/v3${path}`, { body, status });
  assert.ok(Array.isArray(json?.error?.errors), `expected a Drive envelope: ${JSON.stringify(json)}`);
  assert.equal(json.error.code, status);
  assert.equal(json.error.errors[0].reason, reason, JSON.stringify(json));
  return { ...json.error, headers };
}

async function op(operationId, args, expected = "ok") {
  const response = await fetch(`${HTTP}/v1/operations/google-sheets/${operationId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ arguments: args }),
  });
  const json = await response.json();
  assert.ok(json.outcome, `${operationId}: ${JSON.stringify(json).slice(0, 400)}`);
  if (expected === "ok") {
    assert.equal(json.outcome.status, "ok", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 600)}`);
    return json.outcome.value;
  }
  if (expected === "denied") {
    assert.equal(json.outcome.status, "denied", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 400)}`);
    return json.outcome;
  }
  assert.equal(json.outcome.status, "tool_error", `${operationId}: ${JSON.stringify(json.outcome).slice(0, 600)}`);
  assert.equal(json.outcome.error.code, `tool.${expected}`, JSON.stringify(json.outcome.error));
  return json.outcome.error;
}

const values = (id, range, query = "") => sheets("GET", `/${id}/values/${enc(range)}${query}`);
const put = (id, range, rows, query = "?valueInputOption=USER_ENTERED") => sheets("PUT", `/${id}/values/${enc(range)}${query}`, { values: rows });
const append = (id, range, rows, query = "?valueInputOption=USER_ENTERED") => sheets("POST", `/${id}/values/${enc(`${range}:append`)}${query}`, { values: rows });
const batch = (id, requests, extra = {}, query = "") => sheets("POST", `/${enc(`${id}:batchUpdate`)}${query}`, { requests, ...extra });
const batchFails = (id, requests, status, name) => sheetsError("POST", `/${enc(`${id}:batchUpdate`)}`, status, name, { requests });
const qs = (params) => new URLSearchParams(params).toString();

// ---------------------------------------------------------------------------------------------
// Flow: values-read-write
// ---------------------------------------------------------------------------------------------

async function valuesReadWrite() {
  const table = await values(BUDGET, "Budget!A1:E12");
  assert.equal(table.range, "Budget!A1:E12");
  assert.equal(table.majorDimension, "ROWS");
  assert.deepEqual(table.values[0], ["Channel", "Budget", "Actual", "Variance", "Share of budget"]);
  assert.deepEqual(table.values[1], ["Paid Search", "$12,000.00", "$11,250.50", "-$749.50", "19.05%"]);
  assert.deepEqual(table.values[10], ["Total", "$63,000.00", "$63,365.50", "$365.50", "100.00%"]);
  assert.deepEqual(table.values[11], ["Next quarter (projected)", "$70,560.00", "100.58%", "#DIV/0!"], "trailing empty cells are trimmed");

  const raw = await values(BUDGET, "Budget!B11:D11", "?valueRenderOption=UNFORMATTED_VALUE");
  assert.deepEqual(raw.values, [[63000, 63365.5, 365.5]]);
  const formulas = await values(BUDGET, "Budget!D2:E2", "?valueRenderOption=FORMULA");
  assert.deepEqual(formulas.values, [["=C2-B2", "=B2/$B$11"]]);
  const columns = await values(BUDGET, "Budget!A1:B3", "?majorDimension=COLUMNS");
  assert.deepEqual(columns.values, [["Channel", "Paid Search", "Social Ads"], ["Budget", "$12,000.00", "$8,500.00"]]);
  const assumptions = await values(BUDGET, "Assumptions");
  assert.equal(assumptions.range, "Assumptions!A1:Z1000", "a bare sheet name is the whole grid");
  assert.deepEqual(assumptions.values[3], ["Quarter start", "2026-07-01"]);
  assert.deepEqual(assumptions.values[5], ["Days since quarter start", "75"], "TODAY() uses the world's virtual clock");
  const serials = await values(BUDGET, "Assumptions!B4", "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING");
  assert.deepEqual(serials.values, [["2026-07-01"]]);
  const cycle = await values(BUDGET, "'Owner''s Notes'!A1:B1");
  assert.equal(cycle.range, "'Owner''s Notes'!A1:B1");
  assert.deepEqual(cycle.values, [["#REF!", "#REF!"]], "a circular pair evaluates to #REF!");
  const summary = await values(PIPELINE, "Summary!B2:B7");
  assert.deepEqual(summary.values, [["17"], ["4"], ["7"], ["$38,000"], ["Negotiation"], ["$179,350"]]);

  const parse = await sheetsError("GET", `/${BUDGET}/values/${enc("Shet1!A1")}`, 400, "INVALID_ARGUMENT");
  assert.equal(parse.message, "Unable to parse range: Shet1!A1");
  await sheetsError("GET", `/${MISSING}/values/${enc("Sheet1!A1")}`, 404, "NOT_FOUND");
  await sheetsError("GET", `/${INVENTORY}/values/${enc("Counts!A1")}`, 404, "NOT_FOUND");

  // values.update ------------------------------------------------------------------------------------
  const updated = await put(BUDGET, "Budget!B2", [["$5,000"]], "?valueInputOption=USER_ENTERED&includeValuesInResponse=true");
  assert.equal(updated.updatedRange, "Budget!B2");
  assert.equal(updated.updatedCells, 1);
  assert.deepEqual(updated.updatedData.values, [["$5,000.00"]], "the cell keeps its existing currency format");
  assert.deepEqual((await values(BUDGET, "Budget!B11", "?valueRenderOption=UNFORMATTED_VALUE")).values, [[56000]], "totals recompute on read");
  const required = await sheetsError("PUT", `/${BUDGET}/values/${enc("Budget!B2")}`, 400, "INVALID_ARGUMENT", { values: [[1]] });
  assert.equal(required.message, "'valueInputOption' is required but not specified");
  const grid = await sheetsError("PUT", `/${BUDGET}/values/${enc("Budget!AA1")}?valueInputOption=RAW`, 400, "INVALID_ARGUMENT", { values: [["x"]] });
  assert.equal(grid.message, "Range (Budget!AA1) exceeds grid limits. Max rows: 1000, max columns: 26");
  const small = await sheetsError("PUT", `/${BUDGET}/values/${enc("Assumptions!A10:B10")}?valueInputOption=RAW`, 400, "INVALID_ARGUMENT", {
    values: [["a", "b", "c"]],
  });
  assert.ok(small.message.startsWith("Requested writing within range [Assumptions!A10:B10]"), small.message);
  await sheetsError("PUT", `/${MISSING}/values/${enc("Sheet1!A1")}?valueInputOption=RAW`, 404, "NOT_FOUND", { values: [[1]] });
  const trashed = await sheetsError("PUT", `/${VENDORS}/values/${enc("Vendors!A5")}?valueInputOption=RAW`, 400, "FAILED_PRECONDITION", { values: [["x"]] });
  assert.equal(trashed.message, "This document is in the trash.");
  const rawText = await put(UNTITLED, "Sheet1!A1:C1", [["=1+1", "'007", null]], "?valueInputOption=RAW");
  assert.equal(rawText.updatedCells, 2, "null cells are not written");
  assert.deepEqual((await values(UNTITLED, "Sheet1!A1:C1")).values, [["=1+1", "'007"]], "RAW keeps text verbatim");

  // values:batchGet ----------------------------------------------------------------------------------
  const batchGet = await sheets("GET", `/${BUDGET}/values:batchGet?${qs([["ranges", "Budget!A1:B2"], ["ranges", "Assumptions!A2:B3"], ["ranges", "'Owner''s Notes'!D1:E5"]])}`);
  assert.equal(batchGet.spreadsheetId, BUDGET);
  assert.equal(batchGet.valueRanges.length, 3);
  assert.deepEqual(batchGet.valueRanges[0].values, [["Channel", "Budget"], ["Paid Search", "$5,000.00"]]);
  assert.ok(!("values" in batchGet.valueRanges[2]), "an empty range has no values key");
  await sheetsError("GET", `/${BUDGET}/values:batchGet?${qs({ ranges: "Nope!A1" })}`, 400, "INVALID_ARGUMENT");
  await sheetsError("GET", `/${BUDGET}/values:batchGet`, 400, "INVALID_ARGUMENT");
  await sheetsError("GET", `/${MISSING}/values:batchGet?${qs({ ranges: "A1" })}`, 404, "NOT_FOUND");
  await sheetsError("GET", `/${BUDGET}/values:batchGetByDataFilter?${qs({ ranges: "A1" })}`, 404, "NOT_FOUND");

  // values:batchUpdate --------------------------------------------------------------------------------
  const multi = await sheets("POST", `/${BUDGET}/values:batchUpdate`, {
    valueInputOption: "USER_ENTERED",
    data: [
      { range: "Assumptions!A9:B9", values: [["Contingency", "5%"]] },
      { range: "Assumptions!A10", majorDimension: "COLUMNS", values: [["Owner"], ["Avery"]] },
    ],
  });
  assert.equal(multi.totalUpdatedCells, 4);
  assert.equal(multi.totalUpdatedSheets, 1);
  assert.equal(multi.responses[1].updatedRange, "Assumptions!A10:B10");
  assert.deepEqual((await values(BUDGET, "Assumptions!A9:B10")).values, [["Contingency", "5%"], ["Owner", "Avery"]]);
  await sheetsError("POST", `/${BUDGET}/values:batchUpdate`, 400, "INVALID_ARGUMENT", { data: [{ range: "A1", values: [[1]] }] });
  await sheetsError("POST", `/${MISSING}/values:batchUpdate`, 404, "NOT_FOUND", { valueInputOption: "RAW", data: [{ range: "A1", values: [[1]] }] });
  await sheetsError("POST", `/${BUDGET}/values:batchClear`, 404, "NOT_FOUND", { ranges: ["A1"] });
  await sheetsError("POST", `/${VENDORS}/values:batchUpdate`, 400, "FAILED_PRECONDITION", { valueInputOption: "RAW", data: [{ range: "A9", values: [[1]] }] });

  // canonical values.clear and values.update-formulas --------------------------------------------------------
  const cleared = await op("values.clear", { spreadsheetId: BUDGET, range: "Assumptions!A9:B10" });
  assert.equal(cleared.clearedRange, "Assumptions!A9:B10");
  assert.ok(!("values" in (await values(BUDGET, "Assumptions!A9:B10"))));
  await op("values.clear", { spreadsheetId: BUDGET, range: "Bogus!!A1" }, "INVALID_ARGUMENT");
  await op("values.clear", { spreadsheetId: MISSING, range: "A1" }, "NOT_FOUND");
  await op("values.clear", { spreadsheetId: VENDORS, range: "Vendors!A1" }, "FAILED_PRECONDITION");
  const withFormulas = await op("values.update-formulas", { spreadsheetId: UNTITLED, range: "Sheet1!A3:C3", formulas: [["2", "3", "=SUM(A3:B3)"]] });
  assert.equal(withFormulas.updatedCells, 3);
  assert.deepEqual((await values(UNTITLED, "Sheet1!C3", "?valueRenderOption=UNFORMATTED_VALUE")).values, [[5]]);
  await op("values.update-formulas", { spreadsheetId: UNTITLED, range: "R1C1", formulas: [["=1"]] }, "INVALID_ARGUMENT");
  await op("values.update-formulas", { spreadsheetId: MISSING, range: "A1", formulas: [["=1"]] }, "NOT_FOUND");
  await op("values.update-formulas", { spreadsheetId: VENDORS, range: "Vendors!A1", formulas: [["=1"]] }, "FAILED_PRECONDITION");
  const unknown = await values(UNTITLED, "Sheet1!D3:E3", "");
  assert.ok(!("values" in unknown));
  await op("values.update-formulas", { spreadsheetId: UNTITLED, range: "Sheet1!D3", formulas: [["=XLOOKUP(1,A3:A3,B3:B3)"]] });
  assert.deepEqual((await values(UNTITLED, "Sheet1!D3")).values, [["#NAME?"]]);

  // response byte budget ------------------------------------------------------------------------------------
  // Eight 50,000-character CJK cells hold 1.2 MB of UTF-8. Reads that would encode past the 900,000-byte response limit
  // answer INVALID_ARGUMENT (never a framework 500 or a silently shortened range); smaller reads still return every cell.
  const cjk = "字".repeat(50_000);
  for (let row = 1; row <= 8; row += 1) await put(BUDGET, `Budget!Z${row}`, [[cjk]], "?valueInputOption=RAW");
  const tooLarge = "Response too large: the requested data exceeds the 900000-byte response limit. Request a smaller range, fewer ranges or less grid data.";
  assert.equal((await sheetsError("GET", `/${BUDGET}/values/${enc("Budget!Z1:Z8")}`, 400, "INVALID_ARGUMENT")).message, tooLarge);
  await sheetsError("GET", `/${BUDGET}/values:batchGet?ranges=${enc("Budget!Z1:Z3")}&ranges=${enc("Budget!Z4:Z6")}&ranges=${enc("Budget!A1:B2")}`, 400, "INVALID_ARGUMENT");
  await sheetsError("GET", `/${BUDGET}?includeGridData=true`, 400, "INVALID_ARGUMENT");
  await op("values.get", { spreadsheetId: BUDGET, range: "Budget!Z1:Z8" }, "INVALID_ARGUMENT");
  const five = await request("GET", `/v4/spreadsheets/${BUDGET}/values/${enc("Budget!Z1:Z5")}`);
  assert.ok(new TextEncoder().encode(five.text).length <= 900_000);
  assert.equal(five.json.values.length, 5);
  assert.ok(five.json.values.every((row) => row[0] === cjk));
  const pair = await sheets("GET", `/${BUDGET}/values:batchGet?ranges=${enc("Budget!Z1:Z2")}&ranges=${enc("Budget!A1:B1")}`);
  assert.deepEqual(pair.valueRanges.map((range) => range.values.length), [2, 1]);
  const cell = await sheets("GET", `/${BUDGET}?includeGridData=true&ranges=${enc("Budget!Z1")}`);
  assert.equal(cell.sheets[0].data[0].rowData[0].values[0].formattedValue, cjk);
  // The budget measures the shape the `fields` mask actually sends: small masked reads of large grids still answer 200.
  const gridOf = (range, fields) => `/${BUDGET}?${qs([["includeGridData", "true"], ["ranges", range], ["fields", fields]])}`;
  const propsOnly = await sheets("GET", gridOf("Budget!Z1:Z8", "sheets(properties)"));
  assert.equal(propsOnly.sheets[0].properties.title, "Budget");
  assert.ok(!("data" in propsOnly.sheets[0]));
  assert.deepEqual(await sheets("GET", gridOf("Budget!Z1:Z8", "spreadsheetId")), { spreadsheetId: BUDGET });
  const formatted = await request("GET", `/v4/spreadsheets${gridOf("Budget!Z1:Z2", "sheets(data(rowData(values(formattedValue))))")}`);
  assert.ok(new TextEncoder().encode(formatted.text).length <= 900_000);
  assert.deepEqual(formatted.json.sheets[0].data[0].rowData.map((row) => row.values[0].formattedValue), [cjk, cjk]);
  assert.equal((await sheetsError("GET", gridOf("Budget!Z1:Z8", "sheets/data/rowData/values/formattedValue"), 400, "INVALID_ARGUMENT")).message, tooLarge);
  // A text formula result is bounded at 50,000 characters, as in Sheets.
  await put(BUDGET, "Budget!Y1:Y2", [["=Z1&Z2"], ['=LEFT(Z1,2)&"x"']]);
  assert.deepEqual((await values(BUDGET, "Budget!Y1:Y2")).values, [["#VALUE!"], ["字字x"]]);
  await op("values.clear", { spreadsheetId: BUDGET, range: "Budget!Y1:Z8" });
  assert.ok(!("values" in (await values(BUDGET, "Budget!Y1:Z8"))));

  // Deeply nested JSON bodies are refused by the codec (lib/json-depth.mjs, limit 512) before argument validation
  // recurses on them; the framework answers 400 rather than the opaque 500 the unguarded routes used to give.
  const nest = (depth, kind) => {
    let value = kind === "array" ? [] : {};
    for (let i = 0; i < depth; i += 1) value = kind === "array" ? [value] : { a: value };
    return value;
  };
  for (const [depth, kind] of [[600, "object"], [2950, "array"], [2998, "object"], [3152, "array"]]) {
    const deep = nest(depth, kind);
    const mapping = await request("PUT", `/v4/spreadsheets/${BUDGET}/values/${enc("Budget!B2")}?valueInputOption=RAW`, { body: { values: deep }, status: 400 });
    // Past roughly 3,100 levels the framework's own body parser refuses the bytes first (HTTP_BODY_INVALID); below
    // that the codec guard is what answers. Either way the request is 400 and never reaches argument validation.
    assert.ok(
      ["framework.HTTP_REQUEST_MAPPING_FAILED", "framework.HTTP_BODY_INVALID"].includes(mapping.json?.code),
      `${depth} ${kind}: ${mapping.text.slice(0, 200)}`,
    );
    await request("POST", `/v4/spreadsheets/${enc(`${BUDGET}:batchUpdate`)}`, { body: { requests: deep }, status: 400 });
    await request("POST", `/v4/spreadsheets/${BUDGET}/values/${enc("Budget!A1:E:append")}?valueInputOption=RAW`, { body: deep, status: 400 });
    await request("PATCH", `/drive/v3/files/${BUDGET}`, { body: { name: deep }, status: 400 });
  }
  // A body inside the bound still reaches the operation, which answers Google's own envelope.
  await sheetsError("PUT", `/${BUDGET}/values/${enc("Nope!B2")}?valueInputOption=RAW`, 400, "INVALID_ARGUMENT", { values: [["x"]], meta: nest(8, "object") });

  await fieldsMasks();
  await dependencyChains();
}

/** Google's `fields` system parameter on every Sheets route: decoded, applied, and 400 INVALID_ARGUMENT when unparseable. */
async function fieldsMasks() {
  const budgetA1 = `/${BUDGET}/values/${enc("Budget!A1:B2")}`;
  assert.deepEqual(await sheets("GET", `${budgetA1}?fields=range`), { range: "Budget!A1:B2" });
  assert.deepEqual(Object.keys(await sheets("GET", `${budgetA1}?fields=values,range`)), ["range", "values"], "masked fields keep the resource's order");
  assert.deepEqual(Object.keys(await sheets("GET", `${budgetA1}?fields=*`)), ["range", "majorDimension", "values"]);
  for (const mask of ["abc", "range(", "values/nope", "range,", "(range)"]) {
    const error = await sheetsError("GET", `${budgetA1}?${qs({ fields: mask })}`, 400, "INVALID_ARGUMENT");
    assert.match(error.message, /^Request contains an invalid argument: Invalid field selection /);
  }
  const batchGet = await sheets("GET", `/${BUDGET}/values:batchGet?${qs([["ranges", "Budget!A1:B2"], ["ranges", "Budget!D2"], ["fields", "valueRanges(range)"]])}`);
  assert.deepEqual(batchGet, { valueRanges: [{ range: "Budget!A1:B2" }, { range: "Budget!D2" }] });
  await sheetsError("GET", `/${BUDGET}/values:batchGet?${qs([["ranges", "Budget!A1:B2"], ["fields", "valueRanges/nope"]])}`, 400, "INVALID_ARGUMENT");

  // An invalid mask on a write is refused before the write: the append is not applied, so the table is unchanged.
  const before = await values(BUDGET, "Budget!A1:A");
  await sheetsError("POST", `/${BUDGET}/values/${enc("Budget!A1:append")}?valueInputOption=RAW&fields=abc`, 400, "INVALID_ARGUMENT", { values: [["never"]] });
  assert.deepEqual(await values(BUDGET, "Budget!A1:A"), before, "a refused mask applies no write");
  await sheetsError("PUT", `/${BUDGET}/values/${enc("Budget!T1")}?valueInputOption=RAW&fields=bad(`, 400, "INVALID_ARGUMENT", { values: [["never"]] });
  await sheetsError("POST", `/${BUDGET}/values:batchUpdate?fields=zzz`, 400, "INVALID_ARGUMENT", { valueInputOption: "RAW", data: [{ range: "Budget!T1", values: [["never"]] }] });
  assert.deepEqual(await values(BUDGET, "Budget!T1"), { range: "Budget!T1", majorDimension: "ROWS" }, "T1 is still empty");
  await sheetsError("POST", "?fields=nope", 400, "INVALID_ARGUMENT", { properties: { title: "Never created" } });
  await batchMaskFails(BUDGET, "zzz", [{ addSheet: { properties: { title: "Never added" } } }]);
  await sheetsError("POST", `/${BUDGET}/sheets/${enc("0:copyTo")}?fields=abc`, 400, "INVALID_ARGUMENT", { destinationSpreadsheetId: BUDGET });
  const titles = (await sheets("GET", `/${BUDGET}?fields=sheets(properties(title))`)).sheets.map((sheet) => sheet.properties.title);
  assert.ok(!titles.includes("Never added") && !titles.includes("Copy of Budget"), "refused masks left the sheet list unchanged");

  // Valid masks are applied to every response shape.
  const appended = await sheets("POST", `/${BUDGET}/values/${enc("Budget!A1:append")}?valueInputOption=RAW&fields=updates(updatedRange,updatedCells)`, { values: [["Masked append"]] });
  assert.deepEqual(Object.keys(appended), ["updates"]);
  assert.deepEqual(Object.keys(appended.updates), ["updatedRange", "updatedCells"]);
  assert.match(appended.updates.updatedRange, /^Budget!A\d+$/);
  assert.deepEqual(await sheets("PUT", `/${BUDGET}/values/${enc("Budget!T1")}?valueInputOption=RAW&fields=updatedCells`, { values: [["u"]] }), { updatedCells: 1 });
  const batchUpdated = await sheets("POST", `/${BUDGET}/values:batchUpdate?fields=totalUpdatedCells,responses/updatedRange`, { valueInputOption: "RAW", data: [{ range: "Budget!T2", values: [["v"]] }] });
  assert.deepEqual(batchUpdated, { totalUpdatedCells: 1, responses: [{ updatedRange: "Budget!T2" }] });
  const created = await sheets("POST", "?fields=spreadsheetId,properties/title", { properties: { title: "Masked create" } });
  assert.deepEqual(created, { spreadsheetId: created.spreadsheetId, properties: { title: "Masked create" } });
  assert.deepEqual(Object.keys(await batch(BUDGET, [{ addSheet: { properties: { title: "Masked add" } } }], {}, "?fields=spreadsheetId")), ["spreadsheetId"]);
  const copied = await sheets("POST", `/${BUDGET}/sheets/${enc("0:copyTo")}?fields=title,sheetId`, { destinationSpreadsheetId: BUDGET });
  assert.deepEqual(Object.keys(copied), ["sheetId", "title"]);
  assert.equal(copied.title, "Copy of Budget");
  // The canonical operation validates the same argument and returns the unmasked value (masks are a REST concern).
  await op("values.get", { spreadsheetId: BUDGET, range: "Budget!A1:B2", fields: "abc" }, "INVALID_ARGUMENT");
  await op("sheets.copy-to", { spreadsheetId: BUDGET, sheetId: 0, destinationSpreadsheetId: BUDGET, fields: "abc" }, "INVALID_ARGUMENT");
  assert.equal((await op("values.get", { spreadsheetId: BUDGET, range: "Budget!A1:B2", fields: "range" })).majorDimension, "ROWS");
}

const batchMaskFails = (id, mask, requests) => sheetsError("POST", `/${enc(`${id}:batchUpdate`)}?${qs({ fields: mask })}`, 400, "INVALID_ARGUMENT", { requests });

/**
 * Long dependency chains: a running total over hundreds of rows reads correctly however deep, because the evaluator
 * suspends and resumes across an explicit stack instead of recursing on the chain (the read is bounded by cell visits,
 * not by a small nesting depth). Deeply parenthesised formulas on every level and a cycle that spans a suspension are
 * exercised too.
 */
async function dependencyChains() {
  const rows = 300;
  const chain = [[1]];
  for (let row = 2; row <= rows; row += 1) chain.push([`=U${row - 1}+1`]);
  await put(BUDGET, `Budget!U1:U${rows}`, chain);
  const unformatted = "?valueRenderOption=UNFORMATTED_VALUE";
  assert.deepEqual((await values(BUDGET, `Budget!U${rows}`, unformatted)).values, [[rows]], "the end of a 300-row running total reads");
  assert.deepEqual((await values(BUDGET, "Budget!U66", unformatted)).values, [[66]]);
  const whole = await values(BUDGET, `Budget!U1:U${rows}`, unformatted);
  assert.equal(whole.values.length, rows);
  assert.deepEqual(whole.values[rows - 1], [rows]);
  // Every level nested 58 parentheses deep inside IF and IFERROR: the stack still stays bounded.
  const nested = [[1]];
  for (let row = 2; row <= rows; row += 1) nested.push([`=IFERROR(IF(TRUE,${"(".repeat(58)}V${row - 1}${")".repeat(58)}+1,0),0)`]);
  await put(BUDGET, `Budget!V1:V${rows}`, nested);
  assert.deepEqual((await values(BUDGET, `Budget!V${rows}`, unformatted)).values, [[rows]]);
  // Wide over deep: a SUM across every member of the chain.
  await put(BUDGET, "Budget!T3", [[`=SUM(U1:U${rows})`]]);
  assert.deepEqual((await values(BUDGET, "Budget!T3", unformatted)).values, [[(rows * (rows + 1)) / 2]]);
  // A cycle that closes across a suspended cell is still a circular reference, never a hang or a wrong number.
  await put(BUDGET, "Budget!U1", [[`=U${rows}`]]);
  assert.deepEqual((await values(BUDGET, `Budget!U${rows}`)).values, [["#REF!"]]);
  assert.deepEqual((await values(BUDGET, "Budget!U3")).values, [["#REF!"]]);
  assert.deepEqual((await values(BUDGET, "Budget!T3")).values, [["#REF!"]]);
}

// ---------------------------------------------------------------------------------------------
// Flow: append-table
// ---------------------------------------------------------------------------------------------

async function appendTable() {
  const before = await values(PIPELINE, "Leads!A1:F");
  assert.equal(before.values.length, 19);
  assert.deepEqual(before.values[16], [], "the gap row inside the data is an empty row");

  const inserted = await append(PIPELINE, "Leads!A1:F", [["Delta Dynamics", "Kai Wong", "Won", "$1,000", "2026-10-01", "Avery Chen"]], "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS");
  assert.equal(inserted.tableRange, "Leads!A1:F16", "the table stops at the first empty row");
  assert.equal(inserted.updates.updatedRange, "Leads!A17:F17");
  const summaryFormula = await values(PIPELINE, "Summary!B2", "?valueRenderOption=FORMULA");
  assert.deepEqual(summaryFormula.values, [["=COUNTA(Leads!A2:A20)"]], "INSERT_ROWS rewrites references that span the insertion");
  assert.deepEqual((await values(PIPELINE, "Summary!B2:B3")).values, [["18"], ["5"]]);

  const overwrite = await append(PIPELINE, "Leads!A1:F", [["Nimbus Cloud", "Iris Park", "Lead", "9000", "12/20/2026", "Jordan Patel"]]);
  assert.equal(overwrite.tableRange, "Leads!A1:F17");
  assert.equal(overwrite.updates.updatedRange, "Leads!A18:F18", "OVERWRITE fills the gap row after the table");
  assert.equal(overwrite.updates.updatedCells, 6);
  const after = await values(PIPELINE, "Leads!A17:E18", "?valueRenderOption=UNFORMATTED_VALUE");
  assert.deepEqual(after.values[1], ["Nimbus Cloud", "Iris Park", "Lead", 9000, 46376]);
  assert.deepEqual((await values(PIPELINE, "Summary!B2")).values, [["19"]]);

  const columns = await append(UNTITLED, "Sheet1!A1", [["x", "y"]], "?valueInputOption=RAW");
  assert.ok(!("tableRange" in columns), "no table in an empty sheet");
  assert.equal(columns.updates.updatedRange, "Sheet1!A1:B1");

  await sheetsError("POST", `/${PIPELINE}/values/${enc("Leads!A1:F:clear")}`, 404, "NOT_FOUND", {});
  await sheetsError("POST", `/${PIPELINE}/values/${enc("Leads!A1:F:append")}`, 400, "INVALID_ARGUMENT", { values: [["no option"]] });
  await sheetsError("POST", `/${MISSING}/values/${enc("A1:append")}?valueInputOption=RAW`, 404, "NOT_FOUND", { values: [["x"]] });
  await sheetsError("POST", `/${VENDORS}/values/${enc("Vendors!A1:append")}?valueInputOption=RAW`, 400, "FAILED_PRECONDITION", { values: [["x"]] });
}

// ---------------------------------------------------------------------------------------------
// Flow: structure-batch
// ---------------------------------------------------------------------------------------------

async function structureBatch() {
  const spreadsheet = await sheets("GET", `/${BUDGET}?${qs([["ranges", "Budget!A1:B2"], ["includeGridData", "true"]])}`);
  assert.equal(spreadsheet.properties.title, "Q3 Marketing Budget");
  assert.equal(spreadsheet.sheets.length, 1, "with ranges only the matching sheet is returned");
  const cell = spreadsheet.sheets[0].data[0].rowData[1].values[1];
  assert.deepEqual(cell.userEnteredValue, { numberValue: 12000 });
  assert.equal(cell.formattedValue, "$12,000.00");
  assert.equal(cell.userEnteredFormat.numberFormat.type, "CURRENCY");
  const meta = await sheets("GET", `/${BUDGET}?fields=${enc("sheets(properties(title,hidden)),namedRanges")}`);
  assert.deepEqual(Object.keys(meta).sort(), ["namedRanges", "sheets"]);
  assert.deepEqual(meta.sheets[2], { properties: { title: "Owner's Notes", hidden: true } });
  await sheetsError("GET", `/${BUDGET}?fields=bogus`, 400, "INVALID_ARGUMENT");
  await sheetsError("GET", `/${MISSING}`, 404, "NOT_FOUND");
  const mcpShape = await op("spreadsheets.get", { spreadsheetId: UNTITLED, includeGridData: true });
  assert.deepEqual(mcpShape.sheets[0].data, [{ rowData: [] }]);

  const result = await batch(BUDGET, [
    { addSheet: { properties: { title: "Scratch", gridProperties: { rowCount: 50, columnCount: 5 } } } },
    { updateSheetProperties: { properties: { sheetId: 0, title: "Budget FY26" }, fields: "title" } },
    { insertDimension: { range: { sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 }, inheritFromBefore: false } },
    { repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 5 }, cell: { userEnteredFormat: { textFormat: { italic: true } } }, fields: "userEnteredFormat.textFormat.italic" } },
    { findReplace: { find: "Email", replacement: "Newsletter", allSheets: true, matchEntireCell: true } },
    { sortRange: { range: { sheetId: 0, startRowIndex: 2, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: 3 }, sortSpecs: [{ dimensionIndex: 1, sortOrder: "DESCENDING" }] } },
    { addNamedRange: { namedRange: { name: "Channels", range: { sheetId: 0, startRowIndex: 2, endRowIndex: 11, startColumnIndex: 0, endColumnIndex: 1 } } } },
    { duplicateSheet: { sourceSheetId: ASSUMPTIONS } },
    { updateCells: { start: { sheetId: 0, rowIndex: 1, columnIndex: 0 }, rows: [{ values: [{ userEnteredValue: { stringValue: "(inserted)" } }] }], fields: "userEnteredValue" } },
    { appendDimension: { sheetId: 0, dimension: "COLUMNS", length: 2 } },
    { deleteDimension: { range: { sheetId: 0, dimension: "COLUMNS", startIndex: 26, endIndex: 28 } } },
    { updateSpreadsheetProperties: { properties: { title: "Q3 Marketing Budget (FY26)" }, fields: "title" } },
  ], { includeSpreadsheetInResponse: true });
  assert.equal(result.replies.length, 12);
  assert.equal(result.replies[0].addSheet.properties.title, "Scratch");
  assert.equal(result.replies[4].findReplace.occurrencesChanged, 1);
  assert.equal(result.replies[6].addNamedRange.namedRange.name, "Channels");
  assert.equal(result.replies[7].duplicateSheet.properties.title, "Copy of Assumptions");
  assert.equal(result.updatedSpreadsheet.properties.title, "Q3 Marketing Budget (FY26)");
  assert.deepEqual((await values(BUDGET, "Assumptions!B7", "?valueRenderOption=FORMULA")).values, [["='Budget FY26'!B12/B3"]], "rename and row insert rewrite formulas");
  const reordered = await values(BUDGET, "'Budget FY26'!A2:C4");
  assert.deepEqual(reordered.values, [["(inserted)"], ["Events", "$15,000.00", "$16,400.00"], ["Paid Search", "$12,000.00", "$11,250.50"]], "sorted by budget, descending");
  assert.deepEqual((await values(BUDGET, "'Budget FY26'!B12", "?valueRenderOption=UNFORMATTED_VALUE")).values, [[63000]]);
  assert.deepEqual((await values(BUDGET, "Channels")).values.flat().includes("Newsletter"), true);

  await batch(BUDGET, [{ deleteNamedRange: { namedRangeId: result.replies[6].addNamedRange.namedRange.namedRangeId } }, { deleteSheet: { sheetId: result.replies[0].addSheet.properties.sheetId } }]);
  const invalid = await batchFails(BUDGET, [{ addSheet: { properties: { title: "Temp" } } }, { addSheet: { properties: { title: "Temp 2" } } }, { addSheet: { properties: { title: "temp" } } }], 400, "INVALID_ARGUMENT");
  assert.equal(invalid.message, 'Invalid requests[2].addSheet: A sheet with the name "temp" already exists. Please enter another name.');
  const titles = (await sheets("GET", `/${BUDGET}?fields=${enc("sheets(properties(title))")}`)).sheets.map((sheet) => sheet.properties.title);
  assert.deepEqual(titles, ["Budget FY26", "Assumptions", "Copy of Assumptions", "Owner's Notes"], "a failed batch applies nothing");
  assert.equal((await batchFails(UNTITLED, [{ deleteSheet: { sheetId: 0 } }], 400, "INVALID_ARGUMENT")).message, "Invalid requests[0].deleteSheet: You can't remove all the sheets in a document.");
  assert.ok((await batchFails(BUDGET, [{ mergeCells: { range: { sheetId: 0 } } }], 400, "INVALID_ARGUMENT")).message.includes("not supported"));
  await batchFails(BUDGET, [{ findReplace: { find: "a.*", searchByRegex: true, allSheets: true } }], 400, "INVALID_ARGUMENT");
  // A replacement is sized before it is built: growing any cell past 50,000 characters is refused and changes nothing.
  const grown = await batchFails(BUDGET, [{ findReplace: { find: "a", replacement: "b".repeat(50_000), allSheets: true } }], 400, "INVALID_ARGUMENT");
  assert.equal(grown.message, "Invalid requests[0].findReplace: the replaced text of a cell exceeds 50000 characters");
  // Caller field paths that name inherited object members are unsupported fields, not crashes.
  for (const path of ["__proto__", "constructor", "toString"]) {
    const reply = await batchFails(BUDGET, [{ repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: {} }, fields: path } }], 400, "INVALID_ARGUMENT");
    assert.equal(reply.message, `Invalid requests[0].repeatCell: field ${path} is not supported by this Tool`);
  }
  await batchFails(BUDGET, [{ deleteNamedRange: { namedRangeId: "nonexistent1" } }], 404, "NOT_FOUND");
  await batchFails(MISSING, [{ addSheet: {} }], 404, "NOT_FOUND");
  await batchFails(VENDORS, [{ addSheet: {} }], 400, "FAILED_PRECONDITION");
  await sheetsError("POST", `/${enc(`${BUDGET}:getByDataFilter`)}`, 404, "NOT_FOUND", { dataFilters: [] });

  // sheets.insert-dimension (MCP insert_dimension) -----------------------------------------------------------
  await op("sheets.insert-dimension", { spreadsheetId: UNTITLED, sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 2, inheritFromBefore: true }, "INVALID_ARGUMENT");
  await op("sheets.insert-dimension", { spreadsheetId: MISSING, sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 2 }, "NOT_FOUND");
  await op("sheets.insert-dimension", { spreadsheetId: VENDORS, sheetId: 0, dimension: "ROWS", startIndex: 0, endIndex: 2 }, "FAILED_PRECONDITION");
  const insertedColumns = await op("sheets.insert-dimension", { spreadsheetId: UNTITLED, sheetId: 0, dimension: "COLUMNS", startIndex: 26, endIndex: 28 });
  assert.deepEqual(insertedColumns, { spreadsheetId: UNTITLED, replies: [{}] });
  assert.equal((await sheets("GET", `/${UNTITLED}`)).sheets[0].properties.gridProperties.columnCount, 28);

  // sheets.copyTo --------------------------------------------------------------------------------------------------
  const copied = await sheets("POST", `/${BUDGET}/sheets/${enc(`${ASSUMPTIONS}:copyTo`)}`, { destinationSpreadsheetId: UNTITLED });
  assert.equal(copied.title, "Copy of Assumptions");
  assert.equal(copied.index, 1);
  assert.deepEqual((await values(UNTITLED, "'Copy of Assumptions'!A2:B2")).values, [["Growth rate", "12%"]]);
  await sheetsError("POST", `/${BUDGET}/sheets/${enc(`${ASSUMPTIONS}:copyTo`)}`, 404, "NOT_FOUND", { destinationSpreadsheetId: MISSING });
  await sheetsError("POST", `/${BUDGET}/sheets/${enc(`${ASSUMPTIONS}:copyTo`)}`, 403, "PERMISSION_DENIED", { destinationSpreadsheetId: OFFSITE });
  await sheetsError("POST", `/${BUDGET}/sheets/${enc(`${ASSUMPTIONS}:copyTo`)}`, 400, "FAILED_PRECONDITION", { destinationSpreadsheetId: VENDORS });
  await sheetsError("POST", `/${BUDGET}/sheets/${enc(`${ASSUMPTIONS}:moveTo`)}`, 404, "NOT_FOUND", { destinationSpreadsheetId: UNTITLED });

  // spreadsheets.create ---------------------------------------------------------------------------------------------
  const created = await sheets("POST", "", { properties: { title: "Launch checklist" }, sheets: [{ properties: { title: "Tasks", gridProperties: { rowCount: 100, columnCount: 8, frozenRowCount: 1 } } }] });
  assert.equal(created.spreadsheetId, `1fs${"0".repeat(40)}1`, "ids come from the counter row");
  assert.equal(created.sheets[0].properties.sheetId, 0);
  assert.deepEqual(created.sheets[0].properties.gridProperties, { rowCount: 100, columnCount: 8, frozenRowCount: 1 });
  const file = await drive("GET", `/files/${created.spreadsheetId}`);
  assert.equal(file.name, "Launch checklist");
  assert.equal(file.owners[0].emailAddress, AVERY);
  await sheetsError("POST", "", 400, "INVALID_ARGUMENT", { properties: { title: "Localized", locale: "fr_FR" } });
}

// ---------------------------------------------------------------------------------------------
// Flow: drive-files-sharing
// ---------------------------------------------------------------------------------------------

async function driveFilesSharing() {
  const first = await drive("GET", `/files?${qs({ pageSize: "3" })}`);
  assert.equal(first.kind, "drive#fileList");
  assert.deepEqual(first.files.map((file) => file.name), ["Q3 Marketing Budget", "Customer Pipeline 2026", "Hiring Tracker"]);
  assert.ok(first.nextPageToken);
  const second = await drive("GET", `/files?${qs({ pageSize: "3", pageToken: first.nextPageToken })}`);
  assert.deepEqual(second.files.map((file) => file.name), ["Team Offsite Planning", "Untitled spreadsheet"]);
  assert.ok(!("nextPageToken" in second));
  await driveError("GET", `/files?${qs({ pageToken: "not-a-token" })}`, 400, "badRequest");
  await driveError("GET", `/files?${qs({ q: "modifiedTime > '2026-09-10T00:00:00'" })}`, 400, "invalid");
  await driveError("GET", `/files?${qs({ q: "'root' in parents" })}`, 400, "invalid");
  assert.deepEqual((await drive("GET", `/files?${qs({ q: "trashed = true" })}`)).files.map((file) => file.id), [VENDORS]);
  assert.deepEqual((await drive("GET", `/files?${qs({ q: "sharedWithMe = true", orderBy: "name" })}`)).files.map((file) => file.id), [HIRING, OFFSITE]);
  assert.deepEqual((await drive("GET", `/files?${qs({ q: "name contains 'budget' and starred = true" })}`)).files.map((file) => file.id), [BUDGET]);
  assert.equal((await drive("GET", `/files?${qs({ q: "modifiedTime > '2026-09-10T12:00:00Z'" })}`)).files.length, 3);
  const masked = await drive("GET", `/files?${qs({ q: `'${AVERY}' in owners`, fields: "files(id,capabilities(canShare))", orderBy: "name" })}`);
  assert.equal(masked.files.length, 3);
  assert.deepEqual(masked.files[0], { id: PIPELINE, capabilities: { canShare: true } });

  const offsite = await drive("GET", `/files/${OFFSITE}`);
  assert.equal(offsite.capabilities.canEdit, false, "a commenter cannot edit");
  assert.equal(offsite.ownedByMe, false);
  await driveError("GET", `/files/${INVENTORY}`, 404, "notFound");
  await driveError("GET", `/files/${BUDGET}?fields=bogus`, 400, "invalidParameter");

  const renamed = await drive("PATCH", `/files/${PIPELINE}`, { name: "Customer Pipeline FY26", starred: true });
  assert.equal(renamed.name, "Customer Pipeline FY26");
  assert.equal(renamed.starred, true);
  assert.equal((await sheets("GET", `/${PIPELINE}`)).properties.title, "Customer Pipeline FY26", "the Drive name is the Sheets title");
  await driveError("PATCH", `/files/${MISSING}`, 404, "notFound", { starred: true });
  await driveError("PATCH", `/files/${PIPELINE}`, 400, "invalid", { name: "" });
  await driveError("PATCH", `/files/${OFFSITE}`, 403, "insufficientFilePermissions", { name: "Mine now" });
  const starredOnly = await drive("PATCH", `/files/${OFFSITE}`, { starred: true });
  assert.equal(starredOnly.starred, true, "starring is per user and needs no edit rights");

  const copy = await drive("POST", `/files/${PIPELINE}/copy`, { name: "Pipeline snapshot" });
  assert.equal(copy.name, "Pipeline snapshot");
  assert.equal(copy.ownedByMe, true);
  assert.deepEqual((await values(copy.id, "Summary!B2")).values, [["17"]]);
  await driveError("POST", `/files/${MISSING}/copy`, 404, "notFound", {});
  // The copy route validates its `fields` mask and name before copying: Drive's 400 envelope, nothing created.
  const badMask = await driveError("POST", `/files/${PIPELINE}/copy?fields=abc`, 400, "invalidParameter", {});
  assert.equal(badMask.errors[0].location, "fields");
  for (const mask of ["id,(", "*/x", "files(id)"]) await driveError("POST", `/files/${PIPELINE}/copy?${qs({ fields: mask })}`, 400, "invalidParameter", {});
  await driveError("POST", `/files/${PIPELINE}/copy`, 400, "invalid", { name: "" });
  const maskedCopy = await drive("POST", `/files/${PIPELINE}/copy?${qs({ fields: "id,name" })}`, { name: "Masked snapshot" });
  assert.deepEqual(Object.keys(maskedCopy).sort(), ["id", "kind", "name"]);
  await drive("DELETE", `/files/${maskedCopy.id}`);
  await driveError("POST", `/files/${VENDORS}/copy`, 400, "failedPrecondition", {});

  const granted = await drive("POST", `/files/${PIPELINE}/permissions`, { type: "user", role: "writer", emailAddress: SAM });
  assert.equal(granted.id, "10000000000000000004");
  assert.equal(granted.role, "writer");
  const upgraded = await drive("POST", `/files/${PIPELINE}/permissions`, { type: "domain", role: "reader", domain: "example.test" });
  assert.equal(upgraded.type, "domain");
  const page1 = await drive("GET", `/files/${PIPELINE}/permissions?pageSize=1`);
  assert.equal(page1.permissions[0].role, "owner");
  const page2 = await drive("GET", `/files/${PIPELINE}/permissions?${qs({ pageSize: "1", pageToken: page1.nextPageToken })}`);
  const page3 = await drive("GET", `/files/${PIPELINE}/permissions?${qs({ pageSize: "1", pageToken: page2.nextPageToken })}`);
  assert.deepEqual([page2.permissions[0].id, page3.permissions[0].id].sort(), [upgraded.id, granted.id].sort(), "three single-item pages, no overlap");
  assert.ok(!("nextPageToken" in page3));
  await driveError("GET", `/files/${PIPELINE}/permissions?pageToken=zzz`, 400, "badRequest");
  await driveError("GET", `/files/${INVENTORY}/permissions`, 404, "notFound");
  await drive("DELETE", `/files/${PIPELINE}/permissions/${upgraded.id}`);
  await driveError("DELETE", `/files/${PIPELINE}/permissions/99999999999999999999`, 404, "notFound");
  await driveError("DELETE", `/files/${PIPELINE}/permissions/10000000000000000001`, 400, "cannotDeletePermission");
  await driveError("DELETE", `/files/${OFFSITE}/permissions/10000000000000000001`, 403, "insufficientFilePermissions");
  await driveError("POST", `/files/${PIPELINE}/permissions?transferOwnership=true`, 400, "invalidSharingRequest", { type: "user", role: "writer", emailAddress: SAM });
  await driveError("POST", `/files/${MISSING}/permissions`, 404, "notFound", { type: "anyone", role: "reader" });
  await driveError("POST", `/files/${OFFSITE}/permissions`, 403, "insufficientFilePermissions", { type: "anyone", role: "reader" });
  await driveError("POST", `/files/${PIPELINE}/permissions`, 400, "failedPrecondition", { type: "user", role: "reader", emailAddress: AVERY });

  await drive("DELETE", `/files/${copy.id}`);
  await driveError("GET", `/files/${copy.id}`, 404, "notFound");
  await driveError("DELETE", `/files/${MISSING}`, 404, "notFound");
  await driveError("DELETE", `/files/${OFFSITE}`, 403, "insufficientFilePermissions");

  const about = await drive("GET", "/about?fields=user");
  assert.deepEqual(about.user, { kind: "drive#user", displayName: "Avery Chen", emailAddress: AVERY, me: true, permissionId: "10000000000000000001" });
  const full = await drive("GET", "/about");
  assert.ok(!("serverTime" in full) && !("limits" in full), "the REST About carries no app-only fields");
  assert.equal((await op("about.get", {})).serverTime, "2026-09-14T15:00:00.000Z");
  await driveError("GET", "/about?fields=bogus", 400, "invalidParameter");
}

// ---------------------------------------------------------------------------------------------
// Flow: roles-and-denial (Morgan: reader on the budget)
// ---------------------------------------------------------------------------------------------

async function rolesAndDenial() {
  assert.deepEqual((await values(BUDGET, "Budget!A2:B2")).values, [["Paid Search", "$12,000.00"]], "a reader can read");
  const denied = await sheetsError("PUT", `/${BUDGET}/values/${enc("Budget!B2")}?valueInputOption=RAW`, 403, "PERMISSION_DENIED", { values: [[1]] });
  assert.equal(denied.message, "The caller does not have permission");
  await sheetsError("POST", `/${BUDGET}/values/${enc("Budget!A1:E:append")}?valueInputOption=RAW`, 403, "PERMISSION_DENIED", { values: [["x"]] });
  await sheetsError("POST", `/${BUDGET}/values:batchUpdate`, 403, "PERMISSION_DENIED", { valueInputOption: "RAW", data: [{ range: "Budget!B2", values: [[1]] }] });
  await batchFails(BUDGET, [{ addSheet: {} }], 403, "PERMISSION_DENIED");
  await op("values.update-formulas", { spreadsheetId: BUDGET, range: "Budget!B2", formulas: [["=1"]] }, "PERMISSION_DENIED");
  await op("values.clear", { spreadsheetId: BUDGET, range: "Budget!B2" }, "PERMISSION_DENIED");
  await op("sheets.insert-dimension", { spreadsheetId: BUDGET, sheetId: 0, dimension: "ROWS", startIndex: 1, endIndex: 2 }, "PERMISSION_DENIED");
  await driveError("PATCH", `/files/${BUDGET}`, 403, "insufficientFilePermissions", { trashed: true });
  await driveError("DELETE", `/files/${BUDGET}`, 403, "insufficientFilePermissions");
  await driveError("POST", `/files/${BUDGET}/permissions`, 403, "insufficientFilePermissions", { type: "anyone", role: "reader" });
  const counts = await values(INVENTORY, "Counts!A2:A5", "?majorDimension=COLUMNS");
  assert.deepEqual(counts.values, [["SKU-1001", "SKU-1002", "SKU-1003", "SKU-1004"]], "Morgan sees the inventory shared with her");
  const hiring = await sheets("GET", `/${HIRING}?${qs({ ranges: "Candidates!C2", includeGridData: "true" })}`);
  assert.equal(hiring.sheets[0].data[0].rowData[0].values[0].note, "Phone screen moved to Sep 16");
  assert.equal((await values(BUDGET, "Budget!B2", "?valueRenderOption=UNFORMATTED_VALUE")).values[0][0], 12000, "denied writes changed nothing");
}

// ---------------------------------------------------------------------------------------------
// Flow: grant-denied (Avery's identity with read grants only)
// ---------------------------------------------------------------------------------------------

async function grantDenied() {
  assert.equal((await values(BUDGET, "Budget!A1")).values[0][0], "Channel");
  await request("PUT", `/v4/spreadsheets/${BUDGET}/values/${enc("Budget!B2")}?valueInputOption=RAW`, { body: { values: [[1]] }, status: 403 });
  await op("values.update-formulas", { spreadsheetId: BUDGET, range: "Budget!B2", formulas: [["=1"]] }, "denied");
  await request("POST", `/drive/v3/files/${BUDGET}/permissions`, { body: { type: "anyone", role: "reader" }, status: 403 });
  assert.equal((await drive("GET", "/files")).files.length, 5);
}

// ---------------------------------------------------------------------------------------------
// Flow: fresh-identity (no attributes)
// ---------------------------------------------------------------------------------------------

async function freshIdentity() {
  const about = await drive("GET", "/about");
  assert.equal(about.user.emailAddress, AVERY, "an attribute-less actor is the primary seeded user");
  const files = await drive("GET", "/files");
  assert.equal(files.files.length, 5);
  assert.equal((await values(BUDGET, "Budget!A11:B11")).values[0][1], "$63,000.00");
  const created = await sheets("POST", "", { properties: { title: "Fresh install check" } });
  assert.equal((await drive("GET", `/files/${created.spreadsheetId}`)).owners[0].emailAddress, AVERY);
}

// ---------------------------------------------------------------------------------------------
// Fault flows
// ---------------------------------------------------------------------------------------------

async function rateLimited() {
  const limited = await sheetsError("PUT", `/${BUDGET}/values/${enc("Budget!B2")}?valueInputOption=RAW`, 429, "RESOURCE_EXHAUSTED", { values: [[1]] });
  assert.equal(limited.headers.get("retry-after"), "30");
  await sheetsError("POST", "", 429, "RESOURCE_EXHAUSTED", { properties: { title: "x" } });
  await batchFails(BUDGET, [{ addSheet: {} }], 429, "RESOURCE_EXHAUSTED");
  await sheetsError("POST", `/${BUDGET}/values/${enc("Budget!A1:E:append")}?valueInputOption=RAW`, 429, "RESOURCE_EXHAUSTED", { values: [["x"]] });
  await sheetsError("POST", `/${BUDGET}/values:batchUpdate`, 429, "RESOURCE_EXHAUSTED", { valueInputOption: "RAW", data: [{ range: "A1", values: [[1]] }] });
  await op("values.update-formulas", { spreadsheetId: BUDGET, range: "Budget!B2", formulas: [["=1"]] }, "RATE_LIMITED");
  const drivePatch = await driveError("PATCH", `/files/${BUDGET}`, 403, "userRateLimitExceeded", { starred: false });
  assert.equal(drivePatch.headers.get("retry-after"), "30");
  await driveError("POST", `/files/${BUDGET}/copy`, 403, "userRateLimitExceeded", {});
  await driveError("POST", `/files/${BUDGET}/permissions`, 403, "userRateLimitExceeded", { type: "anyone", role: "reader" });
  assert.equal((await values(BUDGET, "Budget!B2")).values[0][0], "$12,000.00", "reads keep working and nothing changed");
}

async function backendUnavailable() {
  await sheetsError("GET", `/${BUDGET}`, 503, "UNAVAILABLE");
  await sheetsError("GET", `/${BUDGET}/values/${enc("Budget!A1")}`, 503, "UNAVAILABLE");
  await sheetsError("GET", `/${BUDGET}/values:batchGet?${qs({ ranges: "Budget!A1" })}`, 503, "UNAVAILABLE");
  await sheetsError("PUT", `/${BUDGET}/values/${enc("Budget!B2")}?valueInputOption=RAW`, 503, "UNAVAILABLE", { values: [[1]] });
  assert.equal((await drive("GET", "/files")).files.length, 5, "Drive routes keep working");
}

async function appendLost() {
  const row = [["Quartz Robotics", "Ivy Chen", "Lead", 5000]];
  await sheetsError("POST", `/${PIPELINE}/values/${enc("Leads!A1:F:append")}?valueInputOption=RAW`, 503, "UNAVAILABLE", { values: row });
  await sheetsError("POST", `/${PIPELINE}/values/${enc("Leads!A1:F:append")}?valueInputOption=RAW`, 503, "UNAVAILABLE", { values: row });
  const table = await values(PIPELINE, "Leads!A17:D20");
  assert.deepEqual(table.values[0], ["Quartz Robotics", "Ivy Chen", "Lead", "5000"], "the first call committed into the gap row");
  assert.deepEqual(table.values[3], ["Quartz Robotics", "Ivy Chen", "Lead", "5000"], "the blind retry appended a duplicate after the table");
}

async function bounds() {
  const limits = (await op("about.get", {})).limits;
  assert.equal(limits.maxScanRows, 10);
  const scan = await sheetsError("GET", `/${PIPELINE}/values/${enc("Leads!A1:F")}`, 400, "FAILED_PRECONDITION");
  assert.equal(scan.message, "state exceeds the supported bound of 10 rows for a single read");
  await sheetsError("GET", `/${PIPELINE}/values:batchGet?${qs({ ranges: "Leads!A1:F" })}`, 400, "FAILED_PRECONDITION");
  await sheetsError("GET", `/${PIPELINE}?includeGridData=true`, 400, "FAILED_PRECONDITION");
  assert.deepEqual((await values(PIPELINE, "Leads!A1:B2")).values[0], ["Company", "Contact"], "small ranges still read");
  await sheetsError("POST", "", 400, "FAILED_PRECONDITION", { sheets: [1, 2, 3, 4, 5].map((n) => ({ properties: { title: `S${n}` } })) });
  await driveError("GET", "/files", 400, "failedPrecondition");
  await driveError("DELETE", `/files/${PIPELINE}`, 400, "failedPrecondition");
  await driveError("POST", `/files/${PIPELINE}/copy`, 400, "failedPrecondition", {});
  await driveError("POST", `/files/${BUDGET}/permissions`, 400, "failedPrecondition", { type: "user", role: "reader", emailAddress: SAM });
  // Offsite Planning holds 12 permission rows in this scenario: every Drive read of the file refuses instead of truncating
  // its sharing list (and the caller's role computed from it).
  const scanMessage = "state exceeds the supported bound of 10 rows for a single read";
  assert.equal((await driveError("GET", `/files/${OFFSITE}`, 400, "failedPrecondition")).message, scanMessage);
  assert.equal((await driveError("PATCH", `/files/${OFFSITE}`, 400, "failedPrecondition", { starred: true })).message, scanMessage);
  assert.equal((await driveError("GET", `/files/${OFFSITE}/permissions`, 400, "failedPrecondition")).message, scanMessage);

  const wide = [Array.from({ length: 21 }, (_, index) => index)];
  const cells = await sheetsError("PUT", `/${UNTITLED}/values/${enc("Sheet1!A1")}?valueInputOption=RAW`, 400, "FAILED_PRECONDITION", { values: wide });
  assert.equal(cells.message, "the request writes 21 cells, over the supported bound of 20 cells per write");
  await op("values.update-formulas", { spreadsheetId: UNTITLED, range: "Sheet1!A1", formulas: wide }, "FAILED_PRECONDITION");
  await sheetsError("POST", `/${UNTITLED}/values/${enc("Sheet1!A1:append")}?valueInputOption=RAW`, 400, "FAILED_PRECONDITION", { values: wide });
  await sheetsError("POST", `/${UNTITLED}/values:batchUpdate`, 400, "FAILED_PRECONDITION", { valueInputOption: "RAW", data: [{ range: "Sheet1!A1", values: wide }] });
  await op("values.clear", { spreadsheetId: PIPELINE, range: "Leads!A1:A2" }, "FAILED_PRECONDITION");
  await batchFails(UNTITLED, [1, 2, 3, 4].map((n) => ({ addSheet: { properties: { title: `Extra ${n}` } } })), 400, "FAILED_PRECONDITION");
  await op("sheets.insert-dimension", { spreadsheetId: PIPELINE, sheetId: 1530482212, dimension: "ROWS", startIndex: 1, endIndex: 2 }, "FAILED_PRECONDITION");
  await sheetsError("POST", `/${PIPELINE}/sheets/${enc("0:copyTo")}`, 400, "FAILED_PRECONDITION", { destinationSpreadsheetId: UNTITLED });

  // Formula evaluation bound: 16 cells over 10 rows are fine to write, but reading the chained total visits > 50 cells.
  const grid = Array.from({ length: 10 }, (_, index) => [index + 1, index < 5 ? "=SUM($A$1:$A$10)" : null, index === 0 ? "=SUM(B1:B5)" : null]);
  await put(UNTITLED, "Sheet1!A1:C10", grid);
  assert.deepEqual((await values(UNTITLED, "Sheet1!B1", "?valueRenderOption=UNFORMATTED_VALUE")).values, [[55]]);
  const visits = await sheetsError("GET", `/${UNTITLED}/values/${enc("Sheet1!C1")}`, 400, "FAILED_PRECONDITION");
  assert.equal(visits.message, "formula evaluation exceeds the supported bound of 50 cell visits for a single read");
}

const flows = {
  "values-read-write": valuesReadWrite,
  "append-table": appendTable,
  "structure-batch": structureBatch,
  "drive-files-sharing": driveFilesSharing,
  "roles-and-denial": rolesAndDenial,
  "grant-denied": grantDenied,
  "fresh-identity": freshIdentity,
  "rate-limited": rateLimited,
  "backend-unavailable": backendUnavailable,
  "append-lost": appendLost,
  bounds,
};

if (selected === undefined || flows[selected] === undefined) throw new Error(`Unknown drill instruction: ${instruction}`);
await flows[selected]();
process.stdout.write(JSON.stringify({ completed: true, flow: selected }));
