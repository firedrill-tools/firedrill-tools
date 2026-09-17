# @firedrill-tools/tool-unstructured

A synthetic **Unstructured** account for [Firedrill](https://firedrill.run) drills. It stands in for the two public
Unstructured HTTP surfaces so an agent that partitions documents or drives ingestion workflows can be tested locally,
deterministically and offline:

- the **Partition Endpoint** — `POST /general/v0/general` with a multipart upload, answering the familiar JSON array of
  elements (`type`, `element_id`, `text`, `metadata`), optionally chunked;
- the **Workflow Endpoint** subset — source connectors, destination connectors, workflows made of partition / chunk /
  embed / prompter nodes, and jobs that run a workflow over the files a source holds.

Everything is synthetic. Partitioning is a **deterministic, rule-based partition of UTF-8 text documents** (plain text,
Markdown, HTML, CSV/TSV, RFC 822 e-mail, XML and pre-partitioned Unstructured JSON). No model, OCR or layout detection
runs, no connector reaches a real bucket or vector store, and no Unstructured service is ever contacted. Firedrill owns
the state, the virtual clock and the evidence. Backend only: there is no browser app.

## Install

```sh
firedrill tool add ./firedrill-tools-tool-unstructured-0.1.3.tgz --install
firedrill serve --scenario baseline --no-open
```

`firedrill tool add` copies the starter rows into a new world (35 rows, virtual time 2026-09-16T09:00:00Z) and grants
the default actor every operation. Existing worlds receive neither data nor grants: add the 25 `unstructured.<operation>`
grants listed below and the rows from `starter.json` yourself. Point a client at the world's HTTP origin with the
`unstructured-api-key` header set to `FIREDRILL_HTTP_TOKEN` (the declared connection recipe `unstructured-api` maps
`UNSTRUCTURED_API_URL` and `UNSTRUCTURED_API_KEY`). The real product serves the partition and platform APIs from two
different hosts; here both are routes of the world's single origin.

## Identities

An API key belongs to one organisation workspace and sees every connector, workflow and job of that workspace. The actor
attribute `unstructuredWorkspaceId` names the workspace row (`workspaces` namespace):

| actor attribute | behaviour |
|---|---|
| absent (a fresh `firedrill tool add` actor) | falls back to the seeded default workspace `ws_northgate`; the fresh actor sees all seeded data |
| `unstructuredWorkspaceId: "ws_northgate"` / `"ws_archive"` | scoped to that workspace; records of the other workspace behave as if they did not exist (404 on get, absent from lists, 422 `Source connector not found` when referenced) |
| any other value | `401 {"detail": "API key is invalid"}` on every operation |

Framework grants decide whether an operation may be called at all; a missing grant is rendered as
`403 {"detail": "This API key is not granted this operation in the Firedrill world."}`. There is no read-only key level in
the real product, so none is modelled.

## Starting data

The fictional **Northgate Research** account (`ws_northgate`) plus a second workspace used only for scoping tests:

- **Sources**: `Policy archive` (s3, key `policy-archive`, 7 files: `handbook.md`, `refund-policy.txt`, `vendors.csv`,
  `release-notes.html`, `elements.json`, `empty.txt`, `ledger.txt`), `Field notes` (google_drive, 3 files:
  `2026-09-08-site-visit.txt`, `inbound.eml`, `glossary.md` with non-ASCII text and a 2,400-character paragraph),
  `Legacy scans` (azure, 2 files that always fail: an encrypted PDF and a PNG), and `Archive dump` in `ws_archive`.
- **Destinations**: `Parsed output bucket` (s3), `Policy index` (pinecone), and one s3 bucket in `ws_archive`.
- **Workflows**: `policy-ingest` (custom: partition/fast → chunk_by_title 800 chars → embed, daily), `notes-basic` (auto),
  `legacy-scan` (custom, **inactive**), and `archive-flow` in `ws_archive`.
- **Jobs** (statuses derived from virtual time): two `COMPLETED` runs of `policy-ingest` (the download fixtures), one
  `STOPPED` and one `IN_PROGRESS` run of `notes-basic`, one `FAILED` run of `legacy-scan` (both files failed), and one
  `SCHEDULED` run of `policy-ingest` created two seconds before virtual now.
- Two connection checks (`SUCCESS` for the policy archive, `FAILURE` for the legacy scans), `meta/counters` and
  `meta/limits`.

Connector secrets are stored as the placeholder `********`; no value in the starter data is a real credential, address or
person. `ledger.txt` (2,800 short blocks) is deliberately large: partitioning it with chunking and `orig_elements`, or
downloading it from a finished job, exceeds the 900 KB response budget and answers `413`.

## Operations and routes

All routes authenticate with the `unstructured-api-key` header (the framework compares it with the world's HTTP token).
Platform collection routes take **no trailing slash** (`/api/v1/sources`); the OpenAPI's `/api/v1/sources/` form answers
the framework's 404 because Firedrill route templates cannot end with `/`. No MCP aliases are declared (see
*Compatibility*); the canonical `unstructured.<operation>` names are always exposed. The "UNS-MCP name" column is a
reading aid only.

| operation | UNS-MCP name (reading aid) | HTTP route |
|---|---|---|
| `general.partition` | – | `POST /general/v0/general` (multipart; JSON array or `text/csv`) |
| `sources.list` | `list_sources` | `GET /api/v1/sources?source_type=` |
| `sources.create` | `create_source_connector` | `POST /api/v1/sources` |
| `sources.get` | `get_source_info` | `GET /api/v1/sources/{source_id}` |
| `sources.update` | `update_source_connector` | `PUT /api/v1/sources/{source_id}` |
| `sources.delete` | `delete_source_connector` | `DELETE /api/v1/sources/{source_id}` → `{}` |
| `sources.check_connection` | – | `POST /api/v1/sources/{source_id}/connection-check` |
| `sources.get_connection_check` | – | `GET /api/v1/sources/{source_id}/connection-check` |
| `destinations.list` | `list_destinations` | `GET /api/v1/destinations?destination_type=` |
| `destinations.create` | `create_destination_connector` | `POST /api/v1/destinations` |
| `destinations.get` | `get_destination_info` | `GET /api/v1/destinations/{destination_id}` |
| `destinations.update` | `update_destination_connector` | `PUT /api/v1/destinations/{destination_id}` |
| `destinations.delete` | `delete_destination_connector` | `DELETE /api/v1/destinations/{destination_id}` → `{}` |
| `workflows.list` | `list_workflows` | `GET /api/v1/workflows?source_id=&destination_id=&status=&name=&page=&page_size=&sort_by=&sort_direction=` |
| `workflows.create` | `create_workflow` | `POST /api/v1/workflows` |
| `workflows.get` | `get_workflow_info` | `GET /api/v1/workflows/{workflow_id}` |
| `workflows.update` | `update_workflow` | `PUT /api/v1/workflows/{workflow_id}` |
| `workflows.delete` | `delete_workflow` | `DELETE /api/v1/workflows/{workflow_id}` → `{}` |
| `workflows.run` | `run_workflow` | `POST /api/v1/workflows/{workflow_id}/run` → 202 (empty body, or multipart `input_files` parts) |
| `jobs.list` | `list_jobs` | `GET /api/v1/jobs?workflow_id=&status=&page=&page_size=` |
| `jobs.get` | `get_job_info` | `GET /api/v1/jobs/{job_id}` |
| `jobs.cancel` | `cancel_job` | `POST /api/v1/jobs/{job_id}/cancel` → `{ id, status, message }` |
| `jobs.get_details` | – | `GET /api/v1/jobs/{job_id}/details` |
| `jobs.get_failed_files` | – | `GET /api/v1/jobs/{job_id}/failed-files` |
| `jobs.download_output` | – | `GET /api/v1/jobs/{job_id}/download?file_id=&node_id=` |

### Partitioning

`POST /general/v0/general` accepts `files` parts (several are consolidated into one array in part order) and the
parameters that affect text partitioning and chunking: `content_type`, `strategy` (`auto|fast|hi_res|ocr_only|vlm`,
validated and otherwise inert), `output_format` (`application/json` or `text/csv`), `encoding` (UTF-8/ASCII names only),
`languages[]` (recorded in metadata whole; at most 20 entries of at most 20 characters, otherwise a 422), `include_page_breaks`, `starting_page_number`, `unique_element_ids`,
`xml_keep_tags`, `chunking_strategy` (`basic|by_title|by_page`), `max_characters`, `new_after_n_chars`, `overlap`,
`overlap_all`, `combine_under_n_chars`, `multipage_sections`, `include_orig_elements`. `split_pdf_*`, `ocr_languages`,
`include_slide_notes`, `pdf_infer_table_structure`, `skip_infer_table_types`, `extract_image_block_types` and
`coordinates` are accepted and ignored. A request `files` part sent with `Content-Transfer-Encoding: base64` is decoded before partitioning; transfer encodings *inside* an uploaded e-mail are not (see the e-mail notes below).

The file type comes from the `content_type` field, then the part's `Content-Type`, then the filename extension
(`.txt .md .html .htm .csv .tsv .json .eml .xml .rst`). Elements carry `filename`, `filetype`, `languages`,
`page_number` (form feeds and HTML `page-break` styles advance it), `last_modified`, `parent_id` (nearest preceding
Title of smaller depth), `category_depth` on titles and list items, `text_as_html` on tables, `link_texts`/`link_urls`,
`emphasized_text_contents`/`emphasized_text_tags`, and for e-mail `sent_from`, `sent_to`, `cc_recipient`,
`bcc_recipient`, `subject`, `email_message_id`. `element_id` is the first 32 hex characters of SHA-256 over filename,
page, ordinal and text (a UUID when `unique_element_ids=true`). Chunks are `CompositeElement`, `Table` or `TableChunk`
elements whose `orig_elements` is base64 of a real gzip stream (stored blocks) of the original elements — any gzip
reader and the `unstructured` library's `elements_from_base64_gzipped_json` decode it.

Each successful call writes one `partition-log` row and emits `partition.completed`, so drills can assert on a
stateless endpoint.

### Workflows and jobs

`workflows.run` snapshots the workflow's nodes on the job and decides each file's fate immediately: a file fails when
its seeded `error` is set or the partitioner rejects it. Job **status is derived from virtual time** at every read:
`SCHEDULED` for 5 s after creation, `IN_PROGRESS` for 10 s per file plus 1 s per 4 KB, then `COMPLETED`
(`processing_status` `SUCCESS` or `COMPLETED_WITH_ERRORS`) or `FAILED` when every file failed; `jobs.cancel` on a
running job makes it `STOPPED`. Nothing happens between calls and no event is scheduled: advancing the world clock is
what "finishes" a job. `jobs.download_output` recomputes the elements of one successful file with the snapshotted
partition and chunk node settings (`file_id` and `node_id` of an `output_node_files` entry; the last node stands in for
the destination). Embed and prompter nodes are validated and inert. Schedules are stored and echoed but never fire.

## Compatibility

`manifest.compatibility` is empty: **no official client has been exercised against this Tool.** The route shapes follow the
public Unstructured documentation, the Platform OpenAPI document and the open-source partition server
(`unstructured-api`), so `unstructured-client` (PyPI / npm) configured with `server_url = FIREDRILL_HTTP_URL` and
`api_key_auth = FIREDRILL_HTTP_TOKEN` should reach `client.general.partition`, `client.sources.*`,
`client.destinations.*`, `client.workflows.*` and `client.jobs.*` for the implemented subset, but that is untested. No
MCP aliases are declared: the only published MCP contract with these resources (UNS-MCP) is unmaintained and documents no
argument shapes, and the hosted Transform MCP server publishes no tool list.

Error bodies use the FastAPI envelopes both endpoints use: `{"detail": "<message>"}` for 400/401/403/404/413/429/500/503
and `{"detail": [{"loc": [...], "msg": "...", "type": "..."}]}` for 422 field errors (types `missing`, `int_parsing`,
`bool_parsing`, `enum`, `extra_forbidden`, `value_error`). Known deviations, all framework-level:

- Requests rejected **before any codec runs** keep the Firedrill envelope: a missing or wrong `unstructured-api-key`
  (401), an unknown path or the trailing-slash collection form (404 `framework.HTTP_ROUTE_NOT_FOUND`), a wrong method on a
  known path (405 `framework.HTTP_METHOD_NOT_ALLOWED` on the current framework; a 2026-09-16 build answered 404
  `HTTP_ROUTE_NOT_FOUND` — either way a framework envelope, never a `{detail}`), unparsable or empty JSON on a
  JSON route (400 `framework.HTTP_BODY_INVALID`), invalid UTF-8 or a body over 1 MiB.
- A schema-invalid argument (for example a 600-character id) answers **400** with the `detail` array, not 422; the codec
  builds the array but the framework fixes the status.
- Binary uploads never reach the Tool: the framework decodes multipart bodies as UTF-8 text first, so a PDF or image
  answers the framework's 400 `request body must be valid UTF-8`. Text files with a binary-looking name (`scan.pdf`) reach
  the Tool and answer `400 {"detail": "application/pdf not currently supported"}`.
- `unstructured-api-version: 0.1.0-firedrill` is a Tool-specific response header on the partition route.
- Several wire details are assumptions recorded in `specs/unstructured/SPEC.md` until a client run settles them:
  create routes answer 200 (not 201), run answers 202, deletes answer `{}`, cancel answers `{ id, status, message }`,
  jobs list newest first, `Retry-After: 1` and the 429 text, the fixed CSV column set, several 422 message texts and the
  `sources`/`destinations`/`reason` fields on workflow and job objects.

## Events and faults

| id | kind | when |
|---|---|---|
| `partition.completed` | event | every successful `general.partition` (`log_id`, filenames, filetypes, strategy, chunking strategy, counts) |
| `job.created` | event | every successful `workflows.run` — also under `run-response-lost`, because that fault fires after commit |
| `job.cancelled` | event | every successful `jobs.cancel` |
| `partition-rate-limited` | fault (before) | `general.partition` → 429 `Rate limit exceeded. Please retry after a short delay.` with `Retry-After: 1`; nothing logged |
| `partition-overloaded` | fault (before) | `general.partition` → 503 `Server is under heavy load. Please try again later.` (the open server's text) |
| `run-response-lost` | fault (after commit) | `workflows.run` → 500 `Internal Server Error` although the job **was** created; a naive retry creates a second job, `jobs.list` shows the truth |

Scenarios shipped with the conformance project: `baseline`, `rate-limited`, `overloaded`, `run-response-lost`,
`tight-limits` (lowers `meta/limits` so every bounded scan fails `500 state exceeds the supported bound` instead of
truncating) and `small-responses` (lowers `meta/limits.response_bytes` to 520 so every list or page over the budget
fails `413 RESPONSE_TOO_LARGE` instead of being shortened).

## Limitations

- **Text documents only.** PDF, Office, image, e-book and archive formats are refused (`… not currently supported`)
  even though the real service supports them. No OCR, layout model, VLM, table-structure inference, coordinates, image
  extraction or language detection; `strategy`, `languages`, `vlm_*`, `coordinates` and the PDF/OCR parameters are
  validated or accepted and otherwise inert (`vlm` still requires `vlm_model` and `vlm_model_provider`).
- **Element classification is heuristic and Tool-specific.** Title/NarrativeText/ListItem/Address/EmailAddress rules
  approximate the library for these formats but are not it; `element_id`s are deterministic but not the library's hash.
  E-mail: headers end at the first empty line (CRLF, LF and bare CR line endings may be mixed; a leading mbox `From `
  envelope line is skipped); `Subject`, `From`, `To`, `Cc` and `Bcc` decode RFC 2047 encoded words in UTF-8, US-ASCII or
  ISO-8859-1 (other charsets stay literal), and address lists split on commas outside quoted strings, angle brackets and
  comments; a multipart body is split on its RFC 2046
  boundary, matched case-sensitively, and the **first text part in document order** (depth first through nested multiparts)
  is partitioned — as HTML for `text/html`, as plain text otherwise. Attachments and later alternatives are not partitioned,
  and `Content-Transfer-Encoding` (base64, quoted-printable) is not decoded. Malformed structure answers `422 {"detail":
  "File is not a valid eml: …"}` naming it: a header line that is not a field before the blank line, a missing, empty,
  over-70-character or invalid boundary, no delimiter, a delimiter with no line break after it, no close delimiter, more
  than 1,000 parts, or multiparts nested deeper than 4 levels.
- **Chunking**: `basic`, `by_title`, `by_page` only; `by_similarity` is refused. `orig_elements` is a valid but
  uncompressed gzip stream (larger than the real payload). A table row longer than `max_characters` becomes its own run
  of `TableChunk` pieces (its markup rides with the first piece); nothing is cut. Chunk output is sized per chunk
  group before any piece of that group is built: a text of L characters splits into 1 + ⌈(L − max)/(max − overlap)⌉
  pieces holding L + (pieces − 1)·overlap characters (arithmetic), and every piece carries a copy of the group's metadata
  (the merged `link_urls`/`link_texts`/emphasis arrays, e-mail recipients, `orig_elements`), which is built **once** per
  group — linear in that group's elements, its gzip included — measured once in JSON bytes and multiplied by the piece
  count. When the running total of the request (summed across its files: chunk text + pieces × metadata + 90 bytes per
  chunk, a lower bound of the JSON) passes the response budget the request answers `413 {"detail": "Partition output of
  at least N bytes exceeds the 921600 byte response limit; upload fewer or smaller files, raise max_characters or lower
  overlap"}` before a single piece of that group exists — an `overlap` of `max_characters − 1` with `overlap_all=true`
  (accepted, as the library accepts it) would otherwise multiply the text by `max_characters`, and 5,000 links or 20,000
  `<b>` marks in one paragraph chunked at a small `max_characters` would otherwise multiply their metadata into
  gigabytes. The pieces that are built share the group's metadata (arrays by reference, one shallow copy per piece).
  The work done before each check is bounded by that group's input, never by its piece count. Workflow chunk nodes are sized the same way at run time (against the default
  921,600 bytes; the failure is recorded as the file's error) and again by `jobs.download_output`. CSV output uses a
  fixed column set.
- **Workflow Endpoint subset**: no `POST /api/v1/jobs`, destination connection checks, notifications, templates,
  soft-deleted or recommender listings, `created_since`/`created_before`, `source_ids`/`destination_ids` fan-out or
  `skip_preflight` (all answer 422 `… not supported by this Tool` or 404). Connector `config` is checked only for the
  presence of a small per-type required-key table; secrets (`secret_access_key`, `token`, `password`, `client_secret`,
  `private_key`, `api_key`, …) are masked as `********` in every response and a masked value on update keeps the stored
  secret. Connector and workflow `key` values must be unique within a workspace. Hard deletes only.
- **Jobs are simulated in virtual time** (see above); no page accounting or billing.
- **Bounds** (a bound fails loudly; nothing is returned shortened): 2,000 connectors, 5,000 workflows and 5,000 jobs per namespace, 200 files per
  source, 32 files per request, 900 KB of runtime files per run, 900 KB per response (`meta/limits.response_bytes`),
  100,000 text blocks or elements per document, 100,000 characters per element or chunk (`max_characters`,
  `new_after_n_chars`, `overlap` and `combine_under_n_chars` accept at most 100,000, else a pydantic-style 422
  `less_than_equal`), 10,000 rows × 200 cells per CSV/TSV file, HTML table or Markdown pipe table, 256 levels of HTML or XML element
  nesting, 512 levels of JSON nesting, 64 multipart parts per request, 10,000 header lines, 1,000 MIME parts and 4 multipart nesting
  levels per e-mail, 20 `languages` entries of at most 20 characters (the partition parameter and a workflow partition
  node's `settings.languages`; more is a 422 naming `languages`). Blank lines and paragraph continuation lines do not count
  as text blocks. A partitioner bound is a `422 {"detail": …}` naming it —
  `File has a table with more than 10000 rows`, `File has a table row with more than 200 cells`, `File is not valid
  html: elements nested deeper than 256 levels` (`… not a valid xml: …` for XML), `File has more than 10000 rows` /
  `… 200 columns` for CSV, `File has too many text blocks` / `File produces too many elements` — never a shortened
  element. Element metadata (`link_texts`/`link_urls`, emphasis, `image_url`, e-mail recipients, `subject`,
  `email_message_id`, merged chunk arrays) is never cut either: it is bounded only by the 1 MiB file cap and the
  response budget below. Caller metadata on an `application/json` upload is returned exactly as given when it fits the
  output schema (at most 100 keys of at most 100 characters, known keys with their type, other values scalars of at
  most 10,000 characters or arrays of at most 200 scalars) and otherwise fails the whole upload with the 400 schema
  message — no key, string or array is dropped from a 200. Every partitioner and chunker pass is a forward scan over the input
  with explicit bounds: the HTML/XML tokenizer is one forward scan whose attribute and raw-text searches stop at their own
  tag, an entity reference is looked up within the 12 code units after its `&`, the tree builder keeps an explicit stack
  with per-name open counts, text is accumulated in arrays and joined once, Markdown inline searches are memoised forward
  scans, the e-mail parser walks lines with an index that must advance on every iteration (a scan that did not advance
  fails 422), chunk output is sized against the response budget per chunk group before any piece of that group is built
  (§Chunking above), merged chunk link/emphasis arrays are copied item by item (never spread as call arguments) and fail
  413 once they pass the budget, and no backtracking regular expression runs over caller text. While elements are built a
  running lower bound of their encoded size (text, id, filename, metadata strings and array items, e-mail metadata) is
  checked against the response budget whenever the elements themselves are serialised (unchunked output, or
  `orig_elements` against three quarters of the budget), so an oversized result answers 413 before megabytes of elements
  are encoded. **Measured bound, not a proof:** `test/hostile.mjs` (see `specs/unstructured/VERIFICATION.md` §13) runs
  20,000 generated hostile inputs per seed — every format and the chunker, sizes up to just under the 1 MiB cap — directly
  through the partitioner with the result JSON-encoded as the route does (every fourth case also decodes a hostile
  multipart/form-data request envelope through both multipart route decoders, whose parser walks the body forward once), and fails on any case over 250 ms, any thrown
  error or any undeclared error code; the worst case observed is recorded there (about 100–200 ms, reached by 1 MB inputs
  that build the 100,000-element bound, where one SHA-256 element id per element dominates). Earlier HTTP measurements on
  `firedrill serve` are recorded per fix round in VERIFICATION §9–§12. A namespace larger than its bound answers `500 {"detail": "state exceeds the supported bound of N <namespace>
  rows"}`. Every response — element arrays, CSV, job downloads, the unpaginated `sources`/`destinations` arrays and each
  `workflows`/`jobs` page — is measured in UTF-8 bytes before it is returned; one that would pass the budget answers
  `413 {"detail": "… exceeds the 921600 byte response limit; lower page_size"}` (or `filter by source_type …` for the
  connector lists). A page always holds exactly the requested rows or fails: it is never shortened, because a shortened
  page would make the rows before the next page boundary unreachable.
- Generic `/api/v1/…` and `/general/…` paths could collide with another installed Tool that claims the same paths.

## Trademarks

Unstructured is a trademark of its owner. The name is used only to identify the service this Tool simulates in a test
environment; there is no affiliation with or endorsement by Unstructured Technologies, Inc. No logo is shipped.

## License

Apache-2.0 — see `LICENSE`.
