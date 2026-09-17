// `general.partition`: the legacy Partition Endpoint over the deterministic text partitioner.
import { Issues, fail, requestProblem } from "../lib/errors.mjs";
import { nextSeq } from "../lib/ids.mjs";
import { workspaceOf } from "../lib/identity.mjs";
import { assertWithinBudget, jsonBytes, responseBudget } from "../lib/pages.mjs";
import { elementsToCsv } from "../lib/partition/csvout.mjs";
import { MAX_TEXT } from "../lib/partition/elements.mjs";
import { partitionFile } from "../lib/partition/index.mjs";
import { clip, isoFromUs, utf8Length } from "../lib/util.mjs";
import { parseBool, parseEnum, parseInteger, parseLanguages, parseString } from "../lib/validate.mjs";

const STRATEGIES = ["fast", "hi_res", "auto", "ocr_only", "vlm"];
const CHUNKING = ["basic", "by_title", "by_page", "by_similarity"];
const OUTPUTS = ["application/json", "text/csv"];
const ENCODINGS = new Set(["utf-8", "utf8", "utf_8", "ascii", "us-ascii"]);
const MAX_FILES = 32;
const MAX_CONTENT = 1048576;


/** Validates every partition/chunk parameter. Returns { options, strategy, chunkingStrategy, outputFormat }. */
export function partitionOptions(input, context) {
  const invalid = (message) => fail(context, "INVALID_REQUEST", message);
  const strategyRaw = input.strategy === undefined || input.strategy === null || input.strategy === "" ? "auto" : input.strategy;
  const strategy = typeof strategyRaw === "string" ? strategyRaw.toLowerCase() : "";
  if (!STRATEGIES.includes(strategy)) invalid(`Invalid strategy: ${clip(strategyRaw)}. Must be one of ['fast', 'hi_res', 'auto', 'ocr_only', 'vlm']`);
  if (typeof input.hi_res_model_name === "string" && input.hi_res_model_name.length > 0) invalid(`Unknown model type: ${clip(input.hi_res_model_name)}`);
  const outputFormat = input.output_format === undefined || input.output_format === null || input.output_format === "" ? "application/json" : input.output_format;
  if (!OUTPUTS.includes(outputFormat)) invalid(`Invalid output format: ${clip(outputFormat)}. Must be one of ['application/json', 'text/csv']`);
  let chunkingStrategy = null;
  if (input.chunking_strategy !== undefined && input.chunking_strategy !== null && input.chunking_strategy !== "") {
    if (!CHUNKING.includes(input.chunking_strategy)) invalid(`Invalid chunking strategy: ${clip(input.chunking_strategy)}. Must be one of ['basic', 'by_title', 'by_page', 'by_similarity']`);
    if (input.chunking_strategy === "by_similarity") invalid("Chunking strategy by_similarity is not supported by this Tool");
    chunkingStrategy = input.chunking_strategy;
  }
  if (input.encoding !== undefined && input.encoding !== null && input.encoding !== "") {
    if (typeof input.encoding !== "string" || !ENCODINGS.has(input.encoding.toLowerCase())) invalid(`Unsupported encoding: ${clip(input.encoding)}`);
  }
  const issues = new Issues();
  const contentType = parseString(input.content_type, "body.content_type", issues, { max: 200 });
  const languages = parseLanguages(input.languages, "body.languages", issues) ?? [];
  const includePageBreaks = parseBool(input.include_page_breaks, "body.include_page_breaks", issues, false);
  const startingPage = parseInteger(input.starting_page_number, "body.starting_page_number", issues, 1, { min: 0, max: 1000000 });
  const uniqueIds = parseBool(input.unique_element_ids, "body.unique_element_ids", issues, false);
  const xmlKeepTags = parseBool(input.xml_keep_tags, "body.xml_keep_tags", issues, false);
  parseBool(input.coordinates, "body.coordinates", issues, false);
  const maxCharacters = parseInteger(input.max_characters, "body.max_characters", issues, 500, { min: 1, max: MAX_TEXT });
  let newAfterNChars = parseInteger(input.new_after_n_chars, "body.new_after_n_chars", issues, 1500, { min: 0, max: MAX_TEXT });
  const overlap = parseInteger(input.overlap, "body.overlap", issues, 0, { min: 0, max: MAX_TEXT });
  const overlapAll = parseBool(input.overlap_all, "body.overlap_all", issues, false);
  const combineUnderNChars = parseInteger(input.combine_under_n_chars, "body.combine_under_n_chars", issues, maxCharacters, { min: 0, max: MAX_TEXT });
  const multipageSections = parseBool(input.multipage_sections, "body.multipage_sections", issues, true);
  const includeOrigElements = parseBool(input.include_orig_elements, "body.include_orig_elements", issues, true);
  for (const name of ["split_pdf_page", "split_pdf_allow_failed", "include_slide_notes", "pdf_infer_table_structure"]) parseBool(input[name], `body.${name}`, issues, false);
  parseInteger(input.split_pdf_concurrency_level, "body.split_pdf_concurrency_level", issues, 5, { min: 1, max: 50 });
  parseInteger(input.split_pdf_page_range, "body.split_pdf_page_range", issues, 0, { min: 0 });
  if (strategy === "vlm") {
    if (typeof input.vlm_model !== "string" || input.vlm_model.length === 0) issues.add("body.vlm_model", "Field required");
    if (typeof input.vlm_model_provider !== "string" || input.vlm_model_provider.length === 0) issues.add("body.vlm_model_provider", "Field required");
  }
  if (chunkingStrategy !== null && overlap >= maxCharacters) issues.add("body.overlap", `Input should be less than max_characters (${maxCharacters})`);
  if (newAfterNChars > maxCharacters) newAfterNChars = maxCharacters;
  issues.raise(context);
  const chunk = chunkingStrategy === null ? null : { strategy: chunkingStrategy, maxCharacters, newAfterNChars, overlap, overlapAll, combineUnderNChars: chunkingStrategy === "by_title" ? combineUnderNChars : 0, multipageSections, includeOrigElements };
  const options = { contentType, languages: languages.length > 0 ? languages : ["eng"], includePageBreaks, startingPage, xmlKeepTags, uniqueIds, nowIso: isoFromUs(context.clock.nowUs()), chunk, responseBudget: responseBudget(context), chunkSizing: { chars: 0, count: 0 }, elementSizing: { bytes: 0 } };
  return { options, strategy, chunkingStrategy, outputFormat };
}

/** Validates the `files` array shape (a 422 in the FastAPI envelope). */
export function checkFiles(files, context, loc = "body.files") {
  const issues = new Issues();
  if (!Array.isArray(files) || files.length === 0) issues.add(loc, "Field required");
  else if (files.length > MAX_FILES) issues.add(loc, `At most ${MAX_FILES} files per request`);
  else
    for (const [index, file] of files.entries()) {
      if (file === null || typeof file !== "object" || typeof file.content !== "string" || typeof file.filename !== "string") issues.add(`${loc}.${index}`, "Input should be a valid file upload");
      else if (file.content.length > MAX_CONTENT) issues.add(`${loc}.${index}`, `File content exceeds ${MAX_CONTENT} characters`);
      else if (file.filename.length > 500) issues.add(`${loc}.${index}.filename`, "String should have at most 500 characters");
    }
  issues.raise(context);
}

export function partition(input, context) {
  workspaceOf(context);
  requestProblem(input, context);
  const { options, strategy, chunkingStrategy, outputFormat } = partitionOptions(input, context);
  checkFiles(input.files, context);
  const elements = [];
  const filenames = [];
  const filetypes = [];
  let inputBytes = 0;
  let pageCount = 0;
  for (const file of input.files) {
    const result = partitionFile(file, options, context);
    if (!result.ok) fail(context, result.code, result.message);
    inputBytes += utf8Length(file.content);
    filenames.push(clip(file.filename, 200));
    filetypes.push(result.filetype);
    const pages = new Set();
    for (const element of result.elements) pages.add(element.metadata.page_number);
    pageCount += pages.size;
    for (const element of result.elements) elements.push(element);
  }
  const body = outputFormat === "text/csv" ? elementsToCsv(elements) : null;
  const bytes = body === null ? jsonBytes(elements) : utf8Length(body);
  assertWithinBudget(context, bytes, "Partition output", "upload fewer or smaller files");
  const seq = nextSeq(context);
  const log = { seq, actor_id: clip(context.actor.id, 200), filenames, filetypes, strategy, chunking_strategy: chunkingStrategy, output_format: outputFormat, element_count: elements.length, page_count: pageCount, input_bytes: inputBytes, created_at: options.nowIso };
  const logId = `p_${String(seq).padStart(10, "0")}`;
  context.state.put("partition-log", logId, log);
  context.events.emit("partition.completed", { log_id: logId, filenames, filetypes, strategy, chunking_strategy: chunkingStrategy, element_count: elements.length, page_count: pageCount, input_bytes: inputBytes });
  return body === null ? elements : { csv: body };
}
