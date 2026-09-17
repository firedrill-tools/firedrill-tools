// Deliberately hostile input on every route family: nothing may answer 5xx, hang or leak a runtime message.
import assert from "node:assert/strict";
import { CONTACTS, EVENTS, GROUPS, PEOPLE, SCRIPT, SCRIPTS, api, call, expectGoogleError } from "../lib.mjs";

const LEAKS = [
  "Cannot read properties",
  "is not a function",
  "Unexpected token",
  "undefined is not",
  "Maximum call stack",
  "at Object.",
];

function noLeak(result, where) {
  const text = JSON.stringify(result.body ?? {});
  for (const marker of LEAKS) {
    assert.ok(!text.includes(marker), `${where} leaked a runtime message: ${text.slice(0, 200)}`);
  }
  assert.ok(result.status < 500, `${where} answered ${result.status}`);
}

function deepBody(depth) {
  let node = { leaf: true };
  for (let i = 0; i < depth; i += 1) node = { child: node };
  return node;
}

async function fuzzSurface() {
  const long = "x".repeat(5000);
  const cases = [
    ["GET", `${PEOPLE}/people/me`, { query: { personFields: long } }, 400],
    ["GET", `${PEOPLE}/people/${long}`, { query: { personFields: "names" } }, 400],
    ["GET", `${PEOPLE}/people/${"c".repeat(600)}`, { query: { personFields: "names" } }, 400],
    ["GET", `${PEOPLE}/people/me`, { rawQuery: "personFields=names%FF" }, 400],
    ["GET", `${PEOPLE}/people/__proto__`, { query: { personFields: "names" } }, 400],
    ["GET", `${PEOPLE}/contactGroups/constructor`, {}, 400],
    ["GET", `${PEOPLE}/contactGroups/${GROUPS.vendors}`, { query: { maxMembers: "not-a-number" } }, 400],
    ["GET", `${PEOPLE}/people/me/connections`, { query: { personFields: "names", pageSize: "1e9" } }, 400],
    ["GET", `${PEOPLE}/people/me/connections`, { query: { personFields: "names", pageToken: "!!!!" } }, 400],
    ["GET", `${PEOPLE}/otherContacts`, { query: { readMask: "names", pageToken: "AAAA".repeat(600) } }, 400],
    ["GET", `${EVENTS}/subscriptions`, { query: { filter: `event_types:"${"*a".repeat(400)}"` } }, 400],
    ["GET", `${EVENTS}/subscriptions`, { rawQuery: "filter=event_types%3A%FF" }, 400],
    // `%ZZ` is not a percent-escape at all: the framework leaves it literal, so this is an honest no-match
    // filter rather than corruption, and it must not be rejected.
    ["GET", `${EVENTS}/subscriptions`, { rawQuery: "filter=event_types%3A%ZZ" }, 200],
    ["GET", `${EVENTS}/subscriptions/${"9".repeat(600)}`, {}, 400],
    ["GET", `${SCRIPT}/projects/${"1".repeat(600)}`, {}, 400],
    ["GET", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/content`, { query: { versionNumber: "-2147483648" } }, 400],
    ["GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.startTime": long } }, 400],
    ["GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.statuses": ["__proto__"] } }, 400],
  ];
  for (const [method, path, options, expected] of cases) {
    const result = await api(method, path, options);
    noLeak(result, `${method} ${path.slice(0, 60)}`);
    assert.equal(result.status, expected, `${method} ${path.slice(0, 60)} expected ${expected}, got ${result.status}`);
    if (expected >= 400) assert.ok(result.body?.error?.status !== undefined, "every refusal carries the provider envelope");
  }

  const bodies = [
    ["POST", `${PEOPLE}/people:createContact`, { constructor: { prototype: { polluted: true } } }],
    ["POST", `${PEOPLE}/people:createContact`, deepBody(1000)],
    ["POST", `${PEOPLE}/people:createContact`, { names: [{ givenName: long, familyName: long }] }],
    ["POST", `${PEOPLE}/people:createContact`, { [long]: "value", names: [{ givenName: "P" }] }],
    ["PUT", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/content`, deepBody(2000)],
    ["PUT", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/content`, { files: Array.from({ length: 200 }, (_, index) => ({ name: `F${index}.gs`, type: "SERVER_JS", source: "" })) }],
    ["POST", `${SCRIPT}/scripts/${SCRIPTS.vendorSync}:run`, { function: long, parameters: [long] }],
    ["POST", `${EVENTS}/subscriptions`, { targetResource: long, eventTypes: [long] }],
    ["POST", `${PEOPLE}/contactGroups/${GROUPS.vendors}/members:modify`, { resourceNamesToAdd: Array.from({ length: 1500 }, () => `people/${CONTACTS.priya}`) }],
  ];
  for (const [method, path, body] of bodies) {
    const result = await api(method, path, { body });
    noLeak(result, `${method} ${path.slice(0, 60)} body`);
    assert.ok(result.status === 400 || result.status === 404, `${method} ${path.slice(0, 60)} expected a client error, got ${result.status}`);
  }

  // A body carrying a real own `__proto__` member (only JSON.parse can build one) must not poison the realm.
  // The HTTP boundary rejects dangerous object keys before behavior runs, so no cleanup mutation is necessary.
  const polluting = await api("POST", `${PEOPLE}/people:createContact`, {
    body: JSON.parse('{"__proto__":{"polluted":true},"names":[{"givenName":"Proto","familyName":"Probe"}]}'),
  });
  assert.equal(polluting.status, 400);
  noLeak(polluting, "POST people:createContact prototype key");

  // The shared realm is intact: a normal read still works after every hostile request.
  assert.equal(({}).polluted, undefined, "Object.prototype must not be polluted in this process");
  const profile = await api("GET", `${PEOPLE}/people/me`, { query: { personFields: "names" } });
  assert.equal(profile.status, 200);
  const groups = await api("GET", `${PEOPLE}/contactGroups`);
  assert.equal(groups.status, 200);

  // Caller keys that name inherited members must miss, not resolve to a function.
  const byProtoGroup = await call("contact-groups.get", { resourceName: "contactGroups/__proto__" });
  assert.equal(byProtoGroup.outcome.status, "tool_error");
  assert.equal(byProtoGroup.outcome.error.code, "tool.INVALID_ARGUMENT");

  const searchWildcards = await call("people.search-contacts", { query: "*a*a*a*a*a*a*a*a*q", readMask: "names" });
  assert.equal(searchWildcards.outcome.status, "ok", "a wildcard-heavy query is matched literally, not compiled");
  assert.deepEqual(searchWildcards.outcome.value.results, []);

  // A path that is not a declared route at all never reaches a codec, so the framework answers with its own
  // envelope rather than Google's. This is a documented deviation (README "Limitations").
  const unknownPath = await api("GET", `${PEOPLE}/people/me/connections/extra`);
  assert.equal(unknownPath.status, 404);
  assert.equal(unknownPath.body.code, "framework.HTTP_ROUTE_NOT_FOUND");
  const wrongMethod = await api("GET", `${PEOPLE}/directoryPeople`);
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.code, "framework.HTTP_METHOD_NOT_ALLOWED");

  // A URL that *is* a declared route but not a real Google custom method answers Google's own 404.
  expectGoogleError(await api("POST", `${PEOPLE}/people:listDirectoryPeople`, { body: {} }), 404, "NOT_FOUND", "an unimplemented People custom method");
}

export const FLOWS = { "fuzz-surface": fuzzSurface };
