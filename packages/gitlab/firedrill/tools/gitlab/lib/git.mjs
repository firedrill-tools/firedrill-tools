// The synthetic git model. Commit rows carry a full flat tree snapshot (`path → { blob_id, size, content, mode }`), so
// file reads are one lookup and diffs, ancestor walks, merge bases, conflicts and merge trees are pure functions over
// commit rows. Shas are content digests (lib/hash.mjs), not git object ids.
import { byteLength } from "./base64.mjs";
import { blobSha, commitSha, isSha } from "./hash.mjs";
import { branchRowId, commitRowId, fitsRowId, jsonBytes, limit, nullMap, ownValue, projectRowId, tooLarge } from "./ids.mjs";

const MAX_DIFF_CELLS = 4_000_000;
const CONTEXT_LINES = 3;
/** GitLab's `diff_max_patch_bytes` default (200 KiB): a larger patch is returned with an empty `diff` and `too_large`. */
export const MAX_PATCH_BYTES = 204_800;
export const FILE_MODE = "100644";
export const TREE_MODE = "040000";

export function getCommit(context, projectId, sha) {
  if (!isSha(sha)) return null;
  return context.state.get("commits", commitRowId(projectId, sha));
}

export function getBranch(context, projectId, name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return null;
  const rowId = branchRowId(projectId, name);
  return fitsRowId(rowId) ? context.state.get("branches", rowId) : null;
}

/**
 * Resolve a ref (branch name, full sha, or unique short sha of ≥ 7 hex characters) to a commit row.
 * Returns `{ commit }`, `{ commit: null }` when unknown, or `{ ambiguous: true }` for a non-unique short sha.
 */
export function resolveRef(context, projectId, ref) {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 255) return { commit: null };
  const branch = getBranch(context, projectId, ref);
  if (branch !== null) return { commit: getCommit(context, projectId, branch.commit_sha), branch };
  if (isSha(ref)) return { commit: getCommit(context, projectId, ref) };
  if (/^[0-9a-f]{7,39}$/.test(ref)) {
    const prefix = `${projectRowId(projectId)}@${ref}`;
    const rows = context.state.scan("commits", { afterRowId: prefix, limit: 2 }).filter((row) => row.rowId.startsWith(prefix));
    if (rows.length > 1) return { ambiguous: true };
    return { commit: rows.length === 1 ? rows[0].value : null };
  }
  return { commit: null };
}

/** Every ancestor of `sha` (inclusive) keyed by sha; more than the walk bound fails UNPROCESSABLE. */
export function ancestors(context, projectId, sha, firstParentOnly = false) {
  const bound = limit(context, "ancestor_walk");
  const seen = new Map();
  const queue = [sha];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (seen.has(current)) continue;
    const commit = getCommit(context, projectId, current);
    if (commit === null) continue;
    seen.set(current, commit);
    if (seen.size > bound) return tooLarge(context, "ancestor_walk", bound);
    const parents = firstParentOnly ? commit.parent_ids.slice(0, 1) : commit.parent_ids;
    for (const parent of parents) queue.push(parent);
  }
  return seen;
}

/** Nearest common ancestor (highest sequence among shared ancestors), or null for unrelated histories. */
export function mergeBase(leftAncestors, rightAncestors) {
  let best = null;
  for (const commit of leftAncestors.values()) {
    if (rightAncestors.has(commit.id) && (best === null || commit.sequence > best.sequence)) best = commit;
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

/** LCS line operations; whole-file replacement when the table would be too large. */
function lineOps(a, b) {
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return [...a.map((line) => ["-", line]), ...b.map((line) => ["+", line])];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
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
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
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

/** Unified diff hunks (3 lines of context, GitLab's `diff` field starting at `@@`) plus line counts. */
export function unifiedDiff(before, after) {
  const ops = lineOps(splitLines(before), splitLines(after));
  let oldNo = 1;
  let newNo = 1;
  let additions = 0;
  let deletions = 0;
  const lines = ops.map(([kind, text]) => {
    const entry = { kind, text, old: oldNo, new: newNo };
    if (kind !== "+") oldNo += 1;
    if (kind !== "-") newNo += 1;
    if (kind === "+") additions += 1;
    if (kind === "-") deletions += 1;
    return entry;
  });
  if (additions + deletions === 0) return { diff: "", additions, deletions };
  const hunks = [];
  let current = null;
  lines.forEach((entry, index) => {
    if (entry.kind === " ") return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + CONTEXT_LINES);
    if (current !== null && start <= current.end + 1) current.end = Math.max(current.end, end);
    else {
      current = { start, end };
      hunks.push(current);
    }
  });
  const out = [];
  for (const hunk of hunks) {
    const slice = lines.slice(hunk.start, hunk.end + 1);
    const oldCount = slice.filter((entry) => entry.kind !== "+").length;
    const newCount = slice.filter((entry) => entry.kind !== "-").length;
    const oldStart = oldCount === 0 ? slice[0].old - 1 : slice[0].old;
    const newStart = newCount === 0 ? slice[0].new - 1 : slice[0].new;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const entry of slice) out.push(`${entry.kind}${entry.text}`);
  }
  return { diff: `${out.join("\n")}\n`, additions, deletions };
}

/**
 * File-level diff between two tree snapshots (GitLab diff objects, sorted by new path). A deleted and an added path
 * with the same blob are reported as one rename. `withText` adds the unified `diff` body; a patch over MAX_PATCH_BYTES
 * (measured as JSON bytes) is pruned to an empty `diff` with `too_large: true`, like GitLab.
 */
export function diffTrees(before, after, withText) {
  const removed = [];
  const added = [];
  const modified = [];
  for (const path of Object.keys(before)) {
    const now = ownValue(after, path);
    if (now === undefined) removed.push(path);
    else if (now.blob_id !== before[path].blob_id) modified.push(path);
  }
  for (const path of Object.keys(after)) if (ownValue(before, path) === undefined) added.push(path);
  const entries = [];
  const renamedFrom = new Set();
  for (const path of added.sort()) {
    const source = removed.find((candidate) => !renamedFrom.has(candidate) && before[candidate].blob_id === after[path].blob_id);
    if (source !== undefined) {
      renamedFrom.add(source);
      entries.push({ old_path: source, new_path: path, kind: "rename" });
    } else entries.push({ old_path: path, new_path: path, kind: "add" });
  }
  for (const path of removed) if (!renamedFrom.has(path)) entries.push({ old_path: path, new_path: path, kind: "delete" });
  for (const path of modified) entries.push({ old_path: path, new_path: path, kind: "modify" });
  entries.sort((left, right) => (left.new_path < right.new_path ? -1 : left.new_path > right.new_path ? 1 : 0));
  return entries.map(({ old_path, new_path, kind }) => {
    const oldText = kind === "add" ? "" : before[old_path].content;
    const newText = kind === "delete" ? "" : after[new_path].content;
    const { diff, additions, deletions } = unifiedDiff(oldText, newText);
    const entry = {
      old_path,
      new_path,
      a_mode: kind === "add" ? "0" : FILE_MODE,
      b_mode: kind === "delete" ? "0" : FILE_MODE,
      new_file: kind === "add",
      renamed_file: kind === "rename",
      deleted_file: kind === "delete",
      additions,
      deletions,
    };
    if (withText) {
      if (jsonBytes(diff) > MAX_PATCH_BYTES) {
        entry.diff = "";
        entry.too_large = true;
      } else entry.diff = diff;
    }
    return entry;
  });
}

export function statsOf(diffs) {
  let additions = 0;
  let deletions = 0;
  for (const entry of diffs) {
    additions += entry.additions;
    deletions += entry.deletions;
  }
  return { additions, deletions, total: additions + deletions };
}

/** Paths whose content differs between two trees. */
export function changedPaths(before, after) {
  const paths = new Set();
  for (const path of Object.keys(before)) if (ownValue(after, path)?.blob_id !== before[path].blob_id) paths.add(path);
  for (const path of Object.keys(after)) if (ownValue(before, path) === undefined) paths.add(path);
  return paths;
}

/** Apply the path-level changes between `from` and `to` onto `target` (three-way merge tree). */
export function applyChanges(target, from, to) {
  const next = nullMap(target);
  for (const path of changedPaths(from, to)) {
    const entry = ownValue(to, path);
    if (entry === undefined) delete next[path];
    else next[path] = entry;
  }
  return next;
}

/** Paths changed on both sides since the merge base with different results. */
export function conflictingPaths(baseTree, leftTree, rightTree) {
  const right = changedPaths(baseTree, rightTree);
  const conflicts = [];
  for (const path of changedPaths(baseTree, leftTree)) {
    if (right.has(path) && ownValue(leftTree, path)?.blob_id !== ownValue(rightTree, path)?.blob_id) conflicts.push(path);
  }
  return conflicts;
}

export function treeEntry(content) {
  return { blob_id: blobSha(content), size: byteLength(content), content, mode: FILE_MODE };
}

/**
 * Build (not store) a commit row. `diffs` and `stats` are computed against the first parent; the id is salted with
 * the commit sequence so identical content never collides.
 */
export function buildCommit(context, projectId, options) {
  const { tree, parents, message, authorName, authorEmail, date, sequence } = options;
  const parentTree = parents.length > 0 ? (getCommit(context, projectId, parents[0])?.tree ?? {}) : {};
  const diffs = diffTrees(parentTree, tree, false);
  const id = commitSha(tree, parents, date, message, sequence);
  return {
    project_id: projectId,
    id,
    short_id: id.slice(0, 8),
    title: message.split("\n")[0],
    message,
    author_name: authorName,
    author_email: authorEmail,
    authored_date: date,
    committer_name: authorName,
    committer_email: authorEmail,
    committed_date: date,
    parent_ids: [...parents],
    tree: sortedTree(tree),
    diffs,
    stats: statsOf(diffs),
    sequence,
  };
}

function sortedTree(tree) {
  const out = {};
  for (const path of Object.keys(tree).sort()) {
    Object.defineProperty(out, path, { value: tree[path], enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Newest first: committed date desc, then sequence desc. */
export function compareNewest(left, right) {
  if (left.committed_date !== right.committed_date) return left.committed_date < right.committed_date ? 1 : -1;
  return right.sequence - left.sequence;
}

/** The newest commit reachable from `headSha` that changed `path` (GitLab `last_commit_id`), or null. */
export function lastCommitFor(context, projectId, headSha, path) {
  const history = [...ancestors(context, projectId, headSha).values()].sort((left, right) => right.sequence - left.sequence);
  for (const commit of history) {
    const entry = ownValue(commit.tree, path);
    const parent = commit.parent_ids.length > 0 ? getCommit(context, projectId, commit.parent_ids[0]) : null;
    const before = parent === null ? undefined : ownValue(parent.tree, path);
    if (entry?.blob_id !== before?.blob_id) return entry === undefined ? null : commit.id;
  }
  return null;
}

/** Tree listing entries under `path` (GitLab `repository/tree`): directories first, then files, each by name. */
export function treeEntries(tree, path, recursive) {
  const prefix = path.length === 0 ? "" : `${path}/`;
  const directories = new Map();
  const files = [];
  for (const filePath of Object.keys(tree)) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const parts = rest.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) {
      if (!recursive && depth > 1) break;
      const dirPath = prefix + parts.slice(0, depth).join("/");
      const lines = directories.get(dirPath) ?? [];
      lines.push(`${filePath} ${tree[filePath].blob_id}`);
      directories.set(dirPath, lines);
    }
    if (recursive || parts.length === 1) files.push(filePath);
  }
  const entries = [];
  for (const dirPath of [...directories.keys()].sort()) {
    entries.push({ path: dirPath, type: "tree", mode: TREE_MODE, lines: directories.get(dirPath) });
  }
  for (const filePath of files.sort()) entries.push({ path: filePath, type: "blob", mode: FILE_MODE, blob_id: tree[filePath].blob_id });
  return entries;
}

/**
 * Recompute an open merge request's graph-derived fields from the current branch heads: `sha`, `diff_refs`,
 * `commit_shas`, `has_conflicts` and `detailed_merge_status`. Closed and merged requests keep their stored values.
 */
export function refreshMergeRequest(context, project, mergeRequest) {
  const next = { ...mergeRequest };
  if (next.state !== "opened") {
    next.detailed_merge_status = "not_open";
    return next;
  }
  const source = getBranch(context, project.id, next.source_branch);
  const target = getBranch(context, project.id, next.target_branch);
  if (source === null || target === null) {
    next.has_conflicts = false;
    next.detailed_merge_status = "commits_status";
    return next;
  }
  const sourceAncestors = ancestors(context, project.id, source.commit_sha);
  const targetAncestors = ancestors(context, project.id, target.commit_sha);
  const base = mergeBase(sourceAncestors, targetAncestors);
  const commits = [...sourceAncestors.values()].filter((commit) => !targetAncestors.has(commit.id)).sort((left, right) => left.sequence - right.sequence);
  const maxCommits = 1_000;
  if (commits.length > maxCommits) return tooLarge(context, "ancestor_walk", maxCommits);
  next.sha = source.commit_sha;
  next.commit_shas = commits.map((commit) => commit.id);
  next.diff_refs = { base_sha: base === null ? target.commit_sha : base.id, head_sha: source.commit_sha, start_sha: target.commit_sha };
  const sourceHead = sourceAncestors.get(source.commit_sha);
  const targetHead = targetAncestors.get(target.commit_sha);
  next.has_conflicts = base === null || conflictingPaths(base.tree, sourceHead.tree, targetHead.tree).length > 0;
  if (next.draft) next.detailed_merge_status = "draft_status";
  else if (next.has_conflicts) next.detailed_merge_status = "conflict";
  else if (project.merge_method === "ff" && !sourceAncestors.has(target.commit_sha)) next.detailed_merge_status = "need_rebase";
  else next.detailed_merge_status = "mergeable";
  return next;
}
