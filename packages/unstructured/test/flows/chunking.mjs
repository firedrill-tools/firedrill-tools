// Chunking flow: basic, by_title, by_page, overlap, orig_elements (real gzip), TableChunk.
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { fixtures, partition } from "../lib.mjs";

const decodeOrig = (element) => {
  const bytes = Buffer.from(element.metadata.orig_elements, "base64");
  assert.equal(bytes[0], 0x1f);
  assert.equal(bytes[1], 0x8b);
  return JSON.parse(gunzipSync(bytes).toString("utf8"));
};

export async function chunkingFlow() {
  const fx = fixtures();
  const file = (name) => ({ filename: name, content: fx.get(name).content });

  // 1. basic, max 500: every chunk fits, the long paragraph is split into continuation chunks, orig_elements decode.
  const basic = (await partition([file("glossary.md")], { chunking_strategy: "basic", max_characters: "500" })).json;
  assert.ok(basic.length >= 6, `chunks ${basic.length}`);
  assert.ok(basic.every((c) => c.type === "CompositeElement" && c.text.length <= 500));
  assert.ok(basic.some((c) => c.metadata.is_continuation === true), "continuation chunks");
  for (const chunk of basic) {
    const originals = decodeOrig(chunk);
    assert.ok(Array.isArray(originals) && originals.length > 0);
    assert.ok(originals.every((e) => typeof e.type === "string" && typeof e.text === "string" && e.metadata.filename === "glossary.md"));
    if (chunk.metadata.is_continuation !== true && originals.length > 1) assert.equal(chunk.text, originals.map((e) => e.text).join("\n\n"));
  }
  assert.match(basic[1].text, /^A glossary entry explains/);

  // 2. overlap=50: each continuation chunk starts with the last 50 characters of the previous chunk.
  const overlapped = (await partition([file("glossary.md")], { chunking_strategy: "basic", max_characters: "500", overlap: "50" })).json;
  let continuations = 0;
  for (let i = 1; i < overlapped.length; i += 1) {
    if (overlapped[i].metadata.is_continuation !== true) continue;
    continuations += 1;
    assert.ok(overlapped[i].text.startsWith(overlapped[i - 1].text.slice(-50)), `overlap prefix at ${i}`);
    assert.ok(overlapped[i].text.length <= 500);
  }
  assert.ok(continuations >= 4, `continuations ${continuations}`);

  // 3. overlap_all: every chunk after the first carries the prefix.
  const all = (await partition([file("glossary.md")], { chunking_strategy: "basic", max_characters: "500", overlap: "40", overlap_all: "true" })).json;
  for (let i = 1; i < all.length; i += 1) assert.ok(all[i].text.startsWith(all[i - 1].text.slice(-40)), `overlap_all prefix at ${i}`);

  // 4. by_title with combine_under_n_chars: chunks start at titles; small sections are merged.
  const byTitle = (await partition([file("handbook.md")], { chunking_strategy: "by_title", max_characters: "800", combine_under_n_chars: "200", include_orig_elements: "false" })).json;
  assert.ok(byTitle[0].text.startsWith("Northgate Research Employee Handbook\n\nWelcome to Northgate Research."));
  assert.ok(byTitle.some((c) => c.text.startsWith("Working Hours\n\n")));
  assert.ok(byTitle.some((c) => c.type === "Table"), "table kept whole");
  assert.ok(byTitle.every((c) => c.metadata.orig_elements === undefined), "orig_elements omitted");
  assert.ok(byTitle.every((c) => c.text.length <= 800));

  // 5. by_page: one chunk per page of the refund policy.
  const byPage = (await partition([file("refund-policy.txt")], { chunking_strategy: "by_page", max_characters: "1500", new_after_n_chars: "1500" })).json;
  assert.equal(byPage.length, 2);
  assert.deepEqual(byPage.map((c) => c.metadata.page_number), [1, 2]);
  assert.ok(byPage[1].text.startsWith("Exceptions"));
  assert.ok(byPage.every((c) => c.type === "CompositeElement"));

  // 6. include_orig_elements=false on basic; 7. new_after_n_chars larger than max_characters is lowered.
  const noOrig = (await partition([file("2026-09-08-site-visit.txt")], { chunking_strategy: "basic", include_orig_elements: "false" })).json;
  assert.ok(noOrig.every((c) => c.metadata.orig_elements === undefined));
  const lowered = (await partition([file("2026-09-08-site-visit.txt")], { chunking_strategy: "basic", max_characters: "300", new_after_n_chars: "5000" })).json;
  assert.ok(lowered.length >= 3 && lowered.every((c) => c.text.length <= 300));

  // 8. A table longer than max_characters becomes TableChunk pieces split by rows.
  const chunks = (await partition([file("vendors.csv")], { chunking_strategy: "basic", max_characters: "300" })).json;
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.type === "TableChunk" && c.text.length <= 300 && c.metadata.text_as_html.startsWith("<table><tr>")));
  assert.equal(chunks[0].metadata.is_continuation, undefined);
  assert.ok(chunks.slice(1).every((c) => c.metadata.is_continuation === true));
  assert.equal(chunks.map((c) => c.text.split("\n").length).reduce((a, b) => a + b, 0), 13);

  // 9. The largest chunk size (100,000, the element text bound) over two 90,000-character paragraphs: one chunk each,
  // never a schema violation; 10. many tiny blocks accumulate into few chunks in linear time.
  const wide = { filename: "wide.txt", content: `${"b".repeat(90000)}\n\n${"c".repeat(90000)}` };
  const widest = (await partition([wide], { chunking_strategy: "basic", max_characters: "100000", new_after_n_chars: "100000", include_orig_elements: "false" })).json;
  assert.equal(widest.length, 2);
  assert.ok(widest.every((c) => c.type === "CompositeElement" && c.text.length === 90000));
  const many = { filename: "many.txt", content: "a\n\n".repeat(20000) };
  const started = Date.now();
  const few = (await partition([many], { chunking_strategy: "basic", max_characters: "100000", new_after_n_chars: "100000", include_orig_elements: "false" })).json;
  assert.ok(Date.now() - started < 5000, `chunking 20,000 blocks took ${Date.now() - started}ms`);
  assert.equal(few.length, 1);
  assert.equal(few[0].text.length, 20000 * 3 - 2);

  // 11. Continuation pieces of one chunk group share the group's metadata: every piece of a 40-link paragraph split at
  // max_characters=100 carries all 40 merged link_urls/link_texts (built once per group, never rebuilt per piece).
  const linked = { filename: "linked.html", content: `<p>${'<a href="https://example.test/u">link text</a> '.repeat(40)}</p>` };
  const shared = (await partition([linked], { chunking_strategy: "basic", max_characters: "100", include_orig_elements: "false" })).json;
  assert.equal(shared.length, 4);
  assert.ok(shared.every((c) => c.metadata.link_urls.length === 40 && c.metadata.link_texts.length === 40 && c.metadata.link_urls[39] === "https://example.test/u"));
  assert.equal(shared[0].metadata.is_continuation, undefined);
  assert.ok(shared.slice(1).every((c) => c.metadata.is_continuation === true));
}
