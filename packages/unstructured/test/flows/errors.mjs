// Partition error flow: provider error envelopes for every rejected request; nothing is logged for failures.
import assert from "node:assert/strict";
import { api, detail, multipart, partition } from "../lib.mjs";

export async function errorsFlow() {
  const one = [{ filename: "note.txt", content: "Just a short note." }];
  const bad = (fields, status, fragment, files = one) => partition(files, fields, { status }).then((r) => check(r, status, fragment));
  const check = (r, status, fragment) => {
    const d = r.json?.detail;
    assert.ok(d !== undefined, `expected detail envelope, got ${r.text.slice(0, 200)}`);
    const text = typeof d === "string" ? d : JSON.stringify(d);
    assert.ok(text.includes(fragment), `expected ${JSON.stringify(fragment)} in ${text.slice(0, 300)}`);
    return d;
  };

  const missing = await bad({ strategy: "fast" }, 422, "Field required", []);
  assert.deepEqual(missing[0].loc, ["body", "files"]);
  assert.equal(missing[0].type, "missing");
  await bad({ strategy: "layout" }, 400, "Invalid strategy: layout. Must be one of ['fast', 'hi_res', 'auto', 'ocr_only', 'vlm']");
  await bad({ chunking_strategy: "by_similarity" }, 400, "by_similarity is not supported");
  await bad({ chunking_strategy: "by_word" }, 400, "Invalid chunking strategy: by_word");
  await bad({ output_format: "text/xml" }, 400, "Invalid output format: text/xml");
  await bad({ hi_res_model_name: "chipper" }, 400, "Unknown model type: chipper");
  const vlm = await bad({ strategy: "vlm" }, 422, "vlm_model_provider");
  assert.ok(vlm.some((i) => i.loc.join(".") === "body.vlm_model_provider" && i.type === "missing"));
  const int = await bad({ max_characters: "abc", chunking_strategy: "basic" }, 422, "valid integer");
  assert.equal(int[0].type, "int_parsing");
  assert.deepEqual(int[0].loc, ["body", "max_characters"]);
  await bad({ chunking_strategy: "basic", max_characters: "500", overlap: "600" }, 422, "less than max_characters");
  const tooBig = await bad({ chunking_strategy: "basic", max_characters: "100001" }, 422, "less than or equal to 100000");
  assert.equal(tooBig[0].type, "less_than_equal");
  assert.deepEqual(tooBig[0].loc, ["body", "max_characters"]);
  await bad({ include_page_breaks: "maybe" }, 422, "valid boolean");
  await bad({ encoding: "latin-1" }, 400, "Unsupported encoding: latin-1");
  await bad({}, 400, "application/pdf not currently supported", [{ filename: "scan.pdf", content: "%PDF-1.7 pretend" }]);
  await bad({ content_type: "image/png" }, 400, "image/png not currently supported");
  await bad({}, 400, "None not currently supported", [{ filename: "noext", content: "x" }]);
  await bad({}, 422, "File is not a valid csv", [{ filename: "broken.csv", content: 'a,b\n1,"unterminated' }]);
  await bad({}, 422, "File is not a valid xml", [{ filename: "broken.xml", content: "<a><b>x</a>" }]);
  await bad({}, 400, "Json schema does not match the Unstructured schema", [{ filename: "notes.json", content: '{"a":1}' }]);
  await bad({}, 422, "too many text blocks", [{ filename: "blocks.txt", content: "x\n\n".repeat(100001) }]);
  await bad({ chunking_strategy: "basic", max_characters: "100" }, 413, "exceeds the 921600 byte response limit", [{ filename: "big.txt", content: Array.from({ length: 3000 }, (_, i) => `Entry ${i} posted.`).join("\n\n") }]);

  // Transport-level problems the codec reports itself (never a framework runtime message).
  await detail("POST", "/general/v0/general", 400, "boundary", { raw: "not multipart", contentType: "multipart/form-data" });
  await detail("POST", "/general/v0/general", 400, "Content-Disposition", { raw: "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n--b--\r\n", contentType: "multipart/form-data; boundary=b" });
  await detail("POST", "/general/v0/general", 422, "Expected multipart/form-data", { raw: "files=x", contentType: "application/x-www-form-urlencoded" });
  await detail("POST", "/general/v0/general", 422, "Expected multipart/form-data", { body: { files: [] } });
  const b64bad = multipart([{ name: "files", filename: "a.txt", value: "!!!notbase64", headers: { "Content-Transfer-Encoding": "base64" } }]);
  await detail("POST", "/general/v0/general", 422, "base64", { raw: b64bad.raw, contentType: b64bad.contentType });

  // A valid base64 part is decoded and partitioned (the one success of this flow).
  const b64 = multipart([{ name: "files", filename: "a.txt", value: Buffer.from("Encoded Title\n\nThis sentence arrived as base64 text and was decoded.").toString("base64"), headers: { "Content-Transfer-Encoding": "base64" } }]);
  const ok = await api("POST", "/general/v0/general", { raw: b64.raw, contentType: b64.contentType });
  assert.deepEqual(ok.json.map((e) => e.type), ["Title", "NarrativeText"]);

  // Wrong key: the framework's own 401 (before any codec runs).
  await api("POST", "/general/v0/general", { raw: b64.raw, contentType: b64.contentType, status: 401, token: "not-the-key" });

  // Partitioner bounds fail with the declared 422, never truncate, and answer in linear time: 300 nested elements,
  // a 12,000-row table, a 201-cell row and 300 nested XML elements.
  const bounds = [
    ["<div>a".repeat(300), "deep.html", "elements nested deeper than 256 levels"],
    ["<table>" + "<tr><td>a</td><td>b</td></tr>".repeat(12000) + "</table>", "rows.html", "File has a table with more than 10000 rows"],
    ["<table><tr>" + "<td>a</td>".repeat(201) + "</tr></table>", "cells.html", "File has a table row with more than 200 cells"],
    ["<a>".repeat(300) + "t" + "</a>".repeat(300), "deep.xml", "File is not a valid xml: elements nested deeper than 256 levels"],
    // Markdown pipe tables share the bound at any width: a 5,000-column table (separator row over 25,000 characters)
    // and a one-column header over a 300-cell separator both fail instead of being read as text.
    [`${"| a ".repeat(5000)}|\n${"| --- ".repeat(5000)}|\n${"| 1 ".repeat(5000)}|\n`, "wide.md", "File has a table row with more than 200 cells"],
    [`| a |\n${"| --- ".repeat(300)}|\n| 1 |\n`, "narrow-header.md", "File has a table row with more than 200 cells"],
  ];
  for (const [content, filename, fragment] of bounds) {
    const started = Date.now();
    await bad({}, 422, fragment, [{ filename, content }]);
    assert.ok(Date.now() - started < 3000, `bound ${filename} took ${Date.now() - started}ms`);
  }

  // Chunk output is sized arithmetically before any piece is built: overlap_all with overlap = max_characters - 1 would
  // multiply two 20,000-character paragraphs into 400 MB of chunk text; the request answers 413 in milliseconds instead.
  const paragraphs = `${"a".repeat(20000)}\n\n${"b".repeat(20000)}`;
  for (const chunking_strategy of ["basic", "by_title"]) {
    const started = Date.now();
    await bad({ chunking_strategy, max_characters: "20000", overlap: "19999", overlap_all: "true" }, 413, "exceeds the 921600 byte response limit", [{ filename: "wide.txt", content: paragraphs }]);
    assert.ok(Date.now() - started < 3000, `overlap_all ${chunking_strategy} took ${Date.now() - started}ms`);
  }
  await bad({ chunking_strategy: "basic", max_characters: "1" }, 413, "exceeds the 921600 byte response limit", [{ filename: "one.txt", content: "a".repeat(100000) }]);

  // Every piece of a chunk group carries a copy of the group's metadata, so large merged link/emphasis arrays, e-mail recipient
  // lists or orig_elements multiply by the piece count: 5,000 links at the default max_characters (8.9 MB of pieces), 20,000
  // `<b>` marks at max_characters=19 (169 MB), a 100,000-character paragraph at 19 with orig_elements (700 MB), an e-mail with
  // 50,000 recipients (2.4 GB) and a 5,000-row table at 19 with orig_elements (2.1 GB) each answer 413 before any piece exists.
  const multiplied = [
    [{ chunking_strategy: "basic" }, { filename: "links.html", content: `<p>${'<a href="https://example.test/u">x</a> '.repeat(5000)}</p>` }],
    [{ chunking_strategy: "basic", max_characters: "19", include_orig_elements: "false" }, { filename: "marks.html", content: `<p>${"<b>x</b>".repeat(20000)}</p>` }],
    [{ chunking_strategy: "basic", max_characters: "19" }, { filename: "orig.html", content: `<p>${"a".repeat(100000)}</p>` }],
    [{ chunking_strategy: "basic", max_characters: "19", include_orig_elements: "false" }, { filename: "wide.eml", content: `From: a@example.test\nTo: ${"a@example.test,".repeat(50000)}\nSubject: s\n\n${"x".repeat(100000)}` }],
    [{ chunking_strategy: "by_title", max_characters: "19" }, { filename: "table.html", content: `<table>${"<tr><td>abcdefghijklmnopqrst</td></tr>".repeat(5000)}</table>` }],
  ];
  for (const [fields, file] of multiplied) {
    const started = Date.now();
    await bad(fields, 413, "exceeds the 921600 byte response limit", [file]);
    assert.ok(Date.now() - started < 3000, `${file.filename} took ${Date.now() - started}ms`);
  }

  // JSON metadata that cannot be returned as given (more than 100 keys, a string over 10,000 characters, an array over 200
  // items, a nested object, a mistyped known key) fails the upload with the schema message; nothing is dropped on a 200.
  const many = {};
  for (let i = 0; i < 101; i += 1) many[`k${i}`] = i;
  const metadataShapes = [many, { big: "x".repeat(10001) }, { arr: Array(201).fill(1) }, { nested: { a: 1 } }, { page_number: -1 }, { languages: Array(51).fill("x") }];
  // The languages parameter is bounded (20 entries of at most 20 characters): over the bound is a 422, never a shortened list.
  await bad({ languages: Array.from({ length: 25 }, (_, i) => `l${i}`) }, 422, "at most 20 items");
  await bad({ languages: ["abcdefghijklmnopqrstuvwxyz0123"] }, 422, "at most 20 characters");
  await bad({ languages: "eng,deu,fra,spa,ita,por,nld,swe,nor,dan,fin,pol,ces,slk,hun,ron,bul,ell,tur,rus,ukr" }, 422, "at most 20 characters");
  for (const metadata of metadataShapes) await bad({}, 400, "Json schema does not match the Unstructured schema", [{ filename: "meta.json", content: JSON.stringify([{ type: "Title", text: "t", metadata }]) }]);
}
