// Deterministic 40-hex digests for synthetic git objects. Five FNV-1a 32-bit rounds with distinct seeds are
// concatenated; the result looks like a git sha but is NOT a real git object hash (documented in the README).
import { treeEntries } from "./tree.mjs";

const SEEDS = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x7f4a7c15, 0x2545f491];

function fnv1a(text, seed) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 40 lowercase hex characters derived from `text`; stable across runs and hosts. */
export function sha40(text) {
  let out = "";
  for (const seed of SEEDS) out += fnv1a(text, seed).toString(16).padStart(8, "0");
  return out;
}

export function blobSha(content) {
  return sha40(`blob\0${content}`);
}

/** Tree sha over the sorted "path sha" lines of a flat tree map. */
export function treeSha(tree) {
  const lines = treeEntries(tree)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([path, entry]) => `${path} ${entry.sha}`);
  return sha40(`tree\0${lines.join("\n")}`);
}

export function commitSha(treeShaValue, parents, authorDate, message, sequence) {
  return sha40(`commit\0${treeShaValue}\0${parents.join(",")}\0${authorDate}\0${message}\0${String(sequence)}`);
}

export function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
