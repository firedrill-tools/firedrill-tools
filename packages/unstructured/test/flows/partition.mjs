// Partition flow: element rules per document type, ids, languages, pages, multi-file requests, CSV output.
import assert from "node:assert/strict";
import { HEX32, ID, UUID, fixtures, op, partition, types } from "../lib.mjs";

export async function partitionFlow() {
  const fx = fixtures();
  const file = (name) => ({ filename: name, content: fx.get(name).content });

  // 1. Markdown: heading depths, parent chain, lists, table, code, emphasis, links, ids, metadata.
  const md = (await partition([file("handbook.md")])).json;
  assert.ok(Array.isArray(md) && md.length > 15, `handbook elements ${md.length}`);
  const titles = md.filter((e) => e.type === "Title");
  assert.deepEqual(titles.map((e) => e.metadata.category_depth), [0, 1, 2, 1, 2, 1, 1]);
  assert.equal(titles[0].text, "Northgate Research Employee Handbook");
  assert.equal(titles[1].metadata.parent_id, titles[0].element_id, "h2 parent is h1");
  assert.equal(titles[2].metadata.parent_id, titles[1].element_id, "h3 parent is h2");
  const remote = md[md.indexOf(titles[2]) + 1];
  assert.equal(remote.type, "NarrativeText");
  assert.equal(remote.metadata.parent_id, titles[2].element_id);
  assert.deepEqual(remote.metadata.link_texts, ["people team"]);
  assert.deepEqual(remote.metadata.link_urls, ["https://people.northgate-research.test/requests"]);
  assert.deepEqual(remote.metadata.emphasized_text_contents, ["three"]);
  assert.deepEqual(remote.metadata.emphasized_text_tags, ["i"]);
  assert.equal(md.filter((e) => e.type === "ListItem").length, 8);
  assert.deepEqual(md.filter((e) => e.type === "ListItem").slice(0, 5).map((e) => e.metadata.category_depth), [0, 0, 1, 1, 0]);
  const table = md.find((e) => e.type === "Table");
  assert.ok(table.metadata.text_as_html.startsWith("<table><tr><td>Item</td><td>Standard</td>"), table.metadata.text_as_html);
  assert.equal(table.text.split("\n").length, 4);
  assert.equal(md.find((e) => e.type === "CodeSnippet").text, "ngctl ticket create --tag equipment --cost-centre 4410");
  for (const element of md) {
    assert.match(element.element_id, HEX32);
    assert.deepEqual(element.metadata.languages, ["eng"]);
    assert.equal(element.metadata.filename, "handbook.md");
    assert.equal(element.metadata.filetype, "text/markdown");
    assert.equal(element.metadata.page_number, 1);
  }
  assert.equal(new Set(md.map((e) => e.element_id)).size, md.length, "ids are unique");

  // 2. unique_element_ids -> UUIDs; 3. repeated languages[] parts.
  const uuids = (await partition([file("handbook.md")], { unique_element_ids: "true" })).json;
  for (const element of uuids) assert.match(element.element_id, UUID);
  const deu = (await partition([file("2026-09-08-site-visit.txt")], { languages: ["deu", "fra"] })).json;
  assert.equal(deu.length, 4);
  for (const element of deu) assert.deepEqual(element.metadata.languages, ["deu", "fra"]);

  // 4. Plain text with a form feed: page breaks, Address, EmailAddress, ListItem; 5. starting_page_number.
  const refund = (await partition([file("refund-policy.txt")], { include_page_breaks: "true" })).json;
  const breakAt = refund.findIndex((e) => e.type === "PageBreak");
  assert.ok(breakAt > 0, "PageBreak present");
  assert.ok(refund.slice(0, breakAt).every((e) => e.metadata.page_number === 1));
  assert.ok(refund.slice(breakAt + 1).every((e) => e.metadata.page_number === 2) && refund.length > breakAt + 2);
  assert.ok(types(refund).includes("Address") && types(refund).includes("EmailAddress"));
  assert.equal(refund.find((e) => e.type === "EmailAddress").text, "billing@northgate-research.test");
  assert.equal(refund.filter((e) => e.type === "ListItem").length, 3);
  assert.equal(refund[0].type, "Title");
  const paged = (await partition([file("refund-policy.txt")], { starting_page_number: "7" })).json;
  assert.equal(paged[0].metadata.page_number, 7);
  assert.equal(paged[paged.length - 1].metadata.page_number, 8);
  assert.ok(!types(paged).includes("PageBreak"));

  // 6. CSV: one Table with header + 12 rows, quoted field with a comma and a newline parsed.
  const csv = (await partition([file("vendors.csv")])).json;
  assert.equal(csv.length, 1);
  assert.equal(csv[0].type, "Table");
  assert.equal(csv[0].text.split("\n").length, 13);
  assert.equal((csv[0].metadata.text_as_html.match(/<tr>/g) ?? []).length, 13);
  assert.ok(csv[0].metadata.text_as_html.includes("<td>Preferred, quarterly review</td>"));

  // 7. HTML: script dropped, Header/Footer, headings, list, table, code, links, emphasis.
  const html = (await partition([file("release-notes.html")])).json;
  assert.ok(html.every((e) => !e.text.includes("never shown") && !e.text.includes("<script")));
  assert.equal(html[0].type, "Header");
  assert.equal(html[html.length - 1].type, "Footer");
  assert.equal(html[html.length - 1].text, "© 2026 Northgate Research. Confidential.");
  assert.deepEqual(html.filter((e) => e.type === "Title").map((e) => e.metadata.category_depth), [0, 1, 1, 1]);
  assert.equal(html.filter((e) => e.type === "ListItem").length, 3);
  const layers = html.find((e) => Array.isArray(e.metadata.link_urls) && e.metadata.link_urls.includes("https://fieldkit.northgate-research.test/docs/layers"));
  assert.ok(layers && layers.metadata.link_texts.includes("layer catalogue"));
  assert.ok(html.find((e) => e.type === "NarrativeText").metadata.emphasized_text_contents.includes("38 percent"));
  assert.equal(html.find((e) => e.type === "Table").text.split("\n").length, 4);
  assert.equal(html.find((e) => e.type === "CodeSnippet").text, "ngctl fieldkit migrate --to 4.2\nngctl fieldkit verify");

  // 8. RFC 822: subject as Title, addresses in metadata, folded header, list in body.
  const eml = (await partition([file("inbound.eml")])).json;
  assert.equal(eml[0].type, "Title");
  assert.equal(eml[0].text, "Site visit follow-up: Harbour Street");
  for (const element of eml) {
    assert.deepEqual(element.metadata.sent_from, ["Priya Raman <priya.raman@northgate-research.test>"]);
    assert.equal(element.metadata.sent_to.length, 2);
    assert.deepEqual(element.metadata.cc_recipient, ["archive@northgate-research.test"]);
    assert.equal(element.metadata.email_message_id, "<20260908-1715.4a1@mail.northgate-research.test>");
    assert.equal(element.metadata.filetype, "message/rfc822");
  }
  assert.equal(eml.filter((e) => e.type === "ListItem").length, 2);

  // 9. Pre-partitioned JSON passthrough; 10. empty file.
  const json = (await partition([file("elements.json")])).json;
  assert.deepEqual(types(json), ["Title", "NarrativeText", "ListItem"]);
  assert.equal(json[0].element_id, "4f3c2a1b9d8e7f6a5b4c3d2e1f0a9b8c");
  assert.match(json[2].element_id, HEX32);
  assert.equal(json[2].metadata.page_number, 2);
  assert.deepEqual((await partition([file("empty.txt")])).json, []);

  // 11. Two files in one request are concatenated in part order.
  const both = (await partition([file("vendors.csv"), file("handbook.md")])).json;
  assert.equal(both.length, csv.length + md.length);
  assert.equal(both[0].metadata.filename, "vendors.csv");
  assert.equal(both[1].metadata.filename, "handbook.md");

  // 12. CSV output: fixed header + one row per element, quoted cells.
  const out = await partition([file("2026-09-08-site-visit.txt")], { output_format: "text/csv" });
  assert.ok((out.headers.get("content-type") ?? "").startsWith("text/csv"), out.headers.get("content-type"));
  assert.equal(out.headers.get("unstructured-api-version"), "0.1.0-firedrill");
  const lines = out.text.split("\r\n").filter((line) => line.length > 0);
  assert.equal(lines[0], "type,element_id,text,filename,filetype,languages,page_number,parent_id,category_depth,text_as_html,last_modified,link_urls,link_texts,emphasized_text_contents,emphasized_text_tags,is_continuation,orig_elements");
  assert.equal(lines.length, 1 + deu.length);
  assert.ok(lines[1].startsWith("Title,"));

  // 13. Canonical operation call returns the same array as the wire route.
  const canonical = await op("general.partition", { files: [{ filename: "handbook.md", content: fx.get("handbook.md").content }] });
  assert.deepEqual(canonical, md);

  // 14. Markdown edge shapes that must partition in linear time: a pipe row before a 200,000-space line, an unclosed
  // image, a heading padded with spaces, and a pre-formatted trailing-space line. Each answers in well under a second.
  const hostile = [
    ["a|b\n" + " ".repeat(200000) + "x", ["UncategorizedText"]],
    ["![a](" + "a".repeat(200000), ["UncategorizedText", "UncategorizedText", "UncategorizedText"]],
    ["# " + " ".repeat(200000) + "x", ["Title"]],
    ["1 " + " ".repeat(200000) + "x", ["UncategorizedText", "UncategorizedText", "UncategorizedText"]],
  ];
  for (const [content, expected] of hostile) {
    const started = Date.now();
    const result = (await partition([{ filename: "edge.md", content }])).json;
    assert.ok(Date.now() - started < 3000, `hostile markdown took ${Date.now() - started}ms`);
    assert.deepEqual(types(result), expected, JSON.stringify(types(result)));
  }
  const gfm = (await partition([{ filename: "t.md", content: "| a | b |\n| --- | :-: |\n| 1 | 2 |\n\n![alt](img.png \"t\")\n" }])).json;
  assert.deepEqual(types(gfm), ["Table", "Image"]);
  assert.equal(gfm[0].metadata.text_as_html, "<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>");
  assert.equal(gfm[1].text, "alt");
  assert.equal(gfm[1].metadata.image_url, "img.png");

  // 15. HTML shapes that must partition in linear time and keep everything they carry: a 300 KB attribute, a table at
  // the 10,000-row bound (every row kept), 200 nested divs, 50,000 links in one block (no cap on link metadata), 100,000
  // unmatched close tags, and a 200 KB Markdown run of "[" (a forward search that is never rescanned).
  const hostileHtml = [
    [`<p class="${"a".repeat(300000)}">x</p>`, "h.html", ["UncategorizedText"]],
    ["<table>" + "<tr><td>a</td><td>b</td></tr>".repeat(10000) + "</table>", "h.html", ["Table"]],
    ["<div>a".repeat(200), "h.html", Array(200).fill("UncategorizedText")],
    ["<a href=\"u\">t</a> ".repeat(50000), "h.html", ["UncategorizedText"]],
    ["<span>".repeat(200) + "t" + "</div>".repeat(100000), "h.html", ["UncategorizedText"]],
    ["[a".repeat(100000), "h.md", ["UncategorizedText", "UncategorizedText"]],
  ];
  const kept = [];
  for (const [content, filename, expected] of hostileHtml) {
    const started = Date.now();
    const result = (await partition([{ filename, content }])).json;
    assert.ok(Date.now() - started < 3000, `hostile ${filename} took ${Date.now() - started}ms`);
    assert.deepEqual(types(result), expected, `${filename}: ${JSON.stringify(types(result)).slice(0, 120)}`);
    kept.push(result);
  }
  assert.equal(kept[1][0].text.split("\n").length, 10000, "every table row is kept at the bound");
  assert.equal(kept[1][0].metadata.text_as_html.split("<tr>").length - 1, 10000);
  assert.equal(kept[3][0].metadata.link_urls.length, 50000, "link metadata is never cut");
  assert.equal(kept[3][0].metadata.link_texts.length, 50000);

  // 16. Entity runs: 500,000 `&` without a `;` in HTML text, an HTML attribute and XML text decode in linear time (the `;`
  // search is bounded to 12 code units), every `&` kept literally; the text splits into 100,000-character elements.
  const ampersands = "&".repeat(500000);
  const entityRuns = [
    [`<p>${ampersands}</p>`, "amp.html", Array(5).fill("UncategorizedText")],
    [`<p class="${ampersands}">x</p>`, "attr.html", ["UncategorizedText"]],
    [`<r>${ampersands}</r>`, "amp.xml", Array(5).fill("UncategorizedText")],
  ];
  for (const [content, filename, expected] of entityRuns) {
    const started = Date.now();
    const result = (await partition([{ filename, content }])).json;
    assert.ok(Date.now() - started < 3000, `entity run ${filename} took ${Date.now() - started}ms`);
    assert.deepEqual(types(result), expected, `${filename}: ${JSON.stringify(types(result)).slice(0, 120)}`);
    if (expected.length === 5) assert.equal(result.reduce((sum, e) => sum + e.text.length, 0), 500000, `${filename}: every & is kept`);
  }
  const decoded = (await partition([{ filename: "ent.html", content: "<p>a &amp; b &lt;c&gt; &#65;&#x42; &unknown; &amp</p>" }])).json;
  assert.equal(decoded[0].text, "a & b <c> AB &unknown; &amp");

  // 17. JSON re-partition returns caller metadata as given (custom keys, scalar arrays, typed keys) — never a silent drop.
  const given = { custom: "v", tags: [1, "a", null, true], languages: ["eng", "deu"], page_number: 3, note: "n".repeat(10000) };
  const asGiven = (await partition([{ filename: "given.json", content: JSON.stringify([{ type: "Title", text: "t", metadata: given }]) }])).json;
  assert.equal(asGiven.length, 1);
  for (const key of Object.keys(given)) assert.deepEqual(asGiven[0].metadata[key], given[key], `metadata.${key} returned as given`);

  // 18. RFC 2046 multipart e-mail. A mixed-case boundary is matched case-sensitively (CRLF headers, a 5 KB text/plain body kept
  // whole); a non-text first part is skipped for the following text part; a nested multipart/alternative yields its text part;
  // a boundary delimiter with no line break after it, a missing close delimiter and a 71-character boundary answer 422 at once.
  const paragraph = "Quarterly field notes from the harbour survey were filed today.";
  const body5k = Array.from({ length: 80 }, () => paragraph).join(" ");
  assert.ok(body5k.length >= 5000, `body is ${body5k.length} characters`);
  const mixedCase = (await partition([{ filename: "mixed.eml", content: `From: a@example.test\r\nTo: b@example.test\r\nSubject: Survey\r\nContent-Type: Multipart/Mixed;\r\n boundary="----=_Part_123_ABC"\r\n\r\npreamble\r\n------=_Part_123_ABC\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body5k}\r\n------=_Part_123_ABC--\r\n` }])).json;
  assert.deepEqual(types(mixedCase), ["Title", "NarrativeText"]);
  assert.equal(mixedCase[1].text, body5k, "the whole text part is partitioned");
  const nonTextFirst = (await partition([{ filename: "attach.eml", content: "From: a@example.test\nSubject: Attachment\nContent-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: application/octet-stream\n\nAAECAw==\n--b\nContent-Type: text/plain\n\nThe report is attached to this message.\n--b--\n" }])).json;
  assert.deepEqual(types(nonTextFirst), ["Title", "NarrativeText"]);
  assert.equal(nonTextFirst[1].text, "The report is attached to this message.");
  const nestedAlt = (await partition([{ filename: "nested.eml", content: "From: a@example.test\nSubject: Nested\nContent-Type: multipart/mixed; boundary=outer\n\n--outer\nContent-Type: multipart/alternative; boundary=inner\n\n--inner\nContent-Type: text/plain\n\nPlain text version of the message body.\n--inner\nContent-Type: text/html\n\n<p>HTML version</p>\n--inner--\n--outer\nContent-Type: application/pdf\n\nJVBERi0=\n--outer--\n" }])).json;
  assert.deepEqual(types(nestedAlt), ["Title", "NarrativeText"]);
  assert.equal(nestedAlt[1].text, "Plain text version of the message body.");
  const malformed = [
    ["From: a@b.c\nSubject: s\nContent-Type: multipart/mixed; boundary=b\n\nContent-Type: application/octet-stream\n\n--b", "is not followed by a line break"],
    ["From: a@b.c\nSubject: s\nContent-Type: multipart/mixed; boundary=b\n\n--b\n\ntext\n", "no closing"],
    [`From: a@b.c\nSubject: s\nContent-Type: multipart/mixed; boundary=${"b".repeat(71)}\n\n--b\n`, "1-70"],
  ];
  for (const [content, fragment] of malformed) {
    const started = Date.now();
    const rejected = await partition([{ filename: "bad.eml", content }], {}, { status: 422 });
    assert.ok(Date.now() - started < 1000, `malformed e-mail took ${Date.now() - started}ms`);
    assert.ok(JSON.stringify(rejected.json.detail).includes(fragment), rejected.text.slice(0, 300));
  }

  // 19. A deterministic slice of the hostile-input harness (test/hostile.mjs): 300 cases across every format and the chunker,
  // each within 250 ms, answering elements or a declared error.
  const { runHostile } = await import("../hostile.mjs");
  // Correctness only: no throw, only declared codes, no hang. Wall-clock latency is machine-dependent, so the 250 ms bound
  // belongs to `node test/hostile.mjs`, not to this determinism check (a slower CI runner exceeded it on correct results).
  const report = await runHostile({ seed: 20260916, cases: 300, limitMs: Infinity, hangMs: 60000 });
  assert.deepEqual(report.failures, [], JSON.stringify(report.failures.slice(0, 5)));
}
