// Synthetic GitHub instance. Every operation computes from context.state; ids come from the `meta` counters,
// shas from content hashes salted by the commit sequence, timestamps from the virtual clock. Nothing leaves
// the world and no GitHub service is ever contacted.
import {
  association,
  atLeast,
  findUser,
  isAssignable,
  permissionOf,
  requirePush,
  requireTriage,
  requireUser,
  requireWritable,
  visibleRepo,
  visibleRepos,
} from "./lib/access.mjs";
import { base64Decode, base64Encode, base64UrlDecode, base64UrlEncode, byteLength } from "./lib/base64.mjs";
import {
  MAX_FILE_BYTES,
  MAX_TREE_ENTRIES,
  ancestors,
  applyChanges,
  buildCommit,
  commitsBetween,
  compareNewest,
  getCommit,
  mergeability,
  statsOf,
  treeEntry,
} from "./lib/git.mjs";
import { RESPONSE_BUDGET, fitPatch, jsonBytes, pageByBytes, takeByBytes } from "./lib/budget.mjs";
import { isSha } from "./lib/hash.mjs";
import { assertJsonDepth } from "./lib/json-depth.mjs";
import {
  allRows,
  branchRowId,
  commentRowId,
  commitRowId,
  compareStrings,
  counters,
  fail,
  fitsRowId,
  isoNow,
  issueRowId,
  labelRowId,
  nullMap,
  ownValue,
  parseDate,
  prefixRows,
  timestampMs,
  reviewRowId,
  saveCounters,
} from "./lib/ids.mjs";
import { SearchError, parseQuery, scoreCandidate } from "./lib/search.mjs";
import {
  branchFullView,
  branchShortView,
  commentView,
  commitView,
  contentFileView,
  diffEntryView,
  directoryEntries,
  gitRefView,
  issueView,
  labelView,
  privateUser,
  pullView,
  repoView,
  reviewView,
} from "./lib/views.mjs";
import {
  bool,
  defined,
  githubError,
  isRateLimited,
  joinSegments,
  jsonBody,
  linkHeader,
  operationInput,
  pagination,
  pathNumber,
  rateLimitHeaders,
  str,
} from "./lib/wire.mjs";
import { treeGet, treePaths, treeSet, treeSize } from "./lib/tree.mjs";

const MAX_TITLE = 256;
const MAX_BODY = 65_536;
const MAX_ASSIGNEES = 10;
const MAX_LABELS = 100;
const MAX_PULL_COMMITS = 1_000; // equals the ancestor-walk bound; beyond it reads fail instead of truncating
const MAX_PULL_FILES = 1_000;
const BRANCH_NAME = /^[^\s~^:?*[\\]{1,255}$/;
const PATH_SEGMENT = /^[^/\0]+$/;
// Caller-keyed lookup tables: frozen null-prototype maps read with ownValue, never `table[callerValue]`.
const ORDER_BY = Object.freeze(Object.assign(Object.create(null), { CREATED_AT: "created", UPDATED_AT: "updated", COMMENTS: "comments" }));
const REVIEW_STATES = Object.freeze(Object.assign(Object.create(null), { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }));

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

function invalid(context, message, errors) {
  return fail(context, "VALIDATION_FAILED", message, errors === undefined ? undefined : { errors });
}

/**
 * The framework decodes query strings leniently, so malformed percent-encoding (`%E0%A4%A`) reaches a handler as
 * U+FFFD. A filter or query-language value holding U+FFFD is a mangled request: answer 422 instead of running a
 * search that silently matches nothing. A correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same way.
 */
function mangledField(input, fields) {
  for (const field of fields) {
    const value = input[field];
    const values = Array.isArray(value) ? value : [value];
    if (values.some((entry) => typeof entry === "string" && entry.includes("\uFFFD"))) return field;
  }
  return undefined;
}

function rejectMangled(context, input, resource, fields, wireName = (field) => field) {
  const field = mangledField(input, fields);
  if (field === undefined) return undefined;
  return invalid(context, "Validation Failed", [{ resource, field: wireName(field), code: "invalid", message: "The value contains an invalid character (U+FFFD); check the percent-encoding" }]);
}

function notFound(context, message = "Not Found") {
  return fail(context, "NOT_FOUND", message);
}

function open(context, input) {
  const user = requireUser(context);
  const { repo, permission } = visibleRepo(context, user, input.owner, input.repo);
  return { user, repo, permission };
}

function saveRepo(context, repo) {
  const { key: _key, ...row } = repo;
  context.state.put("repos", repo.key, row);
}

function touchRepo(context, repo, now, pushed) {
  repo.updated_at = now;
  if (pushed) repo.pushed_at = now;
  saveRepo(context, repo);
}

function repoIssues(context, repo) {
  return prefixRows(context, "issues", `${repo.key}#`);
}

function repoPulls(context, repo) {
  return prefixRows(context, "pulls", `${repo.key}#`);
}

function repoBranches(context, repo) {
  return prefixRows(context, "branches", `${repo.key}:`);
}

function repoLabels(context, repo) {
  return prefixRows(context, "labels", `${repo.key}:`);
}

function getBranch(context, repo, name) {
  if (typeof name !== "string" || name.length === 0) return null;
  const rowId = branchRowId(repo.key, name);
  return fitsRowId(rowId) ? context.state.get("branches", rowId) : null;
}

function getIssue(context, repo, number) {
  return context.state.get("issues", issueRowId(repo.key, number));
}

function getPull(context, repo, number) {
  return context.state.get("pulls", issueRowId(repo.key, number));
}

/** An issue or a pull request by shared number. */
function getThread(context, repo, number) {
  const issue = getIssue(context, repo, number);
  if (issue !== null) return { kind: "issue", row: issue };
  const pull = getPull(context, repo, number);
  if (pull !== null) return { kind: "pr", row: pull };
  return notFound(context);
}

function saveThread(context, repo, thread) {
  context.state.put(thread.kind === "issue" ? "issues" : "pulls", issueRowId(repo.key, thread.row.number), thread.row);
}

/** Resolve a branch name or commit sha to a commit row (null when unknown). */
function resolveRef(context, repo, ref) {
  if (typeof ref !== "string" || ref.length === 0) return null;
  const branch = getBranch(context, repo, ref);
  if (branch !== null) return getCommit(context, repo.key, branch.sha);
  return getCommit(context, repo.key, ref);
}

function identity(user) {
  return { name: user.name, email: user.email ?? `${user.login}@users.noreply.example.test`, login: user.login };
}

function nextId(context) {
  const meta = counters(context);
  const id = meta.next_id;
  meta.next_id += 1;
  saveCounters(context, meta);
  return id;
}

function nextCommentId(context) {
  const meta = counters(context);
  const id = meta.next_comment_id;
  meta.next_comment_id += 1;
  saveCounters(context, meta);
  return id;
}

function nextReviewId(context) {
  const meta = counters(context);
  const id = meta.next_review_id;
  meta.next_review_id += 1;
  saveCounters(context, meta);
  return id;
}

function nextSequence(context) {
  const meta = counters(context);
  const sequence = meta.commit_sequence;
  meta.commit_sequence += 1;
  saveCounters(context, meta);
  return sequence;
}

function storeCommit(context, repo, commit) {
  context.state.put("commits", commitRowId(repo.key, commit.sha), commit);
}

function requireTitle(context, title) {
  if (typeof title !== "string" || title.trim().length === 0) {
    return invalid(context, "Validation Failed", [{ resource: "Issue", field: "title", code: "missing_field" }]);
  }
  if (title.length > MAX_TITLE) {
    return invalid(context, "Validation Failed", [{ resource: "Issue", field: "title", code: "invalid" }]);
  }
  return title;
}

function requireBody(context, body) {
  if (typeof body !== "string") return "";
  if (body.length > MAX_BODY) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "body", code: "invalid" }]);
  return body;
}

/** Resolve label names to stored labels, auto-creating unknown ones for triage and above. */
function resolveLabels(context, repo, permission, names) {
  const seen = new Set();
  const resolved = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (name.length === 0 || name.length > 50) {
      return invalid(context, "Validation Failed", [{ resource: "Label", field: "name", code: "invalid", value: name }]);
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const existing = context.state.get("labels", labelRowId(repo.key, name));
    if (existing !== null) {
      resolved.push(existing.name);
      continue;
    }
    if (!atLeast(permission, "triage")) {
      return invalid(context, "Validation Failed", [{ resource: "Label", field: "name", code: "invalid", value: name }]);
    }
    if (repoLabels(context, repo).length >= 500) return invalid(context, "Repository is too large for this Tool");
    const id = nextId(context);
    context.state.put("labels", labelRowId(repo.key, name), {
      repo: repo.key,
      id,
      node_id: `LA_synthetic_${id}`,
      name,
      color: "ededed",
      description: "",
      default: false,
    });
    resolved.push(name);
  }
  if (resolved.length > MAX_LABELS) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "labels", code: "invalid" }]);
  return resolved;
}

function resolveAssignees(context, repo, logins, existing = []) {
  const result = [...existing];
  for (const raw of logins) {
    const login = String(raw);
    if (!isAssignable(context, repo, login)) {
      return invalid(context, "Validation Failed", [{ resource: "Issue", field: "assignees", code: "invalid", value: login }]);
    }
    const user = findUser(context, login);
    if (!result.some((item) => item.toLowerCase() === login.toLowerCase())) result.push(user.login);
  }
  if (result.length > MAX_ASSIGNEES) {
    return invalid(context, "Validation Failed", [{ resource: "Issue", field: "assignees", code: "invalid" }]);
  }
  return result;
}

function normalizePath(context, path) {
  const raw = typeof path === "string" ? path : "";
  const parts = raw.split("/").filter((segment) => segment.length > 0);
  for (const segment of parts) {
    if (segment === "." || segment === ".." || !PATH_SEGMENT.test(segment)) return invalid(context, "Validation Failed", [{ resource: "Contents", field: "path", code: "invalid" }]);
  }
  return parts.join("/");
}

function emitIssue(context, repo, row, action, sender, extra = {}) {
  context.events.emit("issues.changed", {
    action,
    repository: repo.full_name,
    number: row.number,
    sender,
    state: row.state,
    ...extra,
  });
}

function emitPull(context, repo, row, action, sender, extra = {}) {
  context.events.emit("pull-request.changed", {
    action,
    repository: repo.full_name,
    number: row.number,
    sender,
    merged: row.merged,
    ...extra,
  });
}

// ---------------------------------------------------------------------------------------------
// Pull-request computation (commits, files, mergeability, branch protection)
// ---------------------------------------------------------------------------------------------

/** Latest review per reviewer (excluding the author) from users with push access. */
function countingReviews(context, repo, pull) {
  const latest = new Map();
  for (const review of prefixRows(context, "reviews", `${repo.key}#${String(pull.number).padStart(5, "0")}:`)) {
    if (review.user.toLowerCase() === pull.user.toLowerCase()) continue;
    if (!atLeast(permissionOf(context, repo, review.user), "write")) continue;
    latest.set(review.user.toLowerCase(), review);
  }
  return [...latest.values()];
}

function protectionSatisfied(context, repo, pull) {
  const branch = getBranch(context, repo, pull.base.ref);
  const protection = branch?.protection ?? null;
  if (protection === null || protection.required_approving_review_count === 0) return true;
  const reviews = countingReviews(context, repo, pull);
  if (reviews.some((review) => review.state === "CHANGES_REQUESTED")) return false;
  const approvals = reviews.filter(
    (review) => review.state === "APPROVED" && (!protection.dismiss_stale_reviews || review.commit_id === pull.head.sha),
  ).length;
  return approvals >= protection.required_approving_review_count;
}

/** Recompute head/base shas, commits, files and mergeability of an open, unmerged pull (returns a copy). */
function refreshPull(context, repo, pull) {
  const next = { ...pull, head: { ...pull.head }, base: { ...pull.base } };
  const head = getBranch(context, repo, next.head.ref);
  const base = getBranch(context, repo, next.base.ref);
  if (head !== null) next.head.sha = head.sha;
  if (base !== null) next.base.sha = base.sha;
  const commits = commitsBetween(context, repo.key, next.base.sha, next.head.sha);
  if (commits.length > MAX_PULL_COMMITS) return invalid(context, `Pull request exceeds the supported bound of ${MAX_PULL_COMMITS} commits`);
  next.commit_shas = commits.map((commit) => commit.sha);
  next.commits = commits.length;
  const result = mergeability(context, repo.key, next.base.sha, next.head.sha);
  if (result.files.length > MAX_PULL_FILES) return invalid(context, `Pull request exceeds the supported bound of ${MAX_PULL_FILES} changed files`);
  next.files = result.files.map(({ patch: _patch, ...file }) => file);
  const stats = statsOf(next.files);
  next.additions = stats.additions;
  next.deletions = stats.deletions;
  next.changed_files = next.files.length;
  next.mergeable = result.mergeable;
  next.rebaseable = result.mergeable;
  next.mergeable_state = !result.mergeable
    ? "dirty"
    : next.draft
      ? "draft"
      : protectionSatisfied(context, repo, next)
        ? "clean"
        : "blocked";
  return next;
}

function savePull(context, repo, pull) {
  context.state.put("pulls", issueRowId(repo.key, pull.number), pull);
}

/** Refresh every open pull that references `branchName` as head or base (after a push or merge). */
function refreshPullsOnBranch(context, repo, branchName) {
  for (const pull of repoPulls(context, repo)) {
    if (pull.state !== "open" || pull.merged) continue;
    if (pull.head.ref !== branchName && pull.base.ref !== branchName) continue;
    savePull(context, repo, refreshPull(context, repo, pull));
  }
}

function requirePullOpen(context, pull) {
  if (pull.merged) return invalid(context, "Cannot change the state of a merged pull request");
  if (pull.state !== "open") return invalid(context, "Pull request is closed");
}

function resolveReviewers(context, repo, pull, logins) {
  const result = [];
  for (const raw of logins) {
    const login = String(raw);
    if (login.toLowerCase() === pull.user.toLowerCase()) return invalid(context, "Review cannot be requested from pull request author.");
    if (!isAssignable(context, repo, login)) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "reviewers", code: "invalid", value: login }]);
    }
    const user = findUser(context, login);
    if (!result.includes(user.login)) result.push(user.login);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Listing helpers
// ---------------------------------------------------------------------------------------------

/**
 * One page of `items` sized by count and UTF-8 bytes (lib/budget.mjs). `resource` names the GitHub resource in
 * the 422 raised when a single item cannot fit a response on its own (reachable only where the operation declares
 * VALIDATION_FAILED; other lists hold items far below the budget by their schema bounds).
 */
function pageOf(context, items, input, viewOf, resource, reserved = 0) {
  const page = pageByBytes(items, input.page, input.perPage, viewOf, { reserved });
  if (page.tooLarge !== undefined) {
    return invalid(context, "Validation Failed", [{ resource, field: "per_page", code: "too_large", message: "This item is too large to return in one response" }]);
  }
  return page;
}

function sortBy(items, sort, direction) {
  const desc = direction === "desc";
  const key = (item) => (sort === "comments" ? item.comments : sort === "updated" ? item.updated_at : item.created_at);
  return [...items].sort((left, right) => {
    const a = key(left);
    const b = key(right);
    const order = typeof a === "number" ? a - b : compareStrings(a, b);
    if (order !== 0) return desc ? -order : order;
    return desc ? right.number - left.number : left.number - right.number;
  });
}

function stateFilter(context, value, fallback = "open") {
  if (value === undefined) return fallback;
  const lower = String(value).toLowerCase();
  if (lower === "open" || lower === "closed" || lower === "all") return lower;
  return invalid(context, "Validation Failed", [{ resource: "Issue", field: "state", code: "invalid" }]);
}

function directionOf(context, value, fallback) {
  if (value === undefined) return fallback;
  const lower = String(value).toLowerCase();
  if (lower === "asc" || lower === "desc") return lower;
  return invalid(context, "Validation Failed", [{ resource: "Issue", field: "direction", code: "invalid" }]);
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

const operations = {
  "users.get-authenticated": (input, context) => {
    const user = requireUser(context);
    const repos = allRows(context, "repos");
    const visible = visibleRepos(context, user, repos);
    const privateRepos = visible.filter((entry) => entry.repo.private).length;
    const ownedPrivateRepos = visible.filter((entry) => entry.repo.private && entry.repo.owner.toLowerCase() === user.login.toLowerCase()).length;
    const collaborators = new Set();
    for (const entry of visible) {
      for (const row of prefixRows(context, "collaborators", `${entry.repo.key}:`)) collaborators.add(row.login.toLowerCase());
    }
    collaborators.delete(user.login.toLowerCase());
    // `server_time` (world virtual time) is a Tool extension for clients such as the app; GET /user omits it.
    return { ...privateUser(user, { privateRepos, ownedPrivateRepos, collaborators: collaborators.size }), server_time: isoNow(context) };
  },

  "repos.list-for-authenticated-user": (input, context) => {
    const user = requireUser(context);
    if (input.type !== undefined && (input.visibility !== undefined || input.affiliation !== undefined)) {
      return invalid(context, "If you specify visibility or affiliation, you cannot specify type.");
    }
    const affiliations = new Set(["owner", "collaborator", "organization_member"]);
    if (input.affiliation !== undefined) {
      affiliations.clear();
      for (const raw of String(input.affiliation).split(",")) {
        const value = raw.trim();
        if (!["owner", "collaborator", "organization_member"].includes(value)) {
          return invalid(context, "Validation Failed", [{ resource: "Repository", field: "affiliation", code: "invalid", value }]);
        }
        affiliations.add(value);
      }
    }
    let visibility = input.visibility ?? "all";
    let type = input.type ?? "all";
    if (type === "public" || type === "private") {
      visibility = type;
      type = "all";
    }
    const login = user.login.toLowerCase();
    const entries = visibleRepos(context, user, allRows(context, "repos")).filter(({ repo, permission }) => {
      if (visibility === "public" && repo.private) return false;
      if (visibility === "private" && !repo.private) return false;
      const owner = context.state.get("users", repo.owner.toLowerCase());
      const isOwner = repo.owner.toLowerCase() === login;
      const orgMember = !isOwner && permission !== null && owner?.type === "Organization";
      const collaborator = !isOwner && permission !== null && owner?.type !== "Organization";
      if (type === "owner") return isOwner;
      if (type === "member") return orgMember || collaborator;
      return (isOwner && affiliations.has("owner")) || (collaborator && affiliations.has("collaborator")) || (orgMember && affiliations.has("organization_member"));
    });
    const sort = input.sort ?? "full_name";
    const direction = input.direction ?? (sort === "full_name" ? "asc" : "desc");
    const key = (repo) => (sort === "full_name" ? repo.full_name.toLowerCase() : sort === "created" ? repo.created_at : sort === "pushed" ? repo.pushed_at : repo.updated_at);
    entries.sort((left, right) => {
      const order = compareStrings(key(left.repo), key(right.repo)) || compareStrings(left.repo.key, right.repo.key);
      return direction === "desc" ? -order : order;
    });
    const page = pageOf(context, entries, input, ({ repo, permission }) => repoView(context, repo, { permission: permission ?? "read" }), "Repository");
    return { repositories: page.items, total_count: page.total, total_pages: page.pages };
  },

  "repos.get": (input, context) => {
    const { repo, permission } = open(context, input);
    return repoView(context, repo, { permission: permission ?? "read" });
  },

  "repos.list-branches": (input, context) => {
    const { repo } = open(context, input);
    const branches = repoBranches(context, repo)
      .filter((branch) => input.protected === undefined || branch.protected === input.protected)
      .sort((left, right) => compareStrings(left.name, right.name));
    const page = pageOf(context, branches, input, (branch) => branchShortView(repo, branch), "Branch");
    return { branches: page.items, total_count: page.total, total_pages: page.pages };
  },

  "repos.get-branch": (input, context) => {
    const { repo } = open(context, input);
    const branch = getBranch(context, repo, input.branch);
    if (branch === null) return notFound(context, "Branch not found");
    const commit = getCommit(context, repo.key, branch.sha);
    if (commit === null) return notFound(context, "Branch not found");
    return branchFullView(context, repo, branch, commit);
  },

  "repos.create-branch": (input, context) => {
    const { repo, permission } = open(context, input);
    requireWritable(context, repo);
    requirePush(context, permission);
    const name = String(input.branch);
    if (!BRANCH_NAME.test(name) || name.startsWith("-") || name.includes("..") || name.endsWith("/") || name.endsWith(".lock") || name.startsWith("/") || name.includes("//") || name.includes("@{")) {
      return invalid(context, "Validation Failed", [{ resource: "Reference", field: "ref", code: "invalid" }]);
    }
    if (getBranch(context, repo, name) !== null) return invalid(context, "Reference already exists");
    let sha;
    if (input.sha !== undefined) {
      if (getCommit(context, repo.key, input.sha) === null) return invalid(context, "Object does not exist");
      sha = input.sha;
    } else {
      const source = getBranch(context, repo, input.from_branch ?? repo.default_branch);
      if (source === null) return invalid(context, "Object does not exist");
      sha = source.sha;
    }
    if (repoBranches(context, repo).length >= 1_000) return invalid(context, "Repository is too large for this Tool");
    const now = isoNow(context);
    const branch = { repo: repo.key, name, sha, protected: false, protection: null, created_at: now, updated_at: now };
    context.state.put("branches", branchRowId(repo.key, name), branch);
    touchRepo(context, repo, now, true);
    return gitRefView(repo, branch);
  },

  "repos.list-commits": (input, context) => {
    const { repo } = open(context, input);
    const mangledCommits = rejectMangled(context, input, "Commit", ["path", "author", "sha", "since", "until"]);
    if (mangledCommits !== undefined) return mangledCommits;
    const ref = input.sha ?? repo.default_branch;
    const start = resolveRef(context, repo, ref);
    if (start === null) return notFound(context, `No commit found for SHA: ${ref}`);
    const since = input.since === undefined ? undefined : parseDate(input.since);
    const until = input.until === undefined ? undefined : parseDate(input.until);
    if ((input.since !== undefined && since === undefined) || (input.until !== undefined && until === undefined)) {
      return invalid(context, "Validation Failed", [{ resource: "Commit", field: input.since !== undefined && since === undefined ? "since" : "until", code: "invalid" }]);
    }
    const path = input.path === undefined ? undefined : normalizePath(context, input.path);
    const author = input.author === undefined ? undefined : String(input.author).toLowerCase();
    let commits = [...ancestors(context, repo.key, start.sha).values()];
    if (path !== undefined && path.length > 0) {
      commits = commits.filter((commit) =>
        commit.parents.length === 0
          ? treePaths(commit.tree).some((entry) => entry === path || entry.startsWith(`${path}/`))
          : commit.files.some((file) => file.filename === path || file.filename.startsWith(`${path}/`)),
      );
    }
    if (author !== undefined) {
      commits = commits.filter((commit) => (commit.author.login ?? "").toLowerCase() === author || commit.author.email.toLowerCase() === author);
    }
    if (since !== undefined) commits = commits.filter((commit) => timestampMs(commit.author.date) >= since);
    if (until !== undefined) commits = commits.filter((commit) => timestampMs(commit.author.date) <= until);
    commits.sort(compareNewest);
    const page = pageOf(context, commits, input, (commit) => commitView(context, repo, commit), "Commit");
    return { commits: page.items, total_count: page.total, total_pages: page.pages };
  },

  "repos.get-commit": (input, context) => {
    const { repo } = open(context, input);
    const commit = resolveRef(context, repo, input.sha);
    if (commit === null) return notFound(context, `No commit found for SHA: ${String(input.sha)}`);
    return commitView(context, repo, commit, { full: true, detail: input.detail, page: input.page, perPage: input.perPage });
  },

  "repos.get-content": (input, context) => {
    const { repo } = open(context, input);
    const path = normalizePath(context, input.path);
    if (input.ref !== undefined && input.sha !== undefined && input.ref !== input.sha) {
      return invalid(context, "Validation Failed", [{ resource: "Contents", field: "ref", code: "invalid" }]);
    }
    const ref = input.ref ?? input.sha ?? repo.default_branch;
    const commit = resolveRef(context, repo, ref);
    if (commit === null) return notFound(context, "No commit found for the ref " + String(ref));
    const file = treeGet(commit.tree, path);
    // Contents responses are not paginated by GitHub; one that cannot fit a response answers 422 too_large.
    const tooLargeContent = () => invalid(context, "Validation Failed", [{ resource: "Contents", field: "path", code: "too_large", message: "This content is too large to return with the contents API" }]);
    if (path.length > 0 && file !== undefined) {
      const view = contentFileView(repo, ref, path, file);
      return jsonBytes(view) > RESPONSE_BUDGET ? tooLargeContent() : view;
    }
    const entries = directoryEntries(repo, ref, path, commit.tree);
    if (path.length > 0 && entries.length === 0) return notFound(context);
    return jsonBytes(entries) > RESPONSE_BUDGET ? tooLargeContent() : { entries };
  },

  "repos.create-or-update-file": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    requirePush(context, permission);
    const path = normalizePath(context, input.path);
    if (path.length === 0) return invalid(context, "Validation Failed", [{ resource: "Contents", field: "path", code: "missing_field" }]);
    const message = typeof input.message === "string" ? input.message : "";
    if (message.trim().length === 0) return invalid(context, "Validation Failed", [{ resource: "Commit", field: "message", code: "missing_field" }]);
    const content = String(input.content);
    if (byteLength(content) > MAX_FILE_BYTES) return invalid(context, "Validation Failed", [{ resource: "Contents", field: "content", code: "too_large" }]);
    const branchName = input.branch ?? repo.default_branch;
    const branch = getBranch(context, repo, branchName);
    if (branch === null) return notFound(context, "Branch not found");
    const parent = getCommit(context, repo.key, branch.sha);
    if (parent === null) return notFound(context, "Branch not found");
    const existing = treeGet(parent.tree, path);
    if (existing !== undefined) {
      if (input.sha === undefined) return invalid(context, 'Invalid request.\n\n"sha" wasn\'t supplied.');
      if (input.sha !== existing.sha) return fail(context, "CONFLICT", `${path} does not match ${String(input.sha)}`);
    } else if (treeSize(parent.tree) >= MAX_TREE_ENTRIES) {
      return invalid(context, "Repository is too large for this Tool");
    }
    if (treePaths(parent.tree).some((entry) => entry.startsWith(`${path}/`) || path.startsWith(`${entry}/`))) {
      return invalid(context, "Validation Failed", [{ resource: "Contents", field: "path", code: "invalid" }]);
    }
    const now = isoNow(context);
    const me = identity(user);
    const author = input.author === undefined ? me : { ...me, ...input.author };
    const committer = input.committer === undefined ? me : { ...me, ...input.committer };
    const tree = nullMap(parent.tree);
    treeSet(tree, path, treeEntry(content));
    const commit = buildCommit(context, repo.key, { tree, parents: [parent.sha], message, author, committer, date: now, sequence: nextSequence(context) });
    storeCommit(context, repo, commit);
    context.state.put("branches", branchRowId(repo.key, branch.name), { ...branch, sha: commit.sha, updated_at: now });
    touchRepo(context, repo, now, true);
    refreshPullsOnBranch(context, repo, branch.name);
    const view = commitView(context, repo, commit);
    return {
      content: contentFileView(repo, branch.name, path, treeGet(tree, path)),
      commit: {
        sha: commit.sha,
        node_id: commit.node_id,
        url: view.commit.url,
        html_url: view.html_url,
        author: view.commit.author,
        committer: view.commit.committer,
        message: commit.message,
        tree: view.commit.tree,
        parents: view.parents,
        verification: view.commit.verification,
      },
    };
  },

  "issues.list-labels-for-repo": (input, context) => {
    const { repo } = open(context, input);
    const labels = repoLabels(context, repo).sort((left, right) => compareStrings(left.name.toLowerCase(), right.name.toLowerCase()));
    const page = pageOf(context, labels, input, (label) => labelView(repo, label), "Label");
    return { labels: page.items, total_count: page.total, total_pages: page.pages };
  },

  "issues.list": (input, context) => {
    const { repo } = open(context, input);
    const mangledList = rejectMangled(context, input, "Issue", ["labels", "assignee", "creator", "milestone", "state", "sort", "direction", "since", "orderBy", "after"]);
    if (mangledList !== undefined) return mangledList;
    if (input.mentioned !== undefined) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "mentioned", code: "unsupported" }]);
    if (input.milestone !== undefined && input.milestone !== "*" && input.milestone !== "none") {
      return invalid(context, "Validation Failed", [{ resource: "Issue", field: "milestone", code: "unsupported" }]);
    }
    if (input.after !== undefined && input.page !== undefined) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "after", code: "invalid" }]);
    const state = stateFilter(context, input.state);
    const labelNames = input.labels === undefined ? [] : (Array.isArray(input.labels) ? input.labels : String(input.labels).split(",")).map((name) => String(name).trim().toLowerCase()).filter((name) => name.length > 0);
    const since = input.since === undefined ? undefined : parseDate(input.since);
    if (input.since !== undefined && since === undefined) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "since", code: "invalid" }]);
    const sortRaw = input.sort ?? (input.orderBy === undefined ? "created" : ownValue(ORDER_BY, input.orderBy));
    if (!["created", "updated", "comments"].includes(sortRaw)) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "sort", code: "invalid" }]);
    const direction = directionOf(context, input.direction, "desc");
    const assignee = input.assignee === undefined ? undefined : String(input.assignee).toLowerCase();
    const creator = input.creator === undefined ? undefined : String(input.creator).toLowerCase();
    let issues = repoIssues(context, repo).filter((issue) => {
      if (state !== "all" && issue.state !== state) return false;
      const labels = issue.labels.map((name) => name.toLowerCase());
      if (labelNames.some((name) => !labels.includes(name))) return false;
      if (assignee === "none" && issue.assignees.length > 0) return false;
      if (assignee !== undefined && assignee !== "none" && assignee !== "*" && !issue.assignees.some((login) => login.toLowerCase() === assignee)) return false;
      if (assignee === "*" && issue.assignees.length === 0) return false;
      if (creator !== undefined && issue.user.toLowerCase() !== creator) return false;
      if (since !== undefined && timestampMs(issue.updated_at) < since) return false;
      return true;
    });
    issues = sortBy(issues, sortRaw, direction);
    if (input.after !== undefined) {
      const decoded = base64UrlDecode(String(input.after));
      const match = decoded === undefined ? null : /^issue:([1-9][0-9]{0,8})$/.exec(decoded);
      if (match === null) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "after", code: "invalid" }]);
      const position = issues.findIndex((issue) => issue.number === Number(match[1]));
      if (position < 0) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "after", code: "invalid" }]);
      const size = input.perPage ?? 30;
      const rest = issues.slice(position + 1);
      const taken = takeByBytes(rest, size, (issue) => issueView(context, repo, issue, "issue"));
      if (taken.tooLarge !== undefined) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "per_page", code: "too_large", message: "This item is too large to return in one response" }]);
      const last = rest[taken.taken - 1];
      return {
        issues: taken.items,
        total_count: issues.length,
        page_info: {
          has_next_page: taken.taken < rest.length,
          end_cursor: last === undefined ? null : base64UrlEncode(`issue:${last.number}`),
        },
      };
    }
    const page = pageOf(context, issues, input, (issue) => issueView(context, repo, issue, "issue"), "Issue");
    const last = page.items[page.items.length - 1];
    return {
      issues: page.items,
      total_count: page.total,
      total_pages: page.pages,
      page_info: {
        has_next_page: page.page < page.pages,
        end_cursor: last === undefined ? null : base64UrlEncode(`issue:${last.number}`),
      },
    };
  },

  "issues.read": (input, context) => {
    const { repo } = open(context, input);
    const method = String(input.method);
    if (!["get", "get_comments", "get_labels"].includes(method)) {
      return invalid(context, "Validation Failed", [{ resource: "Issue", field: "method", code: "unsupported", value: method }]);
    }
    const thread = getThread(context, repo, input.issue_number);
    if (method === "get") return issueView(context, repo, thread.row, thread.kind);
    if (method === "get_labels") return { labels: issueView(context, repo, thread.row, thread.kind).labels, total_count: thread.row.labels.length };
    const comments = prefixRows(context, "comments", `${repo.key}#${String(thread.row.number).padStart(5, "0")}:`);
    const page = pageOf(context, comments, input, (comment) => commentView(context, repo, comment), "IssueComment");
    return { comments: page.items, total_count: page.total, total_pages: page.pages };
  },

  "issues.write": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    const method = String(input.method);
    if (method !== "create" && method !== "update") {
      return invalid(context, "Validation Failed", [{ resource: "Issue", field: "method", code: "unsupported", value: method }]);
    }
    if (input.type !== undefined) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "type", code: "unsupported" }]);
    if (input.milestone !== undefined && input.milestone !== null) {
      return invalid(context, "Validation Failed", [{ resource: "Issue", field: "milestone", code: "unsupported" }]);
    }
    const now = isoNow(context);
    if (method === "create") {
      const title = requireTitle(context, input.title);
      const body = requireBody(context, input.body);
      if (input.assignees !== undefined && input.assignees.length > 0) requireTriage(context, permission);
      const labels = input.labels === undefined ? [] : resolveLabels(context, repo, permission, input.labels);
      const assignees = input.assignees === undefined ? [] : resolveAssignees(context, repo, input.assignees);
      if (repoIssues(context, repo).length + repoPulls(context, repo).length >= 10_000) return invalid(context, "Repository is too large for this Tool");
      const number = repo.next_number;
      repo.next_number += 1;
      repo.open_issues_count += 1;
      const id = nextId(context);
      const issue = {
        repo: repo.key,
        number,
        id,
        node_id: `I_synthetic_${id}`,
        title,
        body,
        state: "open",
        state_reason: null,
        locked: false,
        user: user.login,
        labels,
        assignees,
        milestone: null,
        comments: 0,
        author_association: association(context, repo, user.login),
        created_at: now,
        updated_at: now,
        closed_at: null,
        closed_by: null,
      };
      context.state.put("issues", issueRowId(repo.key, number), issue);
      touchRepo(context, repo, now, false);
      emitIssue(context, repo, issue, "opened", user.login);
      return issueView(context, repo, issue, "issue");
    }
    if (input.issue_number === undefined) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "issue_number", code: "missing_field" }]);
    const thread = getThread(context, repo, input.issue_number);
    if (thread.kind === "pr") return invalid(context, "Validation Failed", [{ resource: "Issue", field: "issue_number", code: "invalid", message: "Use the pull request operations for pull requests" }]);
    const issue = { ...thread.row, labels: [...thread.row.labels], assignees: [...thread.row.assignees] };
    const own = issue.user.toLowerCase() === user.login.toLowerCase();
    const triage = atLeast(permission, "triage");
    if (!own && !triage) return fail(context, "FORBIDDEN", "Resource not accessible by personal access token");
    if (issue.locked && !triage) return fail(context, "FORBIDDEN", "Unable to update because issue is locked.");
    if ((input.labels !== undefined || input.assignees !== undefined) && !triage) requireTriage(context, permission);
    const events = [];
    if (input.title !== undefined) {
      const title = requireTitle(context, input.title);
      if (title !== issue.title) {
        issue.title = title;
        events.push(["edited"]);
      }
    }
    if (input.body !== undefined) {
      const body = requireBody(context, input.body);
      if (body !== issue.body) {
        issue.body = body;
        if (!events.some(([action]) => action === "edited")) events.push(["edited"]);
      }
    }
    if (input.state_reason !== undefined) {
      const reason = String(input.state_reason);
      const target = input.state ?? issue.state;
      const closedReason = ["completed", "not_planned", "duplicate"].includes(reason);
      if ((closedReason && target !== "closed") || (reason === "reopened" && target !== "open")) {
        return invalid(context, "Validation Failed", [{ resource: "Issue", field: "state_reason", code: "invalid" }]);
      }
    }
    if (input.state !== undefined && input.state !== issue.state) {
      if (input.state === "closed") {
        issue.state = "closed";
        issue.state_reason = input.state_reason ?? "completed";
        issue.closed_at = now;
        issue.closed_by = user.login;
        repo.open_issues_count = Math.max(0, repo.open_issues_count - 1);
        events.push(["closed"]);
      } else {
        issue.state = "open";
        issue.state_reason = "reopened";
        issue.closed_at = null;
        issue.closed_by = null;
        repo.open_issues_count += 1;
        events.push(["reopened"]);
      }
    } else if (input.state_reason !== undefined && issue.state === "closed") {
      issue.state_reason = input.state_reason;
      if (!events.some(([action]) => action === "edited")) events.push(["edited"]);
    }
    if (input.labels !== undefined) {
      const next = resolveLabels(context, repo, permission, input.labels);
      const before = issue.labels.map((name) => name.toLowerCase());
      const after = next.map((name) => name.toLowerCase());
      const added = next.filter((name) => !before.includes(name.toLowerCase()));
      const removed = issue.labels.filter((name) => !after.includes(name.toLowerCase()));
      issue.labels = next;
      for (const label of added) events.push(["labeled", { label }]);
      for (const label of removed) events.push(["unlabeled", { label }]);
    }
    if (input.assignees !== undefined) {
      const next = resolveAssignees(context, repo, input.assignees);
      const before = issue.assignees.map((login) => login.toLowerCase());
      const after = next.map((login) => login.toLowerCase());
      const added = next.filter((login) => !before.includes(login.toLowerCase()));
      const removed = issue.assignees.filter((login) => !after.includes(login.toLowerCase()));
      issue.assignees = next;
      for (const assignee of added) events.push(["assigned", { assignee }]);
      for (const assignee of removed) events.push(["unassigned", { assignee }]);
    }
    issue.updated_at = now;
    context.state.put("issues", issueRowId(repo.key, issue.number), issue);
    touchRepo(context, repo, now, false);
    const order = ["edited", "closed", "reopened", "labeled", "unlabeled", "assigned", "unassigned"];
    events.sort(([left], [right]) => order.indexOf(left) - order.indexOf(right));
    for (const [action, extra] of events) emitIssue(context, repo, issue, action, user.login, extra);
    return issueView(context, repo, issue, "issue");
  },

  "issues.add-comment": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    if (input.reaction !== undefined) return invalid(context, "Validation Failed", [{ resource: "IssueComment", field: "reaction", code: "unsupported" }]);
    const thread = getThread(context, repo, input.issue_number);
    const body = typeof input.body === "string" ? input.body : "";
    if (body.trim().length === 0) return invalid(context, "Validation Failed", [{ resource: "IssueComment", field: "body", code: "missing_field" }]);
    if (body.length > MAX_BODY) return invalid(context, "Validation Failed", [{ resource: "IssueComment", field: "body", code: "invalid" }]);
    if (thread.row.locked && !atLeast(permission, "triage")) return fail(context, "FORBIDDEN", "Unable to create comment because issue is locked.");
    if (thread.row.comments >= 10_000) return invalid(context, "Repository is too large for this Tool");
    const now = isoNow(context);
    const id = nextCommentId(context);
    const comment = {
      repo: repo.key,
      issue_number: thread.row.number,
      id,
      node_id: `IC_synthetic_${id}`,
      body,
      user: user.login,
      author_association: association(context, repo, user.login),
      created_at: now,
      updated_at: now,
    };
    context.state.put("comments", commentRowId(repo.key, thread.row.number, id), comment);
    thread.row = { ...thread.row, comments: thread.row.comments + 1, updated_at: now };
    saveThread(context, repo, thread);
    touchRepo(context, repo, now, false);
    context.events.emit("issue-comment.created", {
      action: "created",
      repository: repo.full_name,
      number: thread.row.number,
      comment_id: id,
      sender: user.login,
      is_pull_request: thread.kind === "pr",
    });
    return commentView(context, repo, comment);
  },

  "issues.add-labels": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    requireTriage(context, permission);
    const thread = getThread(context, repo, input.issue_number);
    const now = isoNow(context);
    const resolved = resolveLabels(context, repo, permission, input.labels);
    const labels = [...thread.row.labels];
    const added = [];
    for (const name of resolved) {
      if (!labels.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
        labels.push(name);
        added.push(name);
      }
    }
    if (labels.length > MAX_LABELS) return invalid(context, "Validation Failed", [{ resource: "Issue", field: "labels", code: "invalid" }]);
    thread.row = { ...thread.row, labels, updated_at: now };
    saveThread(context, repo, thread);
    touchRepo(context, repo, now, false);
    for (const label of added) emitIssue(context, repo, thread.row, "labeled", user.login, { label });
    return { labels: issueView(context, repo, thread.row, thread.kind).labels };
  },

  "issues.remove-label": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    requireTriage(context, permission);
    const thread = getThread(context, repo, input.issue_number);
    const name = String(input.name);
    const labels = thread.row.labels.filter((existing) => existing.toLowerCase() !== name.toLowerCase());
    if (labels.length === thread.row.labels.length) return notFound(context, "Label does not exist");
    const now = isoNow(context);
    thread.row = { ...thread.row, labels, updated_at: now };
    saveThread(context, repo, thread);
    touchRepo(context, repo, now, false);
    emitIssue(context, repo, thread.row, "unlabeled", user.login, { label: name });
    return { labels: issueView(context, repo, thread.row, thread.kind).labels };
  },

  "issues.add-assignees": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    requireTriage(context, permission);
    const thread = getThread(context, repo, input.issue_number);
    const assignees = resolveAssignees(context, repo, input.assignees, thread.row.assignees);
    const added = assignees.filter((login) => !thread.row.assignees.includes(login));
    const now = isoNow(context);
    thread.row = { ...thread.row, assignees, updated_at: now };
    saveThread(context, repo, thread);
    touchRepo(context, repo, now, false);
    for (const assignee of added) emitIssue(context, repo, thread.row, "assigned", user.login, { assignee });
    return issueView(context, repo, thread.row, thread.kind);
  },

  "issues.search": (input, context) => {
    const user = requireUser(context);
    if (input.query !== undefined && input.q !== undefined) {
      return invalid(context, "Validation Failed", [{ resource: "Search", field: "q", code: "invalid", message: "Exactly one of query or q is allowed" }]);
    }
    // Tool extension: a canonical/MCP call that omits both `query` and `q` searches every visible issue and pull
    // request (no qualifiers). GET /search/issues always sends `q` (missing → ""), so the REST 422 stays GitHub's.
    const omitted = input.query === undefined && input.q === undefined;
    let query = omitted ? "" : String(input.query ?? input.q);
    if (query.includes("\uFFFD")) {
      return invalid(context, "Validation Failed", [{ resource: "Search", field: "q", code: "invalid", message: "The search query contains an invalid character (U+FFFD); check the percent-encoding" }]);
    }
    if (input.owner !== undefined && input.repo !== undefined) query = `repo:${input.owner}/${input.repo} ${query}`;
    if (!omitted && query.trim().length === 0) {
      return invalid(context, "Validation Failed", [{ resource: "Search", field: "q", code: "missing", message: "The search is longer than 256 characters or empty" }]);
    }
    const sort = input.sort;
    if (sort !== undefined && !["comments", "created", "updated"].includes(sort)) {
      return invalid(context, "Validation Failed", [{ resource: "Search", field: "sort", code: "invalid", message: `Unsupported sort "${sort}"` }]);
    }
    const order = directionOf(context, input.order, "desc");
    let filter;
    try {
      filter = parseQuery(query, user.login);
    } catch (error) {
      if (error instanceof SearchError) {
        return invalid(context, "Validation Failed", [{ resource: "Search", field: "q", code: "invalid", message: error.message }]);
      }
      throw error;
    }
    const scored = [];
    for (const { repo } of visibleRepos(context, user, allRows(context, "repos"))) {
      if (filter.repos.length > 0 && !filter.repos.includes(repo.full_name.toLowerCase())) continue;
      const candidates = [
        ...repoIssues(context, repo).map((row) => ({ kind: "issue", row })),
        ...repoPulls(context, repo).map((row) => ({ kind: "pr", row })),
      ];
      for (const { kind, row } of candidates) {
        const commentText = filter.fields.has("comments")
          ? prefixRows(context, "comments", `${repo.key}#${String(row.number).padStart(5, "0")}:`).map((comment) => comment.body).join("\n")
          : "";
        const reviews = kind === "pr" ? prefixRows(context, "reviews", `${repo.key}#${String(row.number).padStart(5, "0")}:`).length : 0;
        const score = scoreCandidate(filter, {
          kind,
          repo: repo.full_name.toLowerCase(),
          state: row.state,
          merged: kind === "pr" ? row.merged : false,
          draft: kind === "pr" ? row.draft : false,
          user: row.user,
          assignees: row.assignees,
          labels: row.labels,
          title: row.title,
          body: row.body,
          comments: row.comments,
          commentText,
          created_at: row.created_at,
          updated_at: row.updated_at,
          closed_at: row.closed_at,
          reviews,
        });
        if (score > 0) scored.push({ repo, kind, row, score });
      }
    }
    scored.sort((left, right) => {
      let order_ = 0;
      if (sort === "comments") order_ = left.row.comments - right.row.comments;
      else if (sort === "created") order_ = compareStrings(left.row.created_at, right.row.created_at);
      else if (sort === "updated") order_ = compareStrings(left.row.updated_at, right.row.updated_at);
      else order_ = left.score - right.score;
      if (order_ !== 0) return order === "asc" ? order_ : -order_;
      const created = compareStrings(left.row.created_at, right.row.created_at);
      if (created !== 0) return -created;
      return right.row.number - left.row.number;
    });
    const page = pageOf(context, scored, input, (entry) => ({ ...issueView(context, entry.repo, entry.row, entry.kind), score: entry.score }), "Search");
    return { total_count: page.total, incomplete_results: false, items: page.items, total_pages: page.pages };
  },

  "pulls.list": (input, context) => {
    const { repo } = open(context, input);
    const mangledPulls = rejectMangled(context, input, "PullRequest", ["head", "base", "state", "sort", "direction"]);
    if (mangledPulls !== undefined) return mangledPulls;
    const state = stateFilter(context, input.state);
    const sort = input.sort ?? "created";
    if (sort !== "created" && sort !== "updated") return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "sort", code: "unsupported", value: sort }]);
    const direction = directionOf(context, input.direction, "desc");
    const head = input.head === undefined ? undefined : String(input.head).includes(":") ? String(input.head) : `${repo.owner}:${String(input.head)}`;
    let pulls = repoPulls(context, repo).filter((pull) => {
      if (state !== "all" && pull.state !== state) return false;
      if (head !== undefined && pull.head.label.toLowerCase() !== head.toLowerCase()) return false;
      if (input.base !== undefined && pull.base.ref !== input.base) return false;
      return true;
    });
    pulls = sortBy(pulls, sort, direction);
    const page = pageOf(context, pulls, input, (pull) => pullView(context, repo, pull, false), "PullRequest");
    return { pull_requests: page.items, total_count: page.total, total_pages: page.pages };
  },

  "pulls.read": (input, context) => {
    const { repo } = open(context, input);
    const method = String(input.method);
    if (!["get", "get_files", "get_commits", "get_reviews", "get_comments"].includes(method)) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "method", code: "unsupported", value: method }]);
    }
    const pull = getPull(context, repo, input.pullNumber);
    if (pull === null) return notFound(context);
    const prefix = `${repo.key}#${String(pull.number).padStart(5, "0")}:`;
    if (method === "get") return pullView(context, repo, pull, true);
    if (method === "get_files") {
      const files = mergeability(context, repo.key, pull.base.sha, pull.head.sha).files;
      // GitHub omits `patch` for a file whose diff is too large to return; the entry itself is always listed.
      const page = pageOf(context, files, input, (file) => fitPatch(diffEntryView(repo, pull.head.sha, file, true)), "PullRequest");
      return { files: page.items, total_count: page.total, total_pages: page.pages };
    }
    if (method === "get_commits") {
      const commits = pull.commit_shas.map((sha) => getCommit(context, repo.key, sha)).filter((commit) => commit !== null);
      const page = pageOf(context, commits, input, (commit) => commitView(context, repo, commit), "PullRequest");
      return { commits: page.items, total_count: page.total, total_pages: page.pages };
    }
    if (method === "get_reviews") {
      const reviews = prefixRows(context, "reviews", prefix);
      const page = pageOf(context, reviews, input, (review) => reviewView(context, repo, review), "PullRequestReview");
      return { reviews: page.items, total_count: page.total, total_pages: page.pages };
    }
    const comments = prefixRows(context, "comments", prefix);
    const page = pageOf(context, comments, input, (comment) => commentView(context, repo, comment), "IssueComment");
    return { comments: page.items, total_count: page.total, total_pages: page.pages };
  },

  "pulls.create": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    requirePush(context, permission);
    const title = requireTitle(context, input.title);
    const body = requireBody(context, input.body);
    const headRaw = String(input.head);
    const colon = headRaw.indexOf(":");
    const headRef = colon < 0 ? headRaw : headRaw.slice(colon + 1);
    if (colon >= 0 && headRaw.slice(0, colon).toLowerCase() !== repo.owner.toLowerCase()) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "head", code: "invalid" }]);
    }
    const head = getBranch(context, repo, headRef);
    if (head === null) return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "head", code: "invalid" }]);
    const base = getBranch(context, repo, input.base);
    if (base === null) return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "base", code: "invalid" }]);
    if (head.name === base.name) return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "head", code: "invalid", message: "head and base must be different branches" }]);
    const label = `${repo.owner}:${head.name}`;
    if (repoPulls(context, repo).some((pull) => pull.state === "open" && pull.head.label.toLowerCase() === label.toLowerCase())) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${label}.` }]);
    }
    if (commitsBetween(context, repo.key, base.sha, head.sha).length === 0) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", code: "custom", message: `No commits between ${base.name} and ${head.name}` }]);
    }
    if (repoIssues(context, repo).length + repoPulls(context, repo).length >= 10_000) return invalid(context, "Repository is too large for this Tool");
    const now = isoNow(context);
    const number = repo.next_number;
    const id = nextId(context);
    const draft = input.draft === true;
    const seed = {
      repo: repo.key,
      number,
      id,
      node_id: `PR_synthetic_${id}`,
      title,
      body,
      state: "open",
      draft,
      locked: false,
      user: user.login,
      head: { ref: head.name, sha: head.sha, label },
      base: { ref: base.name, sha: base.sha, label: `${repo.owner}:${base.name}` },
      merged: false,
      merged_at: null,
      merged_by: null,
      merge_commit_sha: null,
      mergeable: null,
      mergeable_state: "unknown",
      rebaseable: false,
      maintainer_can_modify: input.maintainer_can_modify !== false,
      labels: [],
      assignees: [],
      requested_reviewers: [],
      comments: 0,
      review_comments: 0,
      commits: 0,
      additions: 0,
      deletions: 0,
      changed_files: 0,
      commit_shas: [],
      files: [],
      author_association: association(context, repo, user.login),
      created_at: now,
      updated_at: now,
      closed_at: null,
    };
    seed.requested_reviewers = input.reviewers === undefined ? [] : resolveReviewers(context, repo, seed, input.reviewers);
    const pull = refreshPull(context, repo, seed);
    repo.next_number += 1;
    repo.open_issues_count += 1;
    savePull(context, repo, pull);
    touchRepo(context, repo, now, false);
    emitPull(context, repo, pull, "opened", user.login);
    return pullView(context, repo, pull, true);
  },

  "pulls.update": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    const stored = getPull(context, repo, input.pullNumber);
    if (stored === null) return notFound(context);
    const own = stored.user.toLowerCase() === user.login.toLowerCase();
    if (!own && !atLeast(permission, "triage")) return fail(context, "FORBIDDEN", "Resource not accessible by personal access token");
    let pull = { ...stored, head: { ...stored.head }, base: { ...stored.base } };
    const now = isoNow(context);
    const events = [];
    if (input.title !== undefined) {
      const title = requireTitle(context, input.title);
      if (title !== pull.title) {
        pull.title = title;
        events.push("edited");
      }
    }
    if (input.body !== undefined) {
      const body = requireBody(context, input.body);
      if (body !== pull.body) {
        pull.body = body;
        if (!events.includes("edited")) events.push("edited");
      }
    }
    if (input.maintainer_can_modify !== undefined) pull.maintainer_can_modify = input.maintainer_can_modify;
    if (input.base !== undefined && input.base !== pull.base.ref) {
      if (pull.merged) return invalid(context, "Cannot change the base of a merged pull request");
      const base = getBranch(context, repo, input.base);
      if (base === null) return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "base", code: "invalid" }]);
      if (base.name === pull.head.ref) return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "base", code: "invalid", message: "head and base must be different branches" }]);
      pull.base = { ref: base.name, sha: base.sha, label: `${repo.owner}:${base.name}` };
      if (!events.includes("edited")) events.push("edited");
    }
    if (input.reviewers !== undefined) {
      requirePush(context, permission);
      const reviewers = resolveReviewers(context, repo, pull, input.reviewers);
      const added = reviewers.filter((login) => !pull.requested_reviewers.includes(login));
      pull.requested_reviewers = reviewers;
      if (added.length > 0) events.push("review_requested");
    }
    if (input.draft !== undefined && input.draft !== pull.draft) {
      requirePullOpen(context, pull);
      pull.draft = input.draft;
      events.push(input.draft ? "converted_to_draft" : "ready_for_review");
    }
    if (input.state !== undefined && input.state !== pull.state) {
      if (pull.merged) return invalid(context, "Cannot change the state of a merged pull request");
      if (input.state === "closed") {
        pull.state = "closed";
        pull.closed_at = now;
        repo.open_issues_count = Math.max(0, repo.open_issues_count - 1);
        events.push("closed");
      } else {
        if (getBranch(context, repo, pull.head.ref) === null) {
          return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "head", code: "invalid", message: "The head branch no longer exists" }]);
        }
        if (repoPulls(context, repo).some((other) => other.number !== pull.number && other.state === "open" && other.head.label.toLowerCase() === pull.head.label.toLowerCase())) {
          return invalid(context, "Validation Failed", [{ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${pull.head.label}.` }]);
        }
        pull.state = "open";
        pull.closed_at = null;
        repo.open_issues_count += 1;
        events.push("reopened");
      }
    }
    pull.updated_at = now;
    if (pull.state === "open" && !pull.merged) pull = refreshPull(context, repo, pull);
    savePull(context, repo, pull);
    touchRepo(context, repo, now, false);
    for (const action of events) emitPull(context, repo, pull, action, user.login);
    return pullView(context, repo, pull, true);
  },

  "pulls.create-review": (input, context) => {
    const { user, repo } = open(context, input);
    requireWritable(context, repo);
    const method = input.method ?? "create";
    if (method !== "create") return invalid(context, "Validation Failed", [{ resource: "PullRequestReview", field: "method", code: "unsupported", value: String(method) }]);
    const stored = getPull(context, repo, input.pullNumber);
    if (stored === null) return notFound(context);
    requirePullOpen(context, stored);
    const event = String(input.event);
    const state = ownValue(REVIEW_STATES, event);
    if (state === undefined) return invalid(context, "Validation Failed", [{ resource: "PullRequestReview", field: "event", code: "invalid", value: event }]);
    const own = stored.user.toLowerCase() === user.login.toLowerCase();
    if (own && event === "APPROVE") return invalid(context, "Can not approve your own pull request");
    if (own && event === "REQUEST_CHANGES") return invalid(context, "Can not request changes on your own pull request");
    const body = typeof input.body === "string" ? input.body : "";
    if (event !== "APPROVE" && body.trim().length === 0) return invalid(context, "Review body is required");
    if (input.commitID !== undefined && input.commit_id !== undefined && input.commitID !== input.commit_id) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequestReview", field: "commit_id", code: "invalid" }]);
    }
    const commitId = input.commitID ?? input.commit_id ?? stored.head.sha;
    if (getCommit(context, repo.key, commitId) === null) return invalid(context, "Validation Failed", [{ resource: "PullRequestReview", field: "commit_id", code: "invalid", value: String(commitId) }]);
    const prefix = `${repo.key}#${String(stored.number).padStart(5, "0")}:`;
    if (prefixRows(context, "reviews", prefix).length >= 1_000) return invalid(context, "Repository is too large for this Tool");
    const now = isoNow(context);
    const id = nextReviewId(context);
    const review = {
      repo: repo.key,
      pull_number: stored.number,
      id,
      node_id: `PRR_synthetic_${id}`,
      user: user.login,
      body,
      state,
      commit_id: commitId,
      author_association: association(context, repo, user.login),
      submitted_at: now,
    };
    context.state.put("reviews", reviewRowId(repo.key, stored.number, id), review);
    const pull = refreshPull(context, repo, { ...stored, updated_at: now });
    savePull(context, repo, pull);
    touchRepo(context, repo, now, false);
    emitPull(context, repo, pull, "review_submitted", user.login, { review_state: state });
    return reviewView(context, repo, review);
  },

  "pulls.check-merged": (input, context) => {
    const { repo } = open(context, input);
    const pull = getPull(context, repo, input.pullNumber);
    if (pull === null || !pull.merged) return notFound(context);
    return { merged: true };
  },

  "pulls.merge": (input, context) => {
    const { user, repo, permission } = open(context, input);
    requireWritable(context, repo);
    requirePush(context, permission);
    const stored = getPull(context, repo, input.pullNumber);
    if (stored === null) return notFound(context);
    const method = input.merge_method ?? "merge";
    if (!["merge", "squash", "rebase"].includes(method)) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "merge_method", code: "invalid", value: String(method) }]);
    }
    if (input.sha !== undefined && input.expectedHeadSha !== undefined && input.sha !== input.expectedHeadSha) {
      return invalid(context, "Validation Failed", [{ resource: "PullRequest", field: "sha", code: "invalid" }]);
    }
    const expected = input.sha ?? input.expectedHeadSha;
    if (stored.merged || stored.state !== "open") return fail(context, "METHOD_NOT_ALLOWED", "Pull Request is not mergeable");
    const pull = refreshPull(context, repo, stored);
    if (expected !== undefined && expected !== pull.head.sha) return fail(context, "CONFLICT", "Head branch was modified. Review and try the merge again.");
    if (pull.draft || pull.mergeable !== true) return fail(context, "METHOD_NOT_ALLOWED", "Pull Request is not mergeable");
    if (pull.mergeable_state === "blocked") {
      const required = getBranch(context, repo, pull.base.ref)?.protection?.required_approving_review_count ?? 1;
      return fail(context, "METHOD_NOT_ALLOWED", `At least ${required} approving review is required by reviewers with write access.`);
    }
    const base = getBranch(context, repo, pull.base.ref);
    const baseCommit = getCommit(context, repo.key, pull.base.sha);
    const headCommit = getCommit(context, repo.key, pull.head.sha);
    const mergeBaseCommit = mergeability(context, repo.key, pull.base.sha, pull.head.sha).base;
    if (base === null || baseCommit === null || headCommit === null || mergeBaseCommit === null) {
      return fail(context, "METHOD_NOT_ALLOWED", "Pull Request is not mergeable");
    }
    const now = isoNow(context);
    const me = identity(user);
    const mergedTree = applyChanges(baseCommit.tree, mergeBaseCommit.tree, headCommit.tree);
    let tip;
    if (method === "merge") {
      const message = `Merge pull request #${pull.number} from ${pull.head.label.replace(":", "/")}\n\n${pull.title}`;
      tip = buildCommit(context, repo.key, { tree: mergedTree, parents: [baseCommit.sha, headCommit.sha], message, author: me, committer: me, date: now, sequence: nextSequence(context) });
      storeCommit(context, repo, tip);
    } else if (method === "squash") {
      const prCommits = pull.commit_shas.map((sha) => getCommit(context, repo.key, sha)).filter((commit) => commit !== null);
      const title = input.commit_title ?? `${pull.title} (#${pull.number})`;
      const bodyText = input.commit_message ?? prCommits.map((commit) => `* ${commit.message.split("\n")[0]}`).join("\n\n");
      const message = bodyText.length > 0 ? `${title}\n\n${bodyText}` : title;
      tip = buildCommit(context, repo.key, { tree: mergedTree, parents: [baseCommit.sha], message, author: me, committer: me, date: now, sequence: nextSequence(context) });
      storeCommit(context, repo, tip);
    } else {
      let parentSha = baseCommit.sha;
      let tree = baseCommit.tree;
      for (const sha of pull.commit_shas) {
        const commit = getCommit(context, repo.key, sha);
        if (commit === null) continue;
        const parentTree = commit.parents.length > 0 ? (getCommit(context, repo.key, commit.parents[0])?.tree ?? {}) : {};
        tree = applyChanges(tree, parentTree, commit.tree);
        tip = buildCommit(context, repo.key, { tree, parents: [parentSha], message: commit.message, author: commit.author, committer: me, date: now, sequence: nextSequence(context) });
        storeCommit(context, repo, tip);
        parentSha = tip.sha;
      }
      if (tip === undefined) return fail(context, "METHOD_NOT_ALLOWED", "Pull Request is not mergeable");
    }
    context.state.put("branches", branchRowId(repo.key, base.name), { ...base, sha: tip.sha, updated_at: now });
    const merged = {
      ...pull,
      state: "closed",
      merged: true,
      merged_at: now,
      merged_by: user.login,
      merge_commit_sha: tip.sha,
      closed_at: now,
      updated_at: now,
      mergeable: null,
      rebaseable: false,
      mergeable_state: "unknown",
    };
    savePull(context, repo, merged);
    repo.open_issues_count = Math.max(0, repo.open_issues_count - 1);
    touchRepo(context, repo, now, true);
    refreshPullsOnBranch(context, repo, base.name);
    emitPull(context, repo, merged, "closed", user.login, { merge_commit_sha: tip.sha });
    return { sha: tip.sha, merged: true, message: "Pull Request successfully merged" };
  },
};

// ---------------------------------------------------------------------------------------------
// HTTP codecs (GitHub REST shapes over the canonical operations)
// ---------------------------------------------------------------------------------------------

function repoArgs(request) {
  return { owner: request.path.owner, repo: request.path.repo };
}

function outcomeValue(outcome) {
  return outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? outcome.value : undefined;
}

/** Codec for one route: `select` maps the canonical value to the REST body; errors use GitHub's envelope. */
function route(decode, select, options = {}) {
  return {
    decode,
    encode({ outcome }) {
      const headers = rateLimitHeaders(isRateLimited(outcome));
      const value = outcomeValue(outcome);
      if (value === undefined) return { headers, body: { kind: "json", value: githubError(outcome) } };
      if (options.empty) return { headers, body: { kind: "empty" } };
      return { headers, body: { kind: "json", value: select(value) } };
    },
  };
}

const PATH_ARGUMENTS = new Set(["owner", "repo", "issue_number", "pullNumber", "method", "page", "perPage"]);

/** Rebuild the GitHub query string of a list request from the canonical arguments (pure, per invocation). */
function queryFromArguments(args, pathArguments = PATH_ARGUMENTS) {
  const query = {};
  for (const [name, value] of Object.entries(args)) {
    if (pathArguments.has(name) || value === undefined || value === null) continue;
    query[name] = [Array.isArray(value) ? value.join(",") : String(value)];
  }
  return query;
}

/** Codec for a paginated GitHub list: the encoder rebuilds `link` from the invocation arguments. */
function listRoute(decode, select, pathOf, pathArguments = PATH_ARGUMENTS) {
  return {
    decode,
    encode({ invocation, outcome }) {
      const args = invocation.arguments ?? {};
      const page = typeof args.page === "number" ? args.page : 1;
      const perPage = typeof args.perPage === "number" ? args.perPage : 30;
      const headers = rateLimitHeaders(isRateLimited(outcome));
      const value = outcomeValue(outcome);
      if (value === undefined) return { headers, body: { kind: "json", value: githubError(outcome) } };
      // Pages are cut by count and bytes, so the last page comes from the operation's `total_pages`.
      const lastPage = typeof value.total_pages === "number" ? value.total_pages : Math.max(1, Math.ceil((value.total_count ?? 0) / perPage));
      const link = linkHeader({ pathname: pathOf(args), query: queryFromArguments(args, pathArguments) }, page, perPage, lastPage);
      if (link !== undefined) headers.link = link;
      return { headers, body: { kind: "json", value: select(value) } };
    },
  };
}

const repoPath = (args, suffix) => `/repos/${args.owner}/${args.repo}${suffix}`;

/** GET a commit: its `files` are paged by count and bytes, with a `link` header like the lists. */
function commitRoute(depth) {
  return listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), sha: joinSegments(request, "r", depth), ...pagination(request.query) }) }),
    ({ total_pages: _pages, ...value }) => value,
    (args) => repoPath(args, `/commits/${args.sha}`),
    new Set([...PATH_ARGUMENTS, "sha"]),
  );
}

function contentArgs(request, depth) {
  return { ...repoArgs(request), path: joinSegments(request, "p", depth) };
}

function getContentRoute(depth) {
  return route(
    (request) => ({ arguments: defined({ ...contentArgs(request, depth), ref: str(request.query, "ref") }) }),
    (value) => (value.entries !== undefined ? value.entries : { ...value, encoding: "base64", content: base64Encode(value.content) }),
  );
}

function putContentRoute(depth) {
  return route(
    (request) => {
      const body = jsonBody(request);
      const content = typeof body.content === "string" ? base64Decode(body.content) : undefined;
      if (content === undefined) throw new TypeError("content must be base64-encoded UTF-8 text");
      return operationInput(
        request,
        defined({
          ...contentArgs(request, depth),
          message: body.message,
          content,
          branch: body.branch,
          sha: body.sha,
          committer: body.committer,
          author: body.author,
        }),
      );
    },
    (value) => ({ ...value, content: { ...value.content, encoding: "base64", content: base64Encode(value.content.content) } }),
  );
}

function issueBody(body) {
  return defined({
    title: body.title,
    body: body.body,
    state: body.state,
    state_reason: body.state_reason,
    labels: Array.isArray(body.labels) ? body.labels.map((label) => (typeof label === "object" && label !== null ? label.name : label)) : body.labels,
    assignees: body.assignees,
    milestone: body.milestone === undefined ? undefined : body.milestone,
    type: body.type,
  });
}

const http = {
  "get-authenticated": route(() => ({ arguments: {} }), ({ server_time: _serverTime, ...user }) => user),
  "list-for-authenticated-user": listRoute(
    (request) => ({
      arguments: defined({
        visibility: str(request.query, "visibility"),
        affiliation: str(request.query, "affiliation"),
        type: str(request.query, "type"),
        sort: str(request.query, "sort"),
        direction: str(request.query, "direction"),
        ...pagination(request.query),
      }),
    }),
    (value) => value.repositories,
    (args) => "/user/repos",
  ),
  "get-repo": route((request) => ({ arguments: repoArgs(request) }), (value) => value),
  "list-branches": listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), protected: bool(request.query, "protected"), ...pagination(request.query) }) }),
    (value) => value.branches,
    (args) => repoPath(args, "/branches"),
  ),
  "get-branch-1": route((request) => ({ arguments: { ...repoArgs(request), branch: joinSegments(request, "b", 1) } }), (value) => value),
  "get-branch-2": route((request) => ({ arguments: { ...repoArgs(request), branch: joinSegments(request, "b", 2) } }), (value) => value),
  "create-ref": route(
    (request) => {
      const body = jsonBody(request);
      const ref = typeof body.ref === "string" ? body.ref : "";
      if (!ref.startsWith("refs/heads/") || ref.length <= "refs/heads/".length) {
        return operationInput(request, defined({ ...repoArgs(request), branch: "", sha: body.sha }));
      }
      return operationInput(request, defined({ ...repoArgs(request), branch: ref.slice("refs/heads/".length), sha: body.sha }));
    },
    (value) => value,
  ),
  "list-commits": listRoute(
    (request) => ({
      arguments: defined({
        ...repoArgs(request),
        sha: str(request.query, "sha"),
        path: str(request.query, "path"),
        author: str(request.query, "author"),
        since: str(request.query, "since"),
        until: str(request.query, "until"),
        ...pagination(request.query),
      }),
    }),
    (value) => value.commits,
    (args) => repoPath(args, "/commits"),
  ),
  "get-commit-1": commitRoute(1),
  "get-commit-2": commitRoute(2),
  "get-content-0": route(
    (request) => ({ arguments: defined({ ...repoArgs(request), path: "", ref: str(request.query, "ref") }) }),
    (value) => value.entries,
  ),
  "get-content-1": getContentRoute(1),
  "get-content-2": getContentRoute(2),
  "get-content-3": getContentRoute(3),
  "get-content-4": getContentRoute(4),
  "create-or-update-file-contents-1": putContentRoute(1),
  "create-or-update-file-contents-2": putContentRoute(2),
  "create-or-update-file-contents-3": putContentRoute(3),
  "create-or-update-file-contents-4": putContentRoute(4),
  "list-labels-for-repo": listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), ...pagination(request.query) }) }),
    (value) => value.labels,
    (args) => repoPath(args, "/labels"),
  ),
  "list-issues": listRoute(
    (request) => ({
      arguments: defined({
        ...repoArgs(request),
        state: str(request.query, "state"),
        labels: str(request.query, "labels"),
        assignee: str(request.query, "assignee"),
        creator: str(request.query, "creator"),
        mentioned: str(request.query, "mentioned"),
        milestone: str(request.query, "milestone"),
        since: str(request.query, "since"),
        sort: str(request.query, "sort"),
        direction: str(request.query, "direction"),
        ...pagination(request.query),
      }),
    }),
    (value) => value.issues,
    (args) => repoPath(args, "/issues"),
  ),
  "get-issue": route((request) => ({ arguments: { ...repoArgs(request), issue_number: pathNumber(request, "issue_number"), method: "get" } }), (value) => value),
  "list-comments": listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), issue_number: pathNumber(request, "issue_number"), method: "get_comments", ...pagination(request.query) }) }),
    (value) => value.comments,
    (args) => repoPath(args, `/issues/${args.issue_number}/comments`),
  ),
  "list-labels-on-issue": route(
    (request) => ({ arguments: { ...repoArgs(request), issue_number: pathNumber(request, "issue_number"), method: "get_labels" } }),
    (value) => value.labels,
  ),
  "create-issue": route(
    (request) => operationInput(request, { ...repoArgs(request), method: "create", ...issueBody(jsonBody(request)) }),
    (value) => value,
  ),
  "update-issue": route(
    (request) => operationInput(request, { ...repoArgs(request), method: "update", issue_number: pathNumber(request, "issue_number"), ...issueBody(jsonBody(request)) }),
    (value) => value,
  ),
  "create-comment": route(
    (request) => operationInput(request, defined({ ...repoArgs(request), issue_number: pathNumber(request, "issue_number"), body: jsonBody(request).body })),
    (value) => value,
  ),
  "add-labels": route(
    (request) => {
      const raw = request.body.kind === "json" ? assertJsonDepth(request.body.value) : undefined;
      const labels = Array.isArray(raw) ? raw : Array.isArray(raw?.labels) ? raw.labels : [];
      return operationInput(request, {
        ...repoArgs(request),
        issue_number: pathNumber(request, "issue_number"),
        labels: labels.map((label) => (typeof label === "object" && label !== null ? label.name : label)),
      });
    },
    (value) => value.labels,
  ),
  "remove-label": route(
    (request) => operationInput(request, { ...repoArgs(request), issue_number: pathNumber(request, "issue_number"), name: request.path.name }),
    (value) => value.labels,
  ),
  "add-assignees": route(
    (request) => {
      const body = jsonBody(request);
      return operationInput(request, { ...repoArgs(request), issue_number: pathNumber(request, "issue_number"), assignees: Array.isArray(body.assignees) ? body.assignees : [] });
    },
    (value) => value,
  ),
  "search-issues-and-pull-requests": listRoute(
    (request) => ({
      arguments: defined({ q: str(request.query, "q") ?? "", sort: str(request.query, "sort"), order: str(request.query, "order"), ...pagination(request.query) }),
    }),
    ({ total_pages: _pages, ...value }) => value,
    (args) => "/search/issues",
  ),
  "list-pulls": listRoute(
    (request) => ({
      arguments: defined({
        ...repoArgs(request),
        state: str(request.query, "state"),
        head: str(request.query, "head"),
        base: str(request.query, "base"),
        sort: str(request.query, "sort"),
        direction: str(request.query, "direction"),
        ...pagination(request.query),
      }),
    }),
    (value) => value.pull_requests,
    (args) => repoPath(args, "/pulls"),
  ),
  "get-pull": route((request) => ({ arguments: { ...repoArgs(request), pullNumber: pathNumber(request, "pull_number"), method: "get" } }), (value) => value),
  "list-pull-files": listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), pullNumber: pathNumber(request, "pull_number"), method: "get_files", ...pagination(request.query) }) }),
    (value) => value.files,
    (args) => repoPath(args, `/pulls/${args.pullNumber}/files`),
  ),
  "list-pull-commits": listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), pullNumber: pathNumber(request, "pull_number"), method: "get_commits", ...pagination(request.query) }) }),
    (value) => value.commits,
    (args) => repoPath(args, `/pulls/${args.pullNumber}/commits`),
  ),
  "list-reviews": listRoute(
    (request) => ({ arguments: defined({ ...repoArgs(request), pullNumber: pathNumber(request, "pull_number"), method: "get_reviews", ...pagination(request.query) }) }),
    (value) => value.reviews,
    (args) => repoPath(args, `/pulls/${args.pullNumber}/reviews`),
  ),
  "create-pull": route(
    (request) => {
      const body = jsonBody(request);
      return operationInput(
        request,
        defined({ ...repoArgs(request), title: body.title, head: body.head, base: body.base, body: body.body, draft: body.draft, maintainer_can_modify: body.maintainer_can_modify }),
      );
    },
    (value) => value,
  ),
  "update-pull": route(
    (request) => {
      const body = jsonBody(request);
      return operationInput(
        request,
        defined({
          ...repoArgs(request),
          pullNumber: pathNumber(request, "pull_number"),
          title: body.title,
          body: body.body,
          state: body.state,
          base: body.base,
          draft: body.draft,
          maintainer_can_modify: body.maintainer_can_modify,
          reviewers: body.reviewers,
        }),
      );
    },
    (value) => value,
  ),
  "create-review": route(
    (request) => {
      const body = jsonBody(request);
      if (body.comments !== undefined) throw new TypeError("review comments are not supported");
      return operationInput(request, defined({ ...repoArgs(request), pullNumber: pathNumber(request, "pull_number"), event: body.event, body: body.body, commit_id: body.commit_id }));
    },
    (value) => value,
  ),
  "check-if-merged": route(
    (request) => ({ arguments: { ...repoArgs(request), pullNumber: pathNumber(request, "pull_number") } }),
    (value) => value,
    { empty: true },
  ),
  merge: route(
    (request) => {
      const body = jsonBody(request);
      return operationInput(
        request,
        defined({ ...repoArgs(request), pullNumber: pathNumber(request, "pull_number"), merge_method: body.merge_method, commit_title: body.commit_title, commit_message: body.commit_message, sha: body.sha }),
      );
    },
    (value) => value,
  ),
};

export default { operations, http };
