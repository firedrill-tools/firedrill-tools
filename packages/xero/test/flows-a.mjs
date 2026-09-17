// Settings reads and contacts flows.
import assert from "node:assert/strict";
import { MISSING, acc, api, con, get, mcp, mcpError, notFound, op, post, put, q, replayed, rpc, validation, xeroError } from "./lib.mjs";

export async function settingsReads() {
  const org = (await get("/Organisation")).json;
  assert.equal(org.Status, "OK");
  assert.equal(org.ProviderName, "Firedrill");
  assert.equal(org.DateTimeUTC, "/Date(1789423200000+0000)/");
  assert.equal(org.Organisations[0].Name, "Kōwhai Joinery Ltd");
  assert.equal(org.Organisations[0].tenantId, undefined, "tenantId stays internal");
  assert.equal(org.organisationDate, undefined, "organisationDate is stripped on the wire");
  assert.equal(typeof org.Id, "string");
  assert.equal((await get("/Accounts")).json.Accounts.length, 12);
  assert.equal((await get(`/Accounts${q({ where: 'Type=="BANK"' })}`)).json.Accounts.length, 2);
  const revenue = (await get(`/Accounts${q({ where: 'Status=="ACTIVE"&&Class=="REVENUE"', order: "Code DESC" })}`)).json.Accounts.map((a) => a.Code);
  assert.deepEqual(revenue, ["260", "200"]);
  assert.equal((await get(`/Accounts${q({ where: 'Name.Contains("timber")' })}`)).json.Accounts.length, 1);
  assert.equal((await get(`/Accounts/${acc(1)}`)).json.Accounts[0].Code, "090");
  await notFound("GET", "/Accounts/not-a-guid");
  await notFound("GET", `/Accounts/${MISSING}`);
  assert.equal((await get("/TaxRates")).json.TaxRates.length, 4);
  assert.equal((await get(`/TaxRates${q({ TaxType: "OUTPUT2" })}`)).json.TaxRates[0].EffectiveRate, 15);
  for (const where of ['Type=="BANK" &&', "Foo==1", 'Name.ToLower()=="x"']) await xeroError("GET", `/Accounts${q({ where })}`, 16);
  await xeroError("GET", `/Accounts?where=Type%3D%3D%ZZ%E0%A4`, 16);
  await xeroError("GET", `/TaxRates${q({ where: "EffectiveRate > \"x\"" })}`, 16);
  const missing = await api("GET", "/Organisation", { tenant: null, status: 403 });
  assert.equal(missing.json.Detail, "AuthorizationUnsuccessful");
  await api("GET", "/Accounts", { tenant: "11111111-2222-4333-8444-555555555555", status: 403 });
  assert.equal((await mcp("list-organisation-details", {})).organisationDate, "2026-09-15");
  // Malformed percent-encoding arrives as U+FFFD and must fail with Xero's own errors, never run a corrupted filter.
  for (const path of ["/Contacts?where=Name%3D%3D%22Ac%E0%A4%A%22", "/Contacts?where=Name%3D%3D%22x%EF%BF%BD%22", "/Contacts?order=Name%E0%A4%A",
    "/Invoices?where=Reference%3D%3D%22r%E0%A4%A%22", "/Invoices?order=Date%20DESC%E0%A4%A", "/Payments?where=Reference%3D%3D%22r%E0%A4%A%22",
    "/Payments?order=Date%E0%A4%A", "/Accounts?order=Code%E0%A4%A", "/TaxRates?TaxType=OUTPUT%E0%A4%A"]) await xeroError("GET", path, 16, { includes: "malformed encoding" });
  for (const path of ["/Contacts?searchTerm=ac%E0%A4%A", "/Invoices?searchTerm=INV%EF%BF%BD", "/Invoices?InvoiceNumbers=INV-0001%E0%A4%A"]) await xeroError("GET", path, 10, { includes: "malformed encoding" });
  await op("payments.list", { reference: "r\uFFFD" }, { code: "VALIDATION_EXCEPTION" });
  assert.equal((await get("/Contacts?searchTerm=ac%ZZ")).json.Contacts.length, 0, "%ZZ stays literal");
  assert.equal((await get("/Contacts?searchTerm=caf%C3%A9")).json.Contacts[0].Name, "Harbourside Café");
  assert.equal((await get(`/Contacts${q({ where: 'Name.Contains("Café")' })}`)).json.Contacts.length, 1);
  assert.equal((await get(`/Contacts${q({ where: 'Name.Contains("漢字🔥")' })}`)).json.Contacts.length, 0);
}

export async function contacts() {
  const all = (await get("/Contacts")).json;
  assert.equal(all.Contacts.length, 11);
  assert.equal(all.pagination, undefined);
  const sizes = [];
  for (let page = 1; page <= 4; page += 1) {
    const body = (await get(`/Contacts${q({ page, pageSize: 5 })}`)).json;
    sizes.push(body.Contacts.length);
    assert.equal(body.pagination.pageCount, 3);
    assert.equal(body.pagination.itemCount, 11);
  }
  assert.deepEqual(sizes, [5, 5, 1, 0]);
  assert.equal((await get(`/Contacts${q({ includeArchived: "true" })}`)).json.Contacts.length, 12);
  assert.deepEqual((await get(`/Contacts${q({ searchTerm: "harbour" })}`)).json.Contacts.map((c) => c.Name).sort(), ["Harbour Lights Motel", "Harbourside Café"]);
  assert.equal((await get(`/Contacts${q({ IDs: `${con(1)},${con(2)}` })}`)).json.Contacts.length, 2);
  assert.equal((await get(`/Contacts${q({ where: 'Name.StartsWith("O\'Brien")' })}`)).json.Contacts.length, 1);
  assert.equal((await get("/Contacts/CUST-003")).json.Contacts[0].ContactID, con(3));
  const market = (await get(`/Contacts/${con(7)}`)).json.Contacts[0];
  assert.deepEqual(market.Balances.AccountsReceivable, { Outstanding: 1998.7, Overdue: 1998.7 });
  assert.equal(all.Contacts.find((c) => c.ContactID === con(7)).Balances, undefined, "list rows omit Balances");
  await notFound("GET", `/Contacts/${MISSING}`);
  await validation("GET", `/Contacts${q({ page: 0 })}`, undefined, "page must be a positive integer");
  await xeroError("GET", `/Contacts${q({ where: "Name==" })}`, 16);

  const created = (await put("/Contacts", { Contacts: [{ Name: "Pukeko Print Co", EmailAddress: "hello@pukeko.example.com" }] })).json.Contacts[0];
  // An idempotent replay renders in Xero field order (the framework stores receipts with sorted keys), Id aside.
  const replayBody = { Contacts: [{ Name: "Ruru Robotics Ltd", EmailAddress: "hi@ruru.example.com", Phones: [{ PhoneType: "DEFAULT", PhoneNumber: "555 0100", PhoneAreaCode: "04" }], Addresses: [{ AddressType: "POBOX", AddressLine1: "PO Box 12", City: "Wellington", PostalCode: "6011", Country: "NZ" }] }] };
  const replayed1 = await replayed("PUT", "/Contacts", replayBody, "contacts-replay-order");
  assert.deepEqual(Object.keys(replayed1), ["Id", "Status", "ProviderName", "DateTimeUTC", "Contacts"]);
  assert.deepEqual(Object.keys(replayed1.Contacts[0].Phones[0]), ["PhoneType", "PhoneNumber", "PhoneAreaCode"]);
  assert.deepEqual(Object.keys(replayed1.Contacts[0].Addresses[0]), ["AddressType", "AddressLine1", "City", "PostalCode", "Country"]);
  assert.deepEqual(Object.keys((await get("/Contacts")).json), ["Id", "Status", "ProviderName", "DateTimeUTC", "Contacts"]);
  assert.deepEqual(Object.keys((await get(`/Contacts${q({ page: 1 })}`)).json), ["Id", "Status", "ProviderName", "DateTimeUTC", "pagination", "Contacts"], "pagination precedes the collection, as on Xero");
  assert.deepEqual(Object.keys((await get(`/Contacts/${con(1)}`)).json.Contacts[0].Addresses[0]).slice(0, 2), ["AddressType", "AddressLine1"], "stored rows render in Xero field order, not the store's sorted order");
  await validation("PUT", "/Contacts", { Name: "PUKEKO print co" }, "Please enter a unique Name.");
  const phoned = (await post(`/Contacts/${con(12)}`, { Phones: [{ PhoneType: "MOBILE", PhoneNumber: "021 555 0199" }] })).json.Contacts[0];
  assert.equal(phoned.EmailAddress, "stay@kereru.example.com", "fields absent from the body are kept");
  assert.equal((await post("/Contacts", { ContactID: created.ContactID, ContactStatus: "ARCHIVED" })).json.Contacts[0].ContactStatus, "ARCHIVED");
  assert.ok(!(await get("/Contacts")).json.Contacts.some((c) => c.ContactID === created.ContactID), "archived contacts are hidden by default");
  const batch = (await post(`/Contacts${q({ summarizeErrors: "false" })}`, { Contacts: [{ Name: "Tui Tiles" }, { Name: "Harbourside Café" }] })).json.Contacts;
  assert.deepEqual(batch.map((c) => c.StatusAttributeString), ["OK", "ERROR"]);
  await validation("PUT", "/Contacts", { ContactID: con(1), Name: "Another" }, "already exists");
  await notFound("POST", `/Contacts/${MISSING}`, { Name: "Nobody" });
  let deep = { Name: "Deep" };
  for (let i = 0; i < 600; i += 1) deep = { Nested: deep };
  await xeroError("PUT", "/Contacts", 17, { body: deep });
  await xeroError("PUT", "/Contacts", 17, { raw: "[1,2]" });

  const tools = await rpc("tools/list", {});
  for (const name of ["list-contacts", "create-contact", "update-contact", "list-invoices", "create-invoice", "update-invoice", "create-payment", "list-payments"]) {
    assert.ok(tools.tools.some((tool) => tool.name === name), `MCP alias ${name} is listed`);
  }
  const weka = await mcp("create-contact", { name: "Weka Web Design", email: "kia.ora@weka.example.com", phone: "03 555 0177" });
  assert.equal(weka.Phones[0].PhoneNumber, "03 555 0177");
  await mcpError("create-contact", { name: "Weka Web Design" }, "VALIDATION_EXCEPTION");
  const moved = await mcp("update-contact", { contactId: con(4), name: "Te Awa Early Learning Centre", address: { addressLine1: "90 Tahunanui Drive", city: "Nelson" } });
  assert.equal(moved.Addresses.find((a) => a.AddressType === "STREET").AddressLine1, "90 Tahunanui Drive");
  await op("contacts.update", { contactId: MISSING, name: "Nobody" }, { code: "NOT_FOUND" });
  await op("contacts.update", { contactId: con(5), name: "x", email: "not an email" }, { code: "VALIDATION_EXCEPTION" });
  assert.equal((await mcp("list-contacts", { searchTerm: "weka" })).Contacts.length, 1);
}
