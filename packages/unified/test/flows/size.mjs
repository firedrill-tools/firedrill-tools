// Drill unified-size-bounds (admin, baseline): schema bounds, prototype keys, long unknown keys and the 900 KB page
// budget measured in UTF-8 bytes for contacts (raw), companies, deals and CJK messages.
import { C, CH, K, apiError, assert, get, post } from "../lib.mjs";

const M = `/crm/${C.main}`;
const H = `/messaging/${C.chat}`;
const CJK = "山田物産との商談が進んでいます。新しい四半期も頑張りましょう。";

const pagesOf = async (path, limit) => {
  const sizes = [];
  for (let offset = 0; ; offset += limit) {
    const result = await get(`${path}${path.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`);
    assert.ok(Buffer.byteLength(result.text) <= 900000, `${path} page exceeds the byte budget`);
    sizes.push(result.json.length);
    if (result.json.length < limit) return sizes;
  }
};

export async function sizeBounds() {
  // Schema bounds and hostile keys on contact bodies (six declared errors, nothing written).
  await apiError("POST", `${M}/contact`, 400, "at most 1000 characters", { body: { name: "n".repeat(1001) } });
  await apiError("POST", `${M}/contact`, 400, "at most 32 entries", { body: { name: "Many", emails: Array.from({ length: 33 }, (_, i) => ({ email: `m${i}@example.org` })) } });
  await apiError("POST", `${M}/contact`, 400, "at most 100 entries", { body: { name: "Many", company_ids: Array.from({ length: 101 }, (_, i) => `68c8000000000000000${(0x90000 + i).toString(16).padStart(5, "0")}`) } });
  let deep = { leaf: 1 };
  for (let i = 0; i < 9; i += 1) deep = { nested: deep };
  await apiError("POST", `${M}/contact`, 400, "deeper than 8 levels", { body: { name: "Deep", raw: deep } });
  const guarded = await apiError("POST", `${M}/contact`, 400, "Invalid key", { rawBody: '{"name":"Poison","raw":{"constructor":{"prototype":{"polluted":true}}}}' });
  assert.ok(!guarded.text.includes("Cannot read"), "no runtime error text leaks");
  const twoKeys = await apiError("POST", `${M}/contact`, 400, "Invalid key", { rawBody: '{"name":"Poison","raw":{"a":{"prototype":1}}}' });
  assert.ok(!twoKeys.text.includes("Cannot read"));
  // A JSON `__proto__` member is not probed here: depending on the framework build it is either dropped by the body
  // parser (200, raw {}) or refused by the codec's key guard (400), which would make the flow's counts build-dependent.
  // The route fuzzer (tooling/route-fuzz.mjs) covers realm poisoning; the guard itself is proven above with `constructor`/`prototype`.
  const longKey = "k".repeat(5000);
  const unknown = await apiError("POST", `${M}/contact`, 400, "Unknown field", { body: { name: "Long", [longKey]: 1 } });
  assert.ok(unknown.json.message.length < 400, "caller keys are clipped in error messages");
  const elena = (await get(`${M}/contact/${K.elena}`)).json;
  assert.ok(!Object.hasOwn(elena, "polluted") && ({}).polluted === undefined, "the shared realm was not poisoned");
  assert.equal((await get(`${M}/contact`)).json.length, 8);

  // 60 contacts with a 16 KB raw payload each: raw is hidden by default and too large as one page when requested.
  const blob = "r".repeat(16000);
  for (let i = 0; i < 60; i += 1) assert.equal((await post(`${M}/contact`, { name: `Bulk contact ${i + 1}`, raw: { blob } })).json.name, `Bulk contact ${i + 1}`);
  assert.equal((await get(`${M}/contact?limit=100`)).json.length, 68, "the default projection without raw fits one page");
  await apiError("GET", `${M}/contact?fields=id,raw&limit=100`, 413, "Response exceeds 1 MB");
  assert.deepEqual(await pagesOf(`${M}/contact?fields=id,raw`, 50), [50, 18]);

  // 50 companies and 50 deals with 20,000-character descriptions.
  const text = "d".repeat(20000);
  for (let i = 0; i < 50; i += 1) assert.equal((await post(`${M}/company`, { name: `Bulk company ${i + 1}`, description: text })).json.description.length, 20000);
  await apiError("GET", `${M}/company`, 413, "Response exceeds 1 MB");
  assert.deepEqual(await pagesOf(`${M}/company`, 30), [30, 25]);
  for (let i = 0; i < 50; i += 1) assert.equal((await post(`${M}/deal`, { name: `Bulk deal ${i + 1}`, description: text })).json.name, `Bulk deal ${i + 1}`);
  await apiError("GET", `${M}/deal?limit=100`, 413, "Response exceeds 1 MB");
  assert.deepEqual(await pagesOf(`${M}/deal`, 30), [30, 26]);

  // 16 messages of 20,000 CJK characters (60 KB each on the wire): a character-counting budget would let the page through.
  const cjk = CJK.repeat(Math.ceil(20000 / CJK.length)).slice(0, 20000);
  assert.equal(cjk.length, 20000);
  for (let i = 0; i < 16; i += 1) assert.equal((await post(`${H}/message`, { message: cjk, channels: [{ id: CH.exec }] })).json.message.length, 20000);
  await apiError("GET", `${H}/message?channel_id=${CH.exec}&limit=100`, 413, "Response exceeds 1 MB");
  assert.deepEqual(await pagesOf(`${H}/message?channel_id=${CH.exec}`, 10), [10, 8]);

  // Long and repeated query parameters.
  await apiError("GET", `${H}/message?query=${"*".repeat(10000)}`, 400, "query must be a string of at most 2000 characters");
  assert.equal((await get(`${H}/message?channel_id=${CH.sales}&fields=${"f".repeat(5000)},id`)).json.length, 5, "over-long field names are ignored");
  await apiError("GET", `${H}/message?${Array.from({ length: 17 }, (_, i) => `limit=${i + 1}`).join("&")}`, 400, "repeated more than 16 times");
  // A wildcard-heavy query is a literal substring search (linear time); the crash fuzzer separately enforces the 15 s hang bound.
  assert.equal((await get(`${H}/message?channel_id=${CH.sales}&query=${encodeURIComponent("*a".repeat(900))}`)).json.length, 0);
  assert.equal((await get(`${H}/message?channel_id=${CH.sales}&query=${encodeURIComponent("*")}`)).json.length, 0, "* is a literal character, not a wildcard");
}
