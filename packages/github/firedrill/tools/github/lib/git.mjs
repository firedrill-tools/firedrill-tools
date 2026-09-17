// The synthetic git model: commits carry a full flat tree snapshot, so contents are one lookup and diffs,
// ancestor walks, merge bases, mergeability and merge trees are pure functions over commit rows.
import { blobSha, commitSha, treeSha } from "./hash.mjs";
import { ANCESTOR_CAP, commitRowId, fitsRowId, nullMap, ownValue, tooLarge } from "./ids.mjs";
import { byteLength } from "./base64.mjs";
import { treeDelete, treeGet, treePaths, treeSet } from "./tree.mjs";

export const MAX_FILE_BYTES = 65_536;
export const MAX_TREE_ENTRIES = 200;
const MAX_DIFF_LINES = 400;

export function getCommit(context, key, sha) {
  if (typeof sha !== "string" || sha.length === 0) return null;
  const rowId = commitRowId(key, sha);
  return fitsRowId(rowId) ? context.state.get("commits", rowId) : null;
}

/** Newest-first ordering used by list-commits: author date desc, then sequence desc. */
export function compareNewest(left, right) {
  if (left.author.date !== right.author.date) return left.author.date < right.author.date ? 1 : -1;
  return right.sequence - left.sequence;
}

/** Every ancestor of `sha` (inclusive) keyed by sha; fails beyond ANCESTOR_CAP commits. */
export function ancestors(context, key, sha) {
  const seen = new Map();
  const queue = [sha];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    const commit = getCommit(context, key, current);
    if (commit === null) continue;
    seen.set(current, commit);
    if (seen.size > ANCESTOR_CAP) return tooLarge(context);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/** Commits reachable from `head` but not from `base`, oldest first. */
export function commitsBetween(context, key, baseSha, headSha) {
  const baseSet = ancestors(context, key, baseSha);
  const headSet = ancestors(context, key, headSha);
  return [...headSet.values()].filter((commit) => !baseSet.has(commit.sha)).sort((a, b) => -compareNewest(a, b));
}

/** Nearest common ancestor (highest sequence among shared ancestors), or null for unrelated histories. */
export function mergeBase(context, key, leftSha, rightSha) {
  const left = ancestors(context, key, leftSha);
  const right = ancestors(context, key, rightSha);
  let best = null;
  for (const commit of left.values()) {
    if (right.has(commit.sha) && (best === null || commit.sequence > best.sequence)) best = commit;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Line diffs
// ---------------------------------------------------------------------------------------------

function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Longest-common-subsequence line diff; falls back to whole-file replacement for very large inputs. */
function lineDiff(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return [...a.map((line) => ["-", line]), ...b.map((line) => ["+", line])];
  }
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push([" ", a[i]]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push(["-", a[i]]);
      i += 1;
    } else {
      ops.push(["+", b[j]]);
      j += 1;
    }
  }
  while (i < a.length) ops.push(["-", a[i++]]);
  while (j < b.length) ops.push(["+", b[j++]]);
  return ops;
}

/** A minimal unified-diff body (hunk lines only, as GitHub's `patch` field) with counts. */
function patchFor(before, after) {
  const ops = lineDiff(before, after);
  let additions = 0;
  let deletions = 0;
  for (const [kind] of ops) {
    if (kind === "+") additions += 1;
    else if (kind === "-") deletions += 1;
  }
  const oldCount = ops.filter(([kind]) => kind !== "+").length;
  const newCount = ops.filter(([kind]) => kind !== "-").length;
  const header = `@@ -${oldCount === 0 ? "0,0" : `1,${oldCount}`} +${newCount === 0 ? "0,0" : `1,${newCount}`} @@`;
  const body = ops.map(([kind, line]) => `${kind}${line}`).join("\n");
  return { additions, deletions, patch: additions + deletions === 0 ? "" : `${header}\n${body}` };
}

/** File-level diff between two tree snapshots, sorted by filename. */
export function diffTrees(before, after) {
  const paths = [...new Set([...treePaths(before), ...treePaths(after)])].sort();
  const files = [];
  for (const path of paths) {
    const old = treeGet(before, path);
    const now = treeGet(after, path);
    if (old !== undefined && now !== undefined && old.sha === now.sha) continue;
    const status = old === undefined ? "added" : now === undefined ? "removed" : "modified";
    const { additions, deletions, patch } = patchFor(old?.content ?? "", now?.content ?? "");
    files.push({
      sha: now?.sha ?? old.sha,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      patch,
    });
  }
  return files;
}

export function changedPaths(before, after) {
  return new Set(diffTrees(before, after).map((file) => file.filename));
}

/** Apply the changes between `from` and `to` onto `target` (three-way, path-level). */
export function applyChanges(target, from, to) {
  const next = nullMap(target);
  for (const path of changedPaths(from, to)) {
    const entry = treeGet(to, path);
    if (entry === undefined) treeDelete(next, path);
    else treeSet(next, path, entry);
  }
  return next;
}

export function treeEntry(content) {
  return { sha: blobSha(content), size: byteLength(content), content };
}

export function statsOf(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions, total: additions + deletions };
}

/**
 * Build (but do not store) a commit row from a tree and parents. `files`/`stats` are computed against the
 * first parent; the sha is salted with the commit sequence so identical content never collides.
 */
export function buildCommit(context, key, options) {
  const { tree, parents, message, author, committer, date, sequence } = options;
  const parentTree = parents.length > 0 ? (getCommit(context, key, parents[0])?.tree ?? {}) : {};
  const files = diffTrees(parentTree, tree).map(({ patch: _patch, ...file }) => file);
  const tree_sha = treeSha(tree);
  const sha = commitSha(tree_sha, parents, date, message, sequence);
  return {
    repo: key,
    sha,
    node_id: `C_synthetic_${sha.slice(0, 12)}`,
    message,
    author: { ...author, date },
    committer: { ...committer, date },
    parents: [...parents],
    tree_sha,
    tree,
    files,
    stats: statsOf(files),
    sequence,
  };
}

/** Pull-request mergeability: no path changed on both sides since the merge base. */
export function mergeability(context, key, baseSha, headSha) {
  const base = mergeBase(context, key, baseSha, headSha);
  const head = getCommit(context, key, headSha);
  const baseCommit = getCommit(context, key, baseSha);
  if (base === null || head === null || baseCommit === null) return { mergeable: false, base: null, files: [] };
  const headChanges = changedPaths(base.tree, head.tree);
  const baseChanges = changedPaths(base.tree, baseCommit.tree);
  let conflict = false;
  for (const path of headChanges) if (baseChanges.has(path)) conflict = true;
  return { mergeable: !conflict, base, files: diffTrees(base.tree, head.tree) };
}
