// LIKE matching with `%` wildcards in time linear in the value length: the pattern is split into
// wildcard-free segments and each segment is located with a Knuth-Morris-Pratt search.

function failureTable(segment) {
  const table = new Array(segment.length).fill(0);
  let k = 0;
  for (let i = 1; i < segment.length; i += 1) {
    while (k > 0 && segment[i] !== segment[k]) k = table[k - 1];
    if (segment[i] === segment[k]) k += 1;
    table[i] = k;
  }
  return table;
}

/** First index >= from where segment occurs in text, or -1. */
function kmpFind(text, segment, from) {
  if (segment.length === 0) return from;
  const table = failureTable(segment);
  let k = 0;
  for (let i = from; i < text.length; i += 1) {
    while (k > 0 && text[i] !== segment[k]) k = table[k - 1];
    if (text[i] === segment[k]) k += 1;
    if (k === segment.length) return i - segment.length + 1;
  }
  return -1;
}

/** Compile a LIKE pattern once (case-folded). */
export function compileLike(pattern) {
  const folded = pattern.toLowerCase();
  const segments = folded.split("%");
  return { segments, anchoredStart: !folded.startsWith("%"), anchoredEnd: !folded.endsWith("%") };
}

export function likeMatches(compiled, value) {
  const text = value.toLowerCase();
  const { segments } = compiled;
  if (segments.length === 1) return text === segments[0];
  const head = segments[0];
  const tail = segments[segments.length - 1];
  if (!text.startsWith(head)) return false;
  let cursor = head.length;
  for (let i = 1; i < segments.length - 1; i += 1) {
    const found = kmpFind(text, segments[i], cursor);
    if (found < 0) return false;
    cursor = found + segments[i].length;
  }
  return text.length - tail.length >= cursor && text.endsWith(tail);
}
