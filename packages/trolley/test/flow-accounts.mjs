// Recipient accounts flow: list, get, create per payout method, primary switching, immutable fields, disable.
import { A, R, api, assert, fails, flow } from "./harness.mjs";

flow("accounts", async () => {
  await fails("POST", `/v1/recipients/${R(999)}/accounts`, 404, "not_found", { body: { type: "paypal", emailAddress: "nobody@example.com" } });
  await fails("PATCH", `/v1/recipients/${R(3)}/accounts/${A(99)}`, 404, "not_found", { body: { primary: true } });
  const listed = await api("GET", `/v1/recipients/${R(3)}/accounts`);
  assert.deepEqual(listed.accounts.map((account) => account.id), [A(3), A(4)], "active accounts, primary first");
  assert.equal(listed.accounts[0].primary, true);
  assert.equal(listed.accounts[0].accountNum, "*****5521");
  const disabled = (await api("GET", `/v1/recipients/${R(3)}/accounts/${A(5)}`)).account;
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.disabledAt, "2026-07-02T15:30:00.000Z");
  await fails("GET", `/v1/recipients/${R(3)}/accounts/${A(1)}`, 404, "not_found");
  await fails("GET", `/v1/recipients/${R(999)}/accounts`, 404, "not_found");

  const bank = { type: "bank-transfer", currency: "USD", country: "US", accountHolderName: "Maya Castellanos", accountNum: "000123456789" };
  await fails("POST", `/v1/recipients/${R(1)}/accounts`, 400, "empty_field", { field: "branchId", body: bank });
  const created = (await api("POST", `/v1/recipients/${R(1)}/accounts`, { body: { ...bank, branchId: "000222333" } })).account;
  assert.equal(created.accountNum, "*****6789");
  assert.equal(created.primary, false, "an existing primary stays primary");
  assert.equal(created.recipientAccountId, created.id);
  assert.equal(created.routeType, "ach");

  const promoted = (await api("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, { body: { primary: true } })).account;
  assert.equal(promoted.primary, true);
  const relisted = await api("GET", `/v1/recipients/${R(1)}/accounts`);
  assert.deepEqual(relisted.accounts.map((account) => [account.id, account.primary]), [[created.id, true], [A(1), false]]);
  await fails("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, 400, "invalid_field", { field: "accountNum", body: { accountNum: "999999999" } });
  await fails("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, 400, "invalid_field", { field: "primary", body: { primary: false } });
  await fails("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, 400, "invalid_field", { field: "emailAddress", body: { emailAddress: "x@example.com" } });
  await fails("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, 400, "empty_field", { field: "body", body: {} });
  const renamed = (await api("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, { body: { accountHolderName: "Maya R. Castellanos" } })).account;
  assert.equal(renamed.accountHolderName, "Maya R. Castellanos");

  await fails("POST", `/v1/recipients/${R(1)}/accounts`, 400, "invalid_field", { field: "type", body: { type: "debit-card" } });
  const mailing = { name: "Maya Castellanos", street1: "1 Rue Principale", city: "Québec", region: "QC", postal: "G1R 4P5", country: "CA" };
  await fails("POST", `/v1/recipients/${R(1)}/accounts`, 400, "invalid_field", { field: "mailing.country", body: { type: "check", mailing } });
  await fails("POST", `/v1/recipients/${R(11)}/accounts`, 400, "invalid_status", { body: { type: "paypal", emailAddress: "old.jordan@example.com" } });
  await fails("POST", `/v1/recipients/${R(5)}/accounts`, 400, "invalid_field", { field: "iban", body: { type: "bank-transfer", currency: "EUR", country: "DE", accountHolderName: "L W", iban: "FR7630006000011234567890189" } });
  const iban = (await api("POST", `/v1/recipients/${R(5)}/accounts`, { body: { type: "bank-transfer", currency: "EUR", country: "DE", accountHolderName: "Lukasz Wisniewski", iban: "DE89 3704 0044 0532 0130 00" } })).account;
  assert.equal(iban.iban, "*****3000");
  assert.equal(iban.accountNum, null);
  assert.equal(iban.routeType, "sepa");

  // Harper Lin has an address but no payout method: adding Venmo makes the recipient active.
  const venmo = (await api("POST", `/v1/recipients/${R(10)}/accounts`, { body: { type: "venmo", phoneNumber: "(206) 555-0110" } })).account;
  assert.equal(venmo.primary, true);
  assert.equal(venmo.phoneNumber, "2065550110");
  assert.equal((await api("GET", `/v1/recipients/${R(10)}`)).recipient.status, "active");

  // Removing Maya's primary leaves no primary: the recipient becomes incomplete until another account is promoted.
  assert.deepEqual(await api("DELETE", `/v1/recipients/${R(1)}/accounts/${created.id}`), { ok: true });
  assert.equal((await api("GET", `/v1/recipients/${R(1)}`)).recipient.status, "incomplete");
  await fails("DELETE", `/v1/recipients/${R(1)}/accounts/${created.id}`, 400, "invalid_status");
  await fails("PATCH", `/v1/recipients/${R(1)}/accounts/${created.id}`, 400, "invalid_status", { body: { accountHolderName: "Nobody" } });
  await fails("DELETE", `/v1/recipients/${R(1)}/accounts/${A(1)}`, 400, "invalid_status");
  await fails("DELETE", `/v1/recipients/${R(1)}/accounts/${A(99)}`, 404, "not_found");
  const repromoted = (await api("PATCH", `/v1/recipients/${R(1)}/accounts/${A(1)}`, { body: { primary: true } })).account;
  assert.equal(repromoted.status, "primary");
  assert.equal((await api("GET", `/v1/recipients/${R(1)}`)).recipient.status, "active");
  assert.equal((await api("GET", `/v1/recipients/${R(1)}/accounts/${created.id}`)).account.status, "disabled");
});
