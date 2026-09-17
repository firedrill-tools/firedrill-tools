// Workflow node validation and the mapping from a node snapshot to partitioner options.
import { normaliseConfig } from "../lib/connectors.mjs";
import { uuid } from "../lib/ids.mjs";
import { parseBool, parseInteger, parseLanguages, parseString } from "../lib/validate.mjs";
import { Issues } from "../lib/errors.mjs";
import { MAX_TEXT } from "../lib/partition/elements.mjs";

export const NODE_TYPES = ["partition", "chunk", "embed", "prompter"];
const PARTITION_SUBTYPES = ["auto", "fast", "hi_res", "vlm"];
const CHUNK_SUBTYPES = ["chunk_by_title", "chunk_by_character", "chunk_by_page", "chunk_by_similarity"];
const CHUNK_STRATEGY = new Map([["chunk_by_title", "by_title"], ["chunk_by_character", "basic"], ["chunk_by_page", "by_page"]]);

/** Default nodes of an `auto` workflow. */
export const defaultNodes = (context) => [
  { id: uuid(context), name: "Partitioner", type: "partition", subtype: "auto", settings: {} },
  { id: uuid(context), name: "Chunker", type: "chunk", subtype: "chunk_by_title", settings: { max_characters: 1500, new_after_n_chars: 1500, overlap: 0 } },
];

/** Validates `workflow_nodes` of a custom workflow; returns the normalised node array or null (issues added). */
export function validateNodes(value, loc, issues, context) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.add(loc, value === undefined || value === null ? "Field required" : "Input should be a valid list");
    return null;
  }
  if (value.length > 16) {
    issues.add(loc, "List should have at most 16 items");
    return null;
  }
  const nodes = [];
  let partitions = 0;
  let chunks = 0;
  for (const [index, node] of value.entries()) {
    const at = `${loc}.${index}`;
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      issues.add(at, "Input should be a valid dictionary or object");
      continue;
    }
    const name = parseString(node.name, `${at}.name`, issues, { required: true, min: 1, max: 200 });
    const type = typeof node.type === "string" && NODE_TYPES.includes(node.type) ? node.type : (issues.add(`${at}.type`, "Input should be 'partition', 'chunk', 'embed' or 'prompter'"), null);
    const subtype = parseString(node.subtype, `${at}.subtype`, issues, { required: true, min: 1, max: 100 });
    const id = node.id === undefined || node.id === null ? uuid(context) : parseString(node.id, `${at}.id`, issues, { min: 1, max: 64 });
    let settings = {};
    if (node.settings !== undefined && node.settings !== null) {
      const result = normaliseConfig(node.settings, `${at}.settings`);
      if (result.issues !== undefined) for (const [where, message] of result.issues) issues.add(where, message);
      else settings = result.config;
    }
    if (type === "partition") {
      partitions += 1;
      if (index !== 0) issues.add(`${at}.type`, "The partition node must be the first node");
      if (subtype !== null && !PARTITION_SUBTYPES.includes(subtype)) issues.add(`${at}.subtype`, "Input should be 'auto', 'fast', 'hi_res' or 'vlm'");
      parseLanguages(settings.languages, `${at}.settings.languages`, issues);
    } else if (type === "chunk") {
      chunks += 1;
      if (subtype !== null && !CHUNK_SUBTYPES.includes(subtype)) issues.add(`${at}.subtype`, "Input should be 'chunk_by_title', 'chunk_by_character', 'chunk_by_page' or 'chunk_by_similarity'");
      if (subtype === "chunk_by_similarity") issues.add(`${at}.subtype`, "Chunking strategy by_similarity is not supported by this Tool");
      const check = new Issues();
      const max = parseInteger(settings.max_characters, `${at}.settings.max_characters`, check, 500, { min: 1, max: MAX_TEXT });
      parseInteger(settings.new_after_n_chars, `${at}.settings.new_after_n_chars`, check, max, { min: 0, max: MAX_TEXT });
      const overlap = parseInteger(settings.overlap, `${at}.settings.overlap`, check, 0, { min: 0, max: MAX_TEXT });
      parseInteger(settings.combine_under_n_chars, `${at}.settings.combine_under_n_chars`, check, max, { min: 0, max: MAX_TEXT });
      for (const flag of ["overlap_all", "multipage_sections", "include_orig_elements"]) parseBool(settings[flag], `${at}.settings.${flag}`, check, false);
      if (check.empty && overlap >= max) check.add(`${at}.settings.overlap`, `Input should be less than max_characters (${max})`);
      for (const item of check.items) issues.add(item.slice(4, item.indexOf(": ")), item.slice(item.indexOf(": ") + 2));
    }
    if (name !== null && type !== null && subtype !== null && id !== null) nodes.push({ id, name, type, subtype, settings });
  }
  if (partitions !== 1) issues.add(loc, "A custom workflow needs exactly one partition node");
  if (chunks > 1) issues.add(loc, "A custom workflow may have at most one chunk node");
  return issues.empty ? nodes : null;
}

/** Partitioner options for a node snapshot (validated on create/update, so parsing cannot fail here). */
export function nodeOptions(nodes, nowIso) {
  const quiet = new Issues();
  const chunkNode = nodes.find((node) => node.type === "chunk") ?? null;
  let chunk = null;
  if (chunkNode !== null && CHUNK_STRATEGY.has(chunkNode.subtype)) {
    const s = chunkNode.settings;
    // Clamped to MAX_TEXT so a chunk never exceeds the declared element text bound, whatever a stored node says.
    const maxCharacters = Math.min(parseInteger(s.max_characters, "x", quiet, 500, { min: 1 }), MAX_TEXT);
    const newAfter = parseInteger(s.new_after_n_chars, "x", quiet, maxCharacters, { min: 0 });
    chunk = {
      strategy: CHUNK_STRATEGY.get(chunkNode.subtype),
      maxCharacters,
      newAfterNChars: Math.min(newAfter, maxCharacters),
      overlap: Math.min(parseInteger(s.overlap, "x", quiet, 0, { min: 0 }), maxCharacters - 1),
      overlapAll: parseBool(s.overlap_all, "x", quiet, false),
      combineUnderNChars: chunkNode.subtype === "chunk_by_title" ? parseInteger(s.combine_under_n_chars, "x", quiet, maxCharacters, { min: 0 }) : 0,
      multipageSections: parseBool(s.multipage_sections, "x", quiet, true),
      includeOrigElements: parseBool(s.include_orig_elements, "x", quiet, true),
    };
  }
  const partitionNode = nodes.find((node) => node.type === "partition") ?? null;
  const settings = partitionNode === null ? {} : partitionNode.settings;
  return {
    contentType: null,
    // Validated on create/update (at most 20 entries of at most 20 characters), so the list is used whole.
    languages: typeof settings.languages === "string" && settings.languages.length > 0 ? settings.languages.split(",").map((l) => l.trim()).filter((l) => l.length > 0) : ["eng"],
    includePageBreaks: parseBool(settings.include_page_breaks, "x", quiet, false),
    startingPage: 1,
    xmlKeepTags: parseBool(settings.xml_keep_tags, "x", quiet, false),
    uniqueIds: false,
    nowIso,
    chunk,
  };
}
