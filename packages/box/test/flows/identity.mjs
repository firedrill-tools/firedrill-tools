// Identity, grants, faults and capacity flows.
import assert from "node:assert/strict";
import { F, FI, MAYA, everyOperation, get, names, post, upload, uploadVersion } from "../client.mjs";

export const FLOWS = {};

FLOWS["fresh-install"] = async () => {
  const me = await get("/2.0/users/me");
  assert.equal(me.body.id, MAYA, "an actor without identity attributes acts as the default seeded user");
  const root = await get("/2.0/folders/0/items");
  assert.equal(root.body.total_count, 7);
};

FLOWS.unauthorized = async () => {
  assert.equal(await everyOperation(() => [401, "unauthorized"]), 23);
};

FLOWS.denied = async () => {
  assert.equal(await everyOperation(() => [403, "access_denied_insufficient_permissions"]), 23);
};

FLOWS["over-cap"] = async () => {
  assert.equal(await everyOperation((op) => (op === "users.get-me" ? 200 : [400, "bad_request"])), 23);
  const failure = await get(`/2.0/folders/${F(1)}/items`, [400, "bad_request"]);
  assert.match(failure.body.message, /at most 2000 objects/);
};

FLOWS["at-cap"] = async () => {
  const listing = await get(`/2.0/folders/${F(11)}/items?limit=100`);
  assert.equal(listing.body.total_count, 8, "reads still work at the cap");
  await get(`/2.0/folders/${F(1)}/collaborations`);
  const refused = await post("/2.0/folders", { name: "One more", parent: { id: "0" } }, [400, "bad_request"]);
  assert.match(refused.body.message, /at most 2000 objects/);
  await upload({ name: "one-more.txt", parent: { id: F(7) } }, "x", [400, "bad_request"]);
  await post("/2.0/comments", { item: { type: "file", id: FI(1) }, message: "one more" }, [400, "bad_request"]);
  await get(`/2.0/folders/${F(7)}/items`).then((r) => assert.equal(r.body.total_count, 0, "nothing was written"));
};

FLOWS["rate-limited"] = async () => {
  for (const response of [
    await get("/2.0/search?query=launch", [429, "rate_limit_exceeded"]),
    await get(`/2.0/folders/${F(1)}/items`, [429, "rate_limit_exceeded"]),
    await upload({ name: "limited.txt", parent: { id: F(7) } }, "x", [429, "rate_limit_exceeded"]),
    await uploadVersion(FI(3), {}, "x", [429, "rate_limit_exceeded"]),
  ]) {
    assert.equal(response.headers.get("retry-after"), "1");
  }
  const folder = await get(`/2.0/folders/${F(7)}`);
  assert.equal(folder.body.item_collection.total_count, 0, "nothing was uploaded");
};

FLOWS["writes-unavailable"] = async () => {
  for (const response of [
    await upload({ name: "offline.txt", parent: { id: F(7) } }, "x", [503, "unavailable"]),
    await uploadVersion(FI(3), {}, "x", [503, "unavailable"]),
    await post(`/2.0/files/${FI(3)}/copy`, { parent: { id: F(7) } }, [503, "unavailable"]),
    await post("/2.0/folders", { name: "Offline", parent: { id: "0" } }, [503, "unavailable"]),
    await post(`/2.0/folders/${F(4)}/copy`, { parent: { id: F(7) } }, [503, "unavailable"]),
  ]) {
    assert.equal(response.headers.get("retry-after"), "1");
  }
  const brand = await get(`/2.0/files/${FI(3)}?fields=version_number`);
  assert.equal(brand.body.version_number, "1");
  assert.equal((await get("/2.0/folders/0/items")).body.total_count, 7);
};

FLOWS["upload-committed-lost"] = async () => {
  const attributes = { name: "quarterly-summary.md", parent: { id: F(7) } };
  const lost = await upload(attributes, "# Summary\nCommitted before the error.\n", [500, "internal_server_error"]);
  assert.equal(lost.body.status, 500);
  const retry = await upload(attributes, "# Summary\nCommitted before the error.\n", [409, "item_name_in_use"]);
  const [conflict] = retry.body.context_info.conflicts;
  assert.equal(conflict.name, "quarterly-summary.md");
  const file = await get(`/2.0/files/${conflict.id}`);
  assert.equal(file.body.parent.id, F(7));
  assert.deepEqual(names((await get(`/2.0/folders/${F(7)}/items`)).body.entries), ["quarterly-summary.md"]);
};
