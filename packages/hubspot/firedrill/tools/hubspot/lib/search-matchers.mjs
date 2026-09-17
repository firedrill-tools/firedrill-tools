// Linear-time matching primitives for CRM search: KMP substring search for wildcard segments and a bounded
// work budget shared by one search request. Pure functions; no regular expression is built from caller text.

/**
 * Upper bound on matching work for one search request, in character units: every property value folded or
 * tokenised, every token scan of a CONTAINS_TOKEN filter and every free-text lookup is charged. A search that would
 * exceed it fails with VALIDATION_ERROR instead of blocking the server.
 */
export const MAX_MATCH_WORK = 40_000_000;

export function createWorkBudget(limit = MAX_MATCH_WORK) {
  return { limit, remaining: limit, exceeded: false };
}

/** Charge `units` of work; returns false (and marks the budget) once it is exhausted. */
export function charge(budget, units) {
  budget.remaining -= units;
  if (budget.remaining < 0) budget.exceeded = true;
  return !budget.exceeded;
}

function failureTable(pattern) {
  const table = new Int32Array(pattern.length);
  let k = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    const unit = pattern.charCodeAt(index);
    while (k > 0 && unit !== pattern.charCodeAt(k)) k = table[k - 1];
    if (unit === pattern.charCodeAt(k)) k += 1;
    table[index] = k;
  }
  return table;
}

/** First index ≥ `from` where `pattern` occurs entirely before `end`, or -1. Never re-reads text (O(end - from)). */
function kmpIndexOf(text, pattern, table, from, end) {
  let k = 0;
  for (let index = from; index < end; index += 1) {
    const unit = text.charCodeAt(index);
    while (k > 0 && unit !== pattern.charCodeAt(k)) k = table[k - 1];
    if (unit === pattern.charCodeAt(k)) k += 1;
    if (k === pattern.length) return index - pattern.length + 1;
  }
  return -1;
}

/**
 * Compile a CONTAINS_TOKEN value (`*` = any run of characters) into a whole-token matcher over lower-cased tokens.
 * The first and last literal segments are anchored; the middle segments are located left to right with KMP (the
 * leftmost occurrence is always a valid choice for a glob). Each segment search resumes where the previous one
 * ended and KMP never moves backwards in the token, so one call costs O(token length + pattern length).
 */
export function globMatcher(value) {
  const segments = String(value).toLowerCase().split("*");
  if (segments.length === 1) return (token) => token === segments[0];
  const first = segments[0];
  const last = segments[segments.length - 1];
  const middle = segments
    .slice(1, -1)
    .filter((segment) => segment.length > 0)
    .map((segment) => ({ segment, table: failureTable(segment) }));
  const anchored = first.length + last.length + middle.reduce((sum, entry) => sum + entry.segment.length, 0);
  return (token) => {
    if (token.length < anchored || !token.startsWith(first) || !token.endsWith(last)) return false;
    let position = first.length;
    const end = token.length - last.length;
    for (const { segment, table } of middle) {
      const found = kmpIndexOf(token, segment, table, position, end);
      if (found === -1) return false;
      position = found + segment.length;
    }
    return true;
  };
}

/** Index of the first entry of a sorted string array that is ≥ `needle` (code-unit order). */
export function lowerBound(sorted, needle) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < needle) low = middle + 1;
    else high = middle;
  }
  return low;
}
