// Synthetic Linear workspace. Every operation computes from context.state: ids come from the
// `meta/counters` row, issue numbers from each team's counter, timestamps from the virtual clock
// and visibility from the calling actor's Linear user and team memberships. The `/graphql` route
// parses one GraphQL document and dispatches its fields to the same internal functions that back
// the semantic operations. Nothing here contacts Linear; no webhook or notification is ever sent.
import { canSeeTeam, isMember, resolveIdentity } from "./lib/access.mjs";
import { boundExceeded, boundMessage, clipValue, errorEntry, forbidden, graphqlValidation, invalidInput, notFound, notImplemented, rateLimitMeta } from "./lib/errors.mjs";
import { ORDER_FIELDS, chargeCharacters, checkFilterBounds, containsText, filterHash, foldText, matches, orderRows, page, parseInstant, prepareNeedle } from "./lib/filters.mjs";
import { GraphQLError, coerceVariables, exceedsDepth, execute, parse, selectOperation } from "./lib/graphql.mjs";
import {
  PROJECT_STATES,
  REF_CYCLE,
  REF_ISSUE,
  REF_LABEL,
  REF_PROJECT,
  REF_STATE,
  REF_TEAM,
  REF_USER,
  STATE_TYPES,
  baseComment,
  baseCycle,
  baseIssue,
  baseLabel,
  baseOrganization,
  baseProject,
  baseState,
  baseTeam,
  baseUser,
  cycleFlags,
  progressOf,
} from "./lib/render.mjs";
import {
  COLOR_PATTERN,
  IDENTIFIER_PATTERN,
  isRowId,
  LIMITS,
  allRows,
  bumpSyncId,
  compareStrings,
  currentSyncId,
  fnv1a,
  isPlainObject,
  isUuid,
  isValidDate,
  isoNow,
  nextId,
  nowMs,
  organizationOf,
  ownEntry,
  parseTimestamp,
  prefixRows,
} from "./lib/state.mjs";

const DEFAULT_LABEL_COLOR = "#95a2b3";
const MAX_PAGE = 250;
const MAX_PROJECT_PAGE = 50;
const ISSUE_FIELD_ALIASES = Object.freeze({
  uuid: "id",
  status: "state",
  statusType: "state",
  gitBranchName: "branchName",
  createdBy: "creator",
  createdById: "creator",
  assigneeId: "assignee",
  projectId: "project",
  teamId: "team",
  cycleId: "cycle",
  parentId: "parent",
});
const ISSUE_FIELDS = new Set([
  "id", "identifier", "number", "title", "description", "priority", "priorityLabel", "estimate", "dueDate", "url", "branchName", "sortOrder",
  "createdAt", "updatedAt", "archivedAt", "startedAt", "completedAt", "canceledAt", "team", "state", "assignee", "creator", "project", "cycle", "parent", "labels",
]);
const GRAPHQL_ISSUE_INPUT = new Set(["teamId", "title", "description", "stateId", "assigneeId", "priority", "estimate", "dueDate", "labelIds", "addedLabelIds", "removedLabelIds", "projectId", "cycleId", "parentId", "sortOrder", "id"]);
const FRIENDLY_ISSUE_INPUT = new Set(["team", "title", "description", "state", "assignee", "priority", "estimate", "dueDate", "labels", "addLabels", "removeLabels", "project", "cycle", "parentId"]);
const UNSUPPORTED_ISSUE_INPUT = ["delegate", "template", "milestone", "links", "patch", "blocks", "blockedBy", "relatedTo", "duplicateOf", "removeBlocks", "removeBlockedBy", "removeRelatedTo", "slaBreachesAt", "slaType", "addReleases", "removeReleases", "setReleases"];
const GRAPHQL_PROJECT_INPUT = new Set(["name", "teamIds", "description", "content", "leadId", "state", "priority", "startDate", "targetDate", "icon", "color"]);
const FRIENDLY_PROJECT_INPUT = new Set(["name", "description", "summary", "state", "priority", "lead", "addTeams", "removeTeams", "setTeams", "startDate", "targetDate", "startDateResolution", "targetDateResolution", "icon", "color"]);
const UNSUPPORTED_PROJECT_INPUT = ["labels", "template", "patch", "links", "addInitiatives", "removeInitiatives", "setInitiatives", "leadTeam"];
const UNSUPPORTED_COMMENT_PARENTS = ["projectId", "documentId", "initiativeId", "milestoneId", "statusUpdateId", "statusUpdateType"];

// ---------------------------------------------------------------------------------------------
// Session: identity first, then lazily loaded (bounded) rows
// ---------------------------------------------------------------------------------------------

function open(context) {
  const bound = (namespace, limit) => boundExceeded(context, namespace, limit);
  const cache = new Map();
  const memo = new WeakMap();
  const organization = organizationOf(context);
  const limits = { ...LIMITS, ...(isPlainObject(organization.limits) ? organization.limits : {}) };
  const session = {
    context,
    organization,
    limits,
    nowMs: nowMs(context),
    iso: isoNow(context),
    cached(key, load) {
      if (!cache.has(key)) cache.set(key, load());
      return cache.get(key);
    },
    /**
     * Places a row just written at `rowIdOf(row)` into an already loaded row list, keeping row-id (scan) order, instead of
     * dropping the list: a request with many mutations would otherwise rescan and copy the whole namespace once per write
     * (100 issueCreate fields over 10,000 issues is a million row copies). Derived indexes are dropped as on invalidate.
     */
    store(key, row, rowIdOf = (value) => value.id) {
      for (const derivedKey of [...cache.keys()]) if (derivedKey.startsWith("derived/")) cache.delete(derivedKey);
      if (!cache.has(key)) return;
      const rows = cache.get(key);
      const rowId = rowIdOf(row);
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (compareStrings(rowIdOf(rows[middle]), rowId) < 0) low = middle + 1;
        else high = middle;
      }
      if (low < rows.length && rowIdOf(rows[low]) === rowId) rows[low] = row;
      else rows.splice(low, 0, row);
    },
    invalidate(...keys) {
      for (const key of keys) cache.delete(key);
      // Indexes and nested connection pages are derived from rows; any write drops all of them.
      for (const key of [...cache.keys()]) if (key.startsWith("derived/")) cache.delete(key);
    },
    memo(type, row, compute) {
      let byType = memo.get(row);
      if (byType === undefined) {
        byType = new Map();
        memo.set(row, byType);
      }
      if (!byType.has(type)) byType.set(type, compute());
      return byType.get(type);
    },
  };
  session.users = () => session.cached("users", () => allRows(context, "users", limits.users, bound));
  session.me = resolveIdentity(context, session.users);
  session.teams = () => session.cached("teams", () => allRows(context, "teams", limits.teams, bound));
  session.visibleTeams = () => session.cached("visibleTeams", () => session.teams().filter((team) => canSeeTeam(session.me, team)));
  session.states = () => session.cached("workflow-states", () => allRows(context, "workflow-states", limits["workflow-states"], bound));
  session.labels = () => session.cached("labels", () => allRows(context, "labels", limits.labels, bound));
  session.projects = () => session.cached("projects", () => allRows(context, "projects", limits.projects, bound));
  session.cycles = () => session.cached("cycles", () => allRows(context, "cycles", limits.cycles, bound));
  session.issues = () => session.cached("issues", () => allRows(context, "issues", limits.issues, bound));
  session.allComments = () => session.cached("allComments", () => allRows(context, "comments", limits.comments, bound));
  session.comments = (issueId) => session.cached(`comments/${issueId}`, () => prefixRows(context, "comments", `${issueId}/`, limits.commentsPerIssue, bound));
  // Rows looked up by id are read from state once per operation: a GraphQL page resolves team, state, assignee and labels
  // for every node, which was 84,000 state reads for one 100-alias document. Every write in this module goes through
  // `session.put`, which refreshes the entry, so a read after a write in the same operation sees the new row.
  const rowsById = new Map();
  const byId = (namespace, id) => {
    if (!isRowId(id)) return null;
    const key = `${namespace}\n${id}`;
    if (!rowsById.has(key)) rowsById.set(key, context.state.get(namespace, id));
    return rowsById.get(key);
  };
  session.put = (namespace, id, row) => {
    context.state.put(namespace, id, row);
    rowsById.set(`${namespace}\n${id}`, row);
  };
  session.user = (id) => byId("users", id);
  session.team = (id) => byId("teams", id);
  session.state = (id) => byId("workflow-states", id);
  session.label = (id) => byId("labels", id);
  session.project = (id) => byId("projects", id);
  session.cycle = (id) => byId("cycles", id);
  session.issue = (id) => byId("issues", id);
  session.visibleTeam = (id) => {
    const team = session.team(id);
    return canSeeTeam(session.me, team) ? team : null;
  };
  session.visibleIssue = (row) => (row !== null && row !== undefined && session.visibleTeam(row.teamId) !== null ? row : null);
  session.visibleProject = (row) => (row !== null && row !== undefined && Array.isArray(row.teamIds) && row.teamIds.some((teamId) => session.visibleTeam(teamId) !== null) ? row : null);
  session.visibleIssues = () => session.cached("visibleIssues", () => session.issues().filter((row) => session.visibleTeam(row.teamId) !== null));
  /**
   * Visible issues, archived ones dropped unless `includeArchived`, in page order for `orderBy`: sorted once per request
   * per (orderBy, includeArchived), so a GraphQL document repeating root `issues`/`searchIssues` under many aliases does
   * not re-sort up to 10,000 rows per alias. Every later filter keeps this order. Shared array: callers never mutate it.
   */
  session.orderedIssues = (orderBy, includeArchived) => session.cached(`derived/ordered-issues/${orderBy}/${String(includeArchived)}`, () => {
    const rows = includeArchived ? session.visibleIssues() : session.visibleIssues().filter((row) => (row.archivedAt ?? null) === null);
    return orderRows(rows, orderBy);
  });
  /** Comments of one issue in `orderBy` order ("oldest" = ascending by createdAt), sorted once per request. */
  session.orderedComments = (issueId, orderBy) => session.cached(`derived/ordered-comments/${orderBy}/${issueId}`, () => {
    if (orderBy !== "oldest") return orderRows(session.comments(issueId), orderBy);
    const keyed = session.comments(issueId).map((row) => ({ row, at: parseTimestamp(row.createdAt) }));
    keyed.sort((left, right) => left.at - right.at || compareStrings(left.row.id, right.row.id));
    return keyed.map((entry) => entry.row);
  });
  /** Rows grouped by relation id, built once per session (O(rows)) so nested resolvers never rescan every issue. */
  session.groupBy = (name, rows, keysOf) => session.cached(`derived/group/${name}`, () => {
    const groups = new Map();
    for (const row of rows()) {
      for (const key of keysOf(row)) {
        if (typeof key !== "string") continue;
        const list = groups.get(key);
        if (list === undefined) groups.set(key, [row]);
        else list.push(row);
      }
    }
    return groups;
  });
  /** Visible issues whose `field` (teamId, stateId, assigneeId, creatorId, projectId, cycleId, parentId, labelIds) references `id`, in row order. */
  session.issuesWhere = (field, id) => session.groupBy(`issues/${field}`, session.visibleIssues, (row) => (field === "labelIds" ? (Array.isArray(row.labelIds) ? [...new Set(row.labelIds)] : []) : [row[field]])).get(id) ?? [];
  /** Unarchived visible children of an issue, grouped once per session. Shared array: callers copy before sorting. */
  session.childrenOf = (issueId) => session.groupBy("issues/children", session.visibleIssues, (row) => ((row.archivedAt ?? null) === null ? [row.parentId] : [])).get(issueId) ?? [];
  session.labelsOf = (row) => (Array.isArray(row.labelIds) ? row.labelIds.map((id) => session.label(id)).filter((label) => label !== null) : []);
  // Issue text-search results per folded term, keyed by row object (a write replaces the row object, so entries never go stale).
  const searchResults = new Map();
  session.searchHits = (term) => {
    let hits = searchResults.get(term);
    if (hits === undefined) {
      hits = new Map();
      searchResults.set(term, hits);
    }
    return hits;
  };
  // One filter work budget per request, shared by every list (and GraphQL root field) the request evaluates.
  const filterBudget = { steps: 0 };
  // Lower-cased string values, folded once per request however many filters, searches and aliases compare them.
  const folds = new Map();
  session.filterEnv = () => ({
    budget: filterBudget,
    folds,
    nowMs: session.nowMs,
    viewerId: session.me.id,
    invalid: (message) => invalidInput(context, message),
    cycleFlags: (row) => cycleFlags(row, session.nowMs),
    resolve: {
      team: (row) => session.team(row.teamId),
      state: (row) => session.state(row.stateId),
      assignee: (row) => session.user(row.assigneeId),
      creator: (row) => session.user(row.creatorId),
      lead: (row) => session.user(row.leadId),
      project: (row) => session.project(row.projectId),
      cycle: (row) => session.cycle(row.cycleId),
      parent: (row) => session.issue(row.parentId),
      issue: (row) => session.issue(row.issueId),
    },
    collect: {
      labels: (row) => session.labelsOf(row),
      children: (row) => session.childrenOf(row.id),
      teams: (row) => (Array.isArray(row.teamIds) ? row.teamIds.map((id) => session.team(id)).filter((team) => team !== null) : []),
    },
  });
  return session;
}

function projectProgress(session, project) {
  return progressOf(session.issuesWhere("projectId", project.id).filter((row) => (row.archivedAt ?? null) === null));
}

function cycleProgress(session, cycle) {
  return progressOf(session.issuesWhere("cycleId", cycle.id).filter((row) => (row.archivedAt ?? null) === null));
}

// ---------------------------------------------------------------------------------------------
// Reference resolution (friendly spelling: id → key/identifier → case-insensitive name/e-mail)
// ---------------------------------------------------------------------------------------------

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function fold(value) {
  return String(value ?? "").toLowerCase();
}

/**
 * Rows where any of `valuesOf(row)` contains `query` case-insensitively: the needle is folded and prepared once, and every
 * comparison is linear and charged to the request's filter budget (users, teams, projects and labels by name).
 */
function textMatches(session, rows, query, valuesOf) {
  const env = session.filterEnv();
  const needle = prepareNeedle(env, fold(query));
  return rows.filter((row) => valuesOf(row).some((value) => {
    const folded = foldText(env, String(value ?? ""), null, null);
    chargeCharacters(env, folded.length);
    return containsText(folded, needle);
  }));
}

function unique(session, candidates, reference) {
  if (candidates.length > 1) return invalidInput(session.context, `Ambiguous reference "${clipValue(reference)}"`);
  return candidates.length === 1 ? candidates[0] : null;
}

function findUser(session, value) {
  const reference = text(value);
  if (reference.length === 0) return null;
  if (reference === "me") return session.me;
  if (isUuid(reference)) return session.user(reference);
  const users = session.users();
  const byEmail = users.filter((row) => fold(row.email) === fold(reference));
  if (byEmail.length > 0) return unique(session, byEmail, reference);
  return unique(session, users.filter((row) => fold(row.name) === fold(reference) || fold(row.displayName) === fold(reference)), reference);
}

function requireUser(session, value) {
  const user = findUser(session, value);
  return user === null ? notFound(session.context, "User") : user;
}

function findTeam(session, value) {
  const reference = text(value);
  if (reference.length === 0) return null;
  if (isUuid(reference)) return session.visibleTeam(reference);
  const teams = session.visibleTeams();
  const byKey = teams.filter((row) => fold(row.key) === fold(reference));
  if (byKey.length > 0) return unique(session, byKey, reference);
  return unique(session, teams.filter((row) => fold(row.name) === fold(reference)), reference);
}

function requireTeam(session, value) {
  const team = findTeam(session, value);
  return team === null ? notFound(session.context, "Team") : team;
}

function teamStates(session, team) {
  return session
    .states()
    .filter((row) => row.teamId === team.id && (row.archivedAt ?? null) === null)
    .sort((left, right) => left.position - right.position || compareStrings(left.id, right.id));
}

/** A workflow state of `team` by id, name (case-insensitive) or type. */
function requireState(session, team, value) {
  const reference = text(value);
  const states = teamStates(session, team);
  let candidates = [];
  if (isUuid(reference)) candidates = states.filter((row) => row.id === reference);
  else {
    candidates = states.filter((row) => fold(row.name) === fold(reference));
    if (candidates.length === 0 && STATE_TYPES.includes(reference)) candidates = states.filter((row) => row.type === reference);
  }
  if (candidates.length === 0) {
    const anyState = isUuid(reference) ? session.state(reference) : null;
    if (anyState !== null) return invalidInput(session.context, `State "${anyState.name}" does not belong to team ${team.key}`);
    return notFound(session.context, "WorkflowState");
  }
  return candidates[0];
}

function scopeLabels(session, team) {
  return session.labels().filter((row) => (row.teamId ?? null) === null || (team !== null && row.teamId === team.id) || session.visibleTeam(row.teamId) !== null);
}

/** A workspace label or a label of a visible team by id or name (case-insensitive). */
function requireLabel(session, team, value) {
  const reference = text(value);
  const labels = scopeLabels(session, team);
  const candidates = isUuid(reference) ? labels.filter((row) => row.id === reference) : labels.filter((row) => fold(row.name) === fold(reference));
  if (candidates.length === 0) return notFound(session.context, "IssueLabel");
  const inScope = team === null ? candidates : candidates.filter((row) => (row.teamId ?? null) === null || row.teamId === team.id);
  if (inScope.length === 0) return invalidInput(session.context, `Label "${candidates[0].name}" does not belong to team ${team.key}`, ["labels"]);
  const scoped = team === null ? inScope : inScope.filter((row) => row.teamId === team.id);
  return (scoped.length > 0 ? scoped : inScope)[0];
}

function findProject(session, value) {
  const reference = text(value);
  if (reference.length === 0) return null;
  const projects = session.projects().filter((row) => session.visibleProject(row) !== null);
  if (isUuid(reference)) return projects.find((row) => row.id === reference) ?? null;
  const bySlug = projects.filter((row) => row.slugId === reference);
  if (bySlug.length > 0) return bySlug[0];
  return unique(session, projects.filter((row) => fold(row.name) === fold(reference)), reference);
}

function requireProject(session, value) {
  const project = findProject(session, value);
  return project === null ? notFound(session.context, "Project") : project;
}

function requireCycle(session, team, value) {
  const reference = text(value);
  const cycles = session.cycles().filter((row) => session.visibleTeam(row.teamId) !== null && (team === null || row.teamId === team.id));
  let candidates;
  if (isUuid(reference)) candidates = cycles.filter((row) => row.id === reference);
  else if (team === null) return invalidInput(session.context, "A cycle name or number requires a team; pass the cycle id or add the team");
  else if (/^[0-9]+$/.test(reference)) candidates = cycles.filter((row) => row.number === Number(reference));
  else candidates = cycles.filter((row) => fold(row.name) === fold(reference));
  return candidates.length === 0 ? notFound(session.context, "Cycle") : candidates[0];
}

/** A visible issue by uuid or identifier (`ENG-12`, case-insensitive), or null. */
function findIssue(session, value) {
  const reference = text(value);
  if (reference.length === 0) return null;
  if (isUuid(reference)) return session.visibleIssue(session.issue(reference));
  const identifier = reference.toUpperCase();
  if (!IDENTIFIER_PATTERN.test(identifier)) return null;
  if (!isRowId(identifier)) return null;
  const index = session.context.state.get("issue-identifiers", identifier);
  return index === null ? null : session.visibleIssue(session.issue(index.issueId));
}

function requireIssue(session, value) {
  const issue = findIssue(session, value);
  return issue === null ? notFound(session.context, "Issue") : issue;
}

function findComment(session, id) {
  const reference = text(id);
  if (!isUuid(reference)) return null;
  const comment = session.allComments().find((row) => row.id === reference) ?? null;
  if (comment === null) return null;
  return session.visibleIssue(session.issue(comment.issueId)) === null ? null : comment;
}

function requireComment(session, id) {
  const comment = findComment(session, id);
  return comment === null ? notFound(session.context, "Comment") : comment;
}

// ---------------------------------------------------------------------------------------------
// Input normalisation shared by the canonical operations and the GraphQL fields
// ---------------------------------------------------------------------------------------------

function rejectUnsupported(session, input, names, where) {
  for (const name of names) {
    if (input[name] !== undefined) return invalidInput(session.context, `Argument "${name}" is not supported by this Tool${where === undefined ? "" : ` on ${where}`}`);
  }
  return undefined;
}

function exclusive(session, input, leftNames, rightNames) {
  const left = leftNames.filter((name) => input[name] !== undefined);
  const right = rightNames.filter((name) => input[name] !== undefined);
  if (left.length > 0 && right.length > 0) {
    return invalidInput(session.context, `Cannot combine "${left[0]}" with "${right[0]}" in one call`);
  }
  return undefined;
}

/** `first`/`after`/`orderBy` (GraphQL) or `limit`/`cursor`/`orderBy` (MCP); one spelling per call. */
function paging(session, input, options = {}) {
  exclusive(session, input, ["limit", "cursor"], ["first", "after"]);
  const max = options.max ?? MAX_PAGE;
  const first = input.first ?? input.limit ?? options.defaultFirst ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > max) return invalidInput(session.context, `"first" must be an integer between 1 and ${String(max)}`);
  const after = input.after ?? input.cursor;
  if (after !== undefined && after !== null && (typeof after !== "string" || after.length === 0)) return invalidInput(session.context, "Invalid cursor");
  const orderBy = input.orderBy ?? "updatedAt";
  if (!ORDER_FIELDS.includes(orderBy)) return invalidInput(session.context, `"orderBy" must be one of ${ORDER_FIELDS.join(", ")}`);
  return { first, after: after ?? undefined, orderBy };
}

function connection(session, rows, paged, scope, filter) {
  const hash = filterHash(scope, filter);
  const result = page(rows, { first: paged.first, after: paged.after, orderBy: paged.orderBy, hash });
  return result === null ? invalidInput(session.context, "Invalid cursor") : result;
}

/** Ordered connection over rows sorted by the paging order field (descending, ties by id). */
function orderedConnection(session, rows, paged, scope, filter) {
  return connection(session, orderRows(rows, paged.orderBy), paged, scope, filter);
}

/** Filter depth/node bounds, checked before a filter is read, evaluated or hashed (see lib/filters.mjs). */
function boundFilter(session, typeName, filter) {
  checkFilterBounds(typeName, filter, (message) => invalidInput(session.context, message));
}

function afterInstant(session, value, name) {
  if (value === undefined || value === null) return undefined;
  const instant = parseInstant(value, session.nowMs);
  if (Number.isNaN(instant)) return invalidInput(session.context, `"${name}" must be an ISO-8601 date-time or duration`);
  return instant;
}

function issueFieldSelection(session, fields) {
  if (fields === undefined || fields === null) return null;
  if (!Array.isArray(fields)) return invalidInput(session.context, '"fields" must be a list of field names');
  if (fields.length === 0) return null;
  const selected = new Set(["id"]);
  for (const field of fields) {
    const name = ownEntry(ISSUE_FIELD_ALIASES, field) ?? field;
    if (!ISSUE_FIELDS.has(name)) return invalidInput(session.context, `Unsupported field "${clipValue(field)}"`);
    selected.add(name);
  }
  return selected;
}

// ---------------------------------------------------------------------------------------------
// Canonical renderers (one nested level)
// ---------------------------------------------------------------------------------------------

function renderUser(session, row) {
  return session.memo("User", row, () => baseUser(row, session.organization, session.me));
}

function renderUserFull(session, row) {
  const teams = session.visibleTeams().filter((team) => isMember(row, team));
  return { ...renderUser(session, row), organization: { id: session.organization.id, name: session.organization.name, urlKey: session.organization.urlKey }, teams: { nodes: teams.map(REF_TEAM) } };
}

function activeCycle(session, team) {
  if (team.cyclesEnabled !== true) return null;
  return session.cycles().find((row) => row.teamId === team.id && (row.archivedAt ?? null) === null && cycleFlags(row, session.nowMs).isActive) ?? null;
}

function renderTeam(session, row) {
  const members = row.memberIds.map((id) => session.user(id)).filter((user) => user !== null);
  return {
    ...session.memo("Team", row, () => baseTeam(row)),
    activeCycle: REF_CYCLE(activeCycle(session, row)),
    members: { nodes: members.map((user) => ({ id: user.id, name: user.name, displayName: user.displayName })) },
  };
}

function renderTeamFull(session, row) {
  const states = teamStates(session, row);
  const labels = session.labels().filter((label) => label.teamId === row.id && (label.archivedAt ?? null) === null);
  const defaultState = session.state(row.defaultIssueStateId);
  return {
    ...renderTeam(session, row),
    states: { nodes: states.map((state) => ({ id: state.id, name: state.name, type: state.type, color: state.color, position: state.position })) },
    labels: { nodes: labels.map(REF_LABEL) },
    defaultIssueState: defaultState === null ? null : { id: defaultState.id, name: defaultState.name },
  };
}

function renderState(session, row) {
  const team = session.team(row.teamId);
  return { ...session.memo("WorkflowState", row, () => baseState(row)), team: team === null ? null : { id: team.id, key: team.key } };
}

function renderLabel(session, row) {
  const team = session.team(row.teamId);
  const parent = session.label(row.parentId);
  return { ...session.memo("IssueLabel", row, () => baseLabel(row)), parent: parent === null ? null : { id: parent.id, name: parent.name }, team: team === null ? null : { id: team.id, key: team.key } };
}

function renderProject(session, row) {
  const teams = row.teamIds.map((id) => session.visibleTeam(id)).filter((team) => team !== null);
  const lead = session.user(row.leadId);
  return {
    ...session.memo("Project", row, () => baseProject(row, session.organization, projectProgress(session, row))),
    lead: lead === null ? null : { id: lead.id, name: lead.name, displayName: lead.displayName },
    teams: { nodes: teams.map(REF_TEAM) },
  };
}

/**
 * Project + one page of its visible, unarchived issues. `issuesFirst` (1–250, default 50) and `issuesAfter` page
 * through them with the same order (`updatedAt` descending, ties by id) and cursor scope as GraphQL
 * `project(id) { issues(first, after) }`, so a cursor from either continues on the other. Never a silently cut list.
 */
function renderProjectFull(session, row, input = {}) {
  const first = input.issuesFirst ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE) return invalidInput(session.context, `"issuesFirst" must be an integer between 1 and ${String(MAX_PAGE)}`);
  const after = input.issuesAfter;
  if (after !== undefined && after !== null && (typeof after !== "string" || after.length === 0)) return invalidInput(session.context, "Invalid cursor");
  const rows = session.issuesWhere("projectId", row.id).filter((issue) => (issue.archivedAt ?? null) === null);
  const paged = orderedConnection(session, rows, { first, after: after ?? undefined, orderBy: "updatedAt" }, `project-issues/${row.id}`, { includeArchived: false });
  return {
    ...renderProject(session, row),
    issues: { nodes: paged.rows.map((issue) => ({ ...REF_ISSUE(issue), state: stateRef(session, issue) })), pageInfo: paged.pageInfo },
  };
}

function stateRef(session, issue) {
  const state = session.state(issue.stateId);
  return state === null ? null : { name: state.name, type: state.type };
}

function renderCycle(session, row) {
  const team = session.team(row.teamId);
  return { ...session.memo("Cycle", row, () => baseCycle(row, session.nowMs, cycleProgress(session, row))), team: team === null ? null : { id: team.id, key: team.key } };
}

function renderIssue(session, row) {
  return {
    ...session.memo("Issue", row, () => baseIssue(row, session.organization, session.me)),
    team: REF_TEAM(session.team(row.teamId)),
    state: REF_STATE(session.state(row.stateId)),
    assignee: REF_USER(session.user(row.assigneeId)),
    creator: REF_USER(session.user(row.creatorId)),
    project: REF_PROJECT(session.project(row.projectId)),
    cycle: REF_CYCLE(session.cycle(row.cycleId)),
    parent: REF_ISSUE(session.issue(row.parentId)),
    labels: { nodes: session.labelsOf(row).map(REF_LABEL) },
  };
}

function commentRef(session, row) {
  return { id: row.id, body: row.body, user: REF_USER(session.user(row.userId)), parent: row.parentId === null || row.parentId === undefined ? null : { id: row.parentId }, createdAt: row.createdAt };
}

/**
 * Issue + one page of its comments, oldest first. `commentsFirst` (1–250, default 50) and `commentsAfter` page through
 * them with the same order and cursor scope as GraphQL `issue(id) { comments(first, after) }` (no `orderBy`), so a
 * cursor from either continues on the other and `pageInfo.endCursor` always leads to the rest. Never a silently cut list.
 */
function renderIssueFull(session, row, input = {}) {
  const first = input.commentsFirst ?? 50;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE) return invalidInput(session.context, `"commentsFirst" must be an integer between 1 and ${String(MAX_PAGE)}`);
  const after = input.commentsAfter;
  if (after !== undefined && after !== null && (typeof after !== "string" || after.length === 0)) return invalidInput(session.context, "Invalid cursor");
  const children = [...session.childrenOf(row.id)].sort((left, right) => left.number - right.number);
  const paged = issueComments(session, row, { first, after: after ?? undefined });
  return {
    ...renderIssue(session, row),
    children: { nodes: children.map((child) => ({ ...REF_ISSUE(child), state: stateRef(session, child) })) },
    comments: { nodes: paged.rows.map((comment) => commentRef(session, comment)), pageInfo: paged.pageInfo },
  };
}

function renderComment(session, row) {
  const issue = session.issue(row.issueId);
  const user = session.user(row.userId);
  return {
    ...session.memo("Comment", row, () => baseComment(row, session.organization, issue)),
    user: user === null ? null : { id: user.id, name: user.name, displayName: user.displayName },
    issue: issue === null ? null : { id: issue.id, identifier: issue.identifier },
    parent: row.parentId === null || row.parentId === undefined ? null : { id: row.parentId },
    attachments: [],
  };
}

function renderOrganization(session) {
  return baseOrganization(session.organization, { userCount: session.users().filter((row) => row.active === true).length, teamCount: session.visibleTeams().length });
}

function nodes(session, paged, render) {
  return { nodes: paged.rows.map((row) => render(session, row)), pageInfo: paged.pageInfo };
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

function listUsers(session, input) {
  boundFilter(session, "UserFilter", input.filter);
  rejectUnsupported(session, input, ["fields"]);
  const paged = paging(session, input);
  let rows = session.users();
  if (input.includeDisabled !== true) rows = rows.filter((row) => row.active === true);
  if (input.team !== undefined) {
    const team = requireTeam(session, input.team);
    rows = rows.filter((row) => isMember(row, team));
  }
  const query = text(input.query);
  if (query.length > 0) rows = textMatches(session, rows, query, (row) => [row.name, row.displayName, row.email]);
  if (input.filter !== undefined && input.filter !== null) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("UserFilter", input.filter, row, env));
  }
  return orderedConnection(session, rows, paged, "users", { query, team: input.team ?? null, includeDisabled: input.includeDisabled === true, filter: input.filter ?? null });
}

function getUser(session, input) {
  const reference = input.query ?? input.id;
  if (typeof reference !== "string" || reference.trim().length === 0) return invalidInput(session.context, 'Provide "query" (id, name, e-mail or "me") or "id"');
  return requireUser(session, reference);
}

function listTeams(session, input) {
  boundFilter(session, "TeamFilter", input.filter);
  const paged = paging(session, input);
  let rows = session.visibleTeams();
  if (input.includeArchived !== true) rows = rows.filter((row) => (row.archivedAt ?? null) === null);
  const query = text(input.query);
  if (query.length > 0) rows = textMatches(session, rows, query, (row) => [row.key, row.name]);
  const createdAfter = afterInstant(session, input.createdAt, "createdAt");
  const updatedAfter = afterInstant(session, input.updatedAt, "updatedAt");
  if (createdAfter !== undefined) rows = rows.filter((row) => parseTimestamp(row.createdAt) >= createdAfter);
  if (updatedAfter !== undefined) rows = rows.filter((row) => parseTimestamp(row.updatedAt) >= updatedAfter);
  if (input.filter !== undefined && input.filter !== null) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("TeamFilter", input.filter, row, env));
  }
  return orderedConnection(session, rows, paged, "teams", { query, includeArchived: input.includeArchived === true, filter: input.filter ?? null, createdAt: input.createdAt ?? null, updatedAt: input.updatedAt ?? null });
}

function getTeam(session, input) {
  const reference = input.query ?? input.id;
  if (typeof reference !== "string" || reference.trim().length === 0) return invalidInput(session.context, 'Provide "query" (id, key or name) or "id"');
  return requireTeam(session, reference);
}

function teamFromFilter(session, input) {
  if (input.team !== undefined) return requireTeam(session, input.team);
  if (input.teamId !== undefined) return requireTeam(session, input.teamId);
  const filter = input.filter;
  if (isPlainObject(filter) && isPlainObject(filter.team)) {
    for (const [key, comparators] of Object.entries(filter.team)) {
      if ((key === "id" || key === "key" || key === "name") && isPlainObject(comparators) && typeof comparators.eq === "string") return requireTeam(session, comparators.eq);
      return invalidInput(session.context, `Only "team: { id | key | name: { eq } }" is supported on this filter (got "${clipValue(key)}")`);
    }
  }
  return null;
}

function listStates(session, input) {
  boundFilter(session, "WorkflowStateFilter", input.filter);
  const team = teamFromFilter(session, input);
  if (team === null) return invalidInput(session.context, 'Provide "team", "teamId" or "filter: { team: { id: { eq } } }"');
  const paged = paging(session, { first: input.first, after: input.after });
  let rows = teamStates(session, team);
  if (isPlainObject(input.filter)) {
    const rest = { ...input.filter };
    delete rest.team;
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("WorkflowStateFilter", rest, row, env));
  }
  return connection(session, rows, { ...paged, orderBy: "position" }, "workflow-states", { team: team.id, filter: input.filter ?? null });
}

function listLabels(session, input) {
  boundFilter(session, "IssueLabelFilter", input.filter);
  if (input.includeGroups === true) return invalidInput(session.context, 'Argument "includeGroups" is not supported by this Tool (groups are always returned, marked isGroup)');
  const paged = paging(session, input);
  let team = null;
  let workspaceOnly = false;
  if (input.team !== undefined) team = requireTeam(session, input.team);
  const filter = isPlainObject(input.filter) ? { ...input.filter } : null;
  if (filter !== null && isPlainObject(filter.team)) {
    if (filter.team.null === true) workspaceOnly = true;
    else if (isPlainObject(filter.team.id) && typeof filter.team.id.eq === "string") team = requireTeam(session, filter.team.id.eq);
    else return invalidInput(session.context, 'Only "team: { id: { eq } }" or "team: { null: true }" is supported on IssueLabelFilter');
    delete filter.team;
  }
  let rows = session.labels().filter((row) => (row.teamId ?? null) === null || session.visibleTeam(row.teamId) !== null);
  if (workspaceOnly) rows = rows.filter((row) => (row.teamId ?? null) === null);
  if (team !== null) rows = rows.filter((row) => (row.teamId ?? null) === null || row.teamId === team.id);
  if (input.includeArchived !== true) rows = rows.filter((row) => (row.archivedAt ?? null) === null);
  const name = text(input.name);
  if (name.length > 0) rows = textMatches(session, rows, name, (row) => [row.name]);
  if (filter !== null && Object.keys(filter).length > 0) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("IssueLabelFilter", filter, row, env));
  }
  return orderedConnection(session, rows, paged, "labels", { team: team?.id ?? null, workspaceOnly, name, includeArchived: input.includeArchived === true, filter: input.filter ?? null });
}

function listProjects(session, input) {
  boundFilter(session, "ProjectFilter", input.filter);
  rejectUnsupported(session, input, ["label", "initiative", "fields"]);
  if (input.includeMembers === true || input.includeMilestones === true) return invalidInput(session.context, "Project members and milestones are not modelled by this Tool");
  const paged = paging(session, input, { max: input.limit === undefined ? MAX_PAGE : MAX_PROJECT_PAGE });
  let rows = session.projects().filter((row) => session.visibleProject(row) !== null);
  if (input.includeArchived !== true) rows = rows.filter((row) => (row.archivedAt ?? null) === null);
  const query = text(input.query);
  if (query.length > 0) rows = textMatches(session, rows, query, (row) => [row.name]);
  if (input.team !== undefined) {
    const team = requireTeam(session, input.team);
    rows = rows.filter((row) => row.teamIds.includes(team.id));
  }
  if (input.state !== undefined) {
    const state = fold(text(input.state));
    const matching = PROJECT_STATES.filter((candidate) => candidate === state || fold(PROJECT_STATES_NAMES[candidate]) === state);
    if (matching.length === 0) return invalidInput(session.context, `Unknown project state "${clipValue(input.state)}"`);
    rows = rows.filter((row) => matching.includes(row.state));
  }
  if (input.lead !== undefined) {
    const lead = requireUser(session, input.lead);
    rows = rows.filter((row) => row.leadId === lead.id);
  }
  if (input.member !== undefined) {
    const member = requireUser(session, input.member);
    rows = rows.filter((row) => row.leadId === member.id || row.teamIds.some((teamId) => isMember(member, session.team(teamId) ?? { memberIds: [] })));
  }
  const createdAfter = afterInstant(session, input.createdAt, "createdAt");
  const updatedAfter = afterInstant(session, input.updatedAt, "updatedAt");
  if (createdAfter !== undefined) rows = rows.filter((row) => parseTimestamp(row.createdAt) >= createdAfter);
  if (updatedAfter !== undefined) rows = rows.filter((row) => parseTimestamp(row.updatedAt) >= updatedAfter);
  if (input.filter !== undefined && input.filter !== null) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("ProjectFilter", input.filter, row, env));
  }
  return orderedConnection(session, rows, paged, "projects", { query, team: input.team ?? null, state: input.state ?? null, lead: input.lead ?? null, member: input.member ?? null, includeArchived: input.includeArchived === true, filter: input.filter ?? null, createdAt: input.createdAt ?? null, updatedAt: input.updatedAt ?? null });
}

const PROJECT_STATES_NAMES = Object.freeze({ backlog: "Backlog", planned: "Planned", started: "In Progress", paused: "Paused", completed: "Completed", canceled: "Canceled" });

function getProject(session, input) {
  if (input.includeResources === true || input.includeMembers === true || input.includeMilestones === true) {
    return invalidInput(session.context, "Project resources, members and milestones are not modelled by this Tool");
  }
  const reference = input.query ?? input.id;
  if (typeof reference !== "string" || reference.trim().length === 0) return invalidInput(session.context, 'Provide "query" (id, name or slugId) or "id"');
  return requireProject(session, reference);
}

function listCycles(session, input) {
  boundFilter(session, "CycleFilter", input.filter);
  let team = teamFromFilter(session, input);
  const paged = paging(session, { first: input.first, after: input.after });
  const filter = isPlainObject(input.filter) ? { ...input.filter } : null;
  if (filter !== null) delete filter.team;
  let rows = session.cycles().filter((row) => session.visibleTeam(row.teamId) !== null && (row.archivedAt ?? null) === null);
  if (team !== null) rows = team.cyclesEnabled === true ? rows.filter((row) => row.teamId === team.id) : [];
  if (input.type !== undefined) {
    if (team === null) return invalidInput(session.context, '"type" requires a team');
    const flagged = rows.map((row) => ({ row, flags: cycleFlags(row, session.nowMs) }));
    if (input.type === "current") rows = flagged.filter((entry) => entry.flags.isActive).map((entry) => entry.row);
    else if (input.type === "previous") {
      const past = flagged.filter((entry) => entry.flags.isPast).sort((left, right) => right.row.number - left.row.number);
      rows = past.length === 0 ? [] : [past[0].row];
    } else if (input.type === "next") {
      const future = flagged.filter((entry) => entry.flags.isFuture).sort((left, right) => left.row.number - right.row.number);
      rows = future.length === 0 ? [] : [future[0].row];
    } else return invalidInput(session.context, '"type" must be current, previous or next');
  }
  if (filter !== null && Object.keys(filter).length > 0) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("CycleFilter", filter, row, env));
  }
  rows = [...rows].sort((left, right) => left.number - right.number || compareStrings(left.id, right.id));
  return connection(session, rows, { ...paged, orderBy: "number" }, "cycles", { team: team?.id ?? null, type: input.type ?? null, filter: input.filter ?? null });
}

function listIssues(session, input) {
  boundFilter(session, "IssueFilter", input.filter);
  rejectUnsupported(session, input, ["delegate", "release"]);
  exclusive(session, input, ["query", "team", "state", "assignee", "priority", "label", "project", "cycle", "parentId", "createdAt", "updatedAt", "fields", "limit", "cursor"], ["filter"]);
  const paged = paging(session, input);
  const selection = issueFieldSelection(session, input.fields);
  let rows = session.orderedIssues(paged.orderBy, input.includeArchived === true);
  const team = input.team === undefined ? null : requireTeam(session, input.team);
  if (team !== null) rows = rows.filter((row) => row.teamId === team.id);
  if (input.state !== undefined) {
    const reference = text(input.state);
    let stateIds;
    if (team !== null) {
      const typed = STATE_TYPES.includes(reference) ? teamStates(session, team).filter((row) => row.type === reference) : [];
      stateIds = new Set(typed.length > 0 ? typed.map((row) => row.id) : [requireState(session, team, reference).id]);
    } else if (isUuid(reference)) stateIds = new Set([reference]);
    else stateIds = new Set(session.states().filter((row) => fold(row.name) === fold(reference) || row.type === reference).map((row) => row.id));
    if (stateIds.size === 0) return notFound(session.context, "WorkflowState");
    rows = rows.filter((row) => stateIds.has(row.stateId));
  }
  if (input.assignee !== undefined) {
    if (input.assignee === null || fold(text(input.assignee)) === "null") rows = rows.filter((row) => (row.assigneeId ?? null) === null);
    else {
      const assignee = requireUser(session, input.assignee);
      rows = rows.filter((row) => row.assigneeId === assignee.id);
    }
  }
  if (input.priority !== undefined) {
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 4) return invalidInput(session.context, '"priority" must be an integer from 0 to 4');
    rows = rows.filter((row) => row.priority === input.priority);
  }
  if (input.label !== undefined) {
    const label = requireLabel(session, team, input.label);
    rows = rows.filter((row) => Array.isArray(row.labelIds) && row.labelIds.includes(label.id));
  }
  if (input.project !== undefined) {
    const project = requireProject(session, input.project);
    rows = rows.filter((row) => row.projectId === project.id);
  }
  if (input.cycle !== undefined) {
    const cycle = requireCycle(session, team, input.cycle);
    rows = rows.filter((row) => row.cycleId === cycle.id);
  }
  if (input.parentId !== undefined) {
    const parent = requireIssue(session, input.parentId);
    rows = rows.filter((row) => row.parentId === parent.id);
  }
  const createdAfter = afterInstant(session, input.createdAt, "createdAt");
  const updatedAfter = afterInstant(session, input.updatedAt, "updatedAt");
  if (createdAfter !== undefined) rows = rows.filter((row) => parseTimestamp(row.createdAt) >= createdAfter);
  if (updatedAfter !== undefined) rows = rows.filter((row) => parseTimestamp(row.updatedAt) >= updatedAfter);
  const query = text(input.query);
  if (query.length > 0) {
    // Text search shares the request's filter budget: each row costs its compared characters, and values are folded once.
    const env = session.filterEnv();
    const hits = session.searchHits(fold(query));
    let needle;
    rows = rows.filter((row) => {
      // Memoised per (needle, row) for the request: the same term under many aliases searches each issue once.
      const known = hits.get(row);
      if (known !== undefined) return known;
      if (needle === undefined) needle = prepareNeedle(env, fold(query));
      const title = String(row.title ?? "");
      const description = String(row.description ?? "");
      chargeCharacters(env, title.length + description.length);
      const hit = containsText(foldText(env, title, row, "IssueFilter.title"), needle) || containsText(foldText(env, description, row, "IssueFilter.description"), needle);
      hits.set(row, hit);
      return hit;
    });
  }
  if (input.filter !== undefined && input.filter !== null) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("IssueFilter", input.filter, row, env));
  }
  const scope = {
    query, team: input.team ?? null, state: input.state ?? null, assignee: input.assignee ?? null, priority: input.priority ?? null, label: input.label ?? null, project: input.project ?? null,
    cycle: input.cycle ?? null, parentId: input.parentId ?? null, createdAt: input.createdAt ?? null, updatedAt: input.updatedAt ?? null, includeArchived: input.includeArchived === true, filter: input.filter ?? null,
  };
  // `rows` is already in page order (see `session.orderedIssues`).
  return { ...connection(session, rows, paged, "issues", scope), selection };
}

function getIssue(session, input) {
  if (input.includeCustomerNeeds === true || input.includeRelations === true || input.includeReleases === true) {
    return invalidInput(session.context, "Customer needs, relations and releases are not modelled by this Tool");
  }
  return requireIssue(session, input.id);
}

function listComments(session, input) {
  boundFilter(session, "CommentFilter", input.filter);
  rejectUnsupported(session, input, UNSUPPORTED_COMMENT_PARENTS, "comments");
  const paged = paging(session, input);
  let reference = input.issueId;
  const filter = isPlainObject(input.filter) ? { ...input.filter } : null;
  if (filter !== null && isPlainObject(filter.issue)) {
    if (isPlainObject(filter.issue.id) && typeof filter.issue.id.eq === "string") reference = filter.issue.id.eq;
    else return invalidInput(session.context, 'Only "issue: { id: { eq } }" is supported on CommentFilter');
    delete filter.issue;
  }
  if (typeof reference !== "string" || reference.trim().length === 0) return invalidInput(session.context, "Only issue comments are supported: provide issueId");
  const issue = requireIssue(session, reference);
  let rows = session.orderedComments(issue.id, paged.orderBy);
  if (filter !== null && Object.keys(filter).length > 0) {
    const env = session.filterEnv();
    rows = rows.filter((row) => matches("CommentFilter", filter, row, env));
  }
  return connection(session, rows, paged, "comments", { issue: issue.id, filter: input.filter ?? null });
}

/** Nested Issue.comments: oldest first unless an orderBy is given (then descending by that field). */
function issueComments(session, issue, args) {
  const paged = paging(session, args);
  const rows = session.orderedComments(issue.id, args.orderBy === undefined ? "oldest" : paged.orderBy);
  return connection(session, rows, { ...paged, orderBy: args.orderBy === undefined ? "oldest" : paged.orderBy }, `issue-comments/${issue.id}`, null);
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

function requireTitle(session, value, mode) {
  if (value === undefined && mode === "update") return undefined;
  const title = typeof value === "string" ? value.trim() : "";
  if (title.length === 0) return invalidInput(session.context, "Title cannot be empty", ["title"]);
  if (title.length > 255) return invalidInput(session.context, "Title cannot be longer than 255 characters", ["title"]);
  return title;
}

function requirePriority(session, value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 4) return invalidInput(session.context, '"priority" must be an integer from 0 (none) to 4 (low)', ["priority"]);
  return value;
}

function requireEstimate(session, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalidInput(session.context, '"estimate" must be a non-negative number or null', ["estimate"]);
  return value;
}

function requireDate(session, value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isValidDate(value)) return invalidInput(session.context, `"${name}" must be a calendar date formatted YYYY-MM-DD`, [name]);
  return value;
}

function requireDescription(session, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return invalidInput(session.context, '"description" must be a string', ["description"]);
  // The same bound the canonical operations declare (maxLength 65,536), so GraphQL input cannot store larger text.
  if (value.length > 65_536) return invalidInput(session.context, "Description cannot be longer than 65,536 characters", ["description"]);
  return value;
}

function labelRows(session, team, values, spelling) {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) return invalidInput(session.context, "Labels must be a list");
  return values.map((value) => (spelling === "graphql" ? requireLabelById(session, value) : requireLabel(session, team, value)));
}

function requireLabelById(session, id) {
  if (!isUuid(text(id))) return invalidInput(session.context, `Label id "${clipValue(id)}" is not a UUID`);
  const label = session.label(text(id));
  if (label === null || ((label.teamId ?? null) !== null && session.visibleTeam(label.teamId) === null)) return notFound(session.context, "IssueLabel");
  return label;
}

function requireUserById(session, id) {
  if (!isUuid(text(id))) return invalidInput(session.context, `User id "${clipValue(id)}" is not a UUID`);
  const user = session.user(text(id));
  return user === null ? notFound(session.context, "User") : user;
}

function requireProjectById(session, id) {
  const project = session.visibleProject(session.project(text(id)));
  return project === null ? notFound(session.context, "Project") : project;
}

function requireCycleById(session, id) {
  const cycle = session.cycle(text(id));
  return cycle === null || session.visibleTeam(cycle.teamId) === null ? notFound(session.context, "Cycle") : cycle;
}

/**
 * Normalises an issue write into resolved rows. `input` is either GraphQL-shaped (`{ input: {...} }`,
 * refs by id) or MCP-shaped (flat friendly refs). `team` is the issue's team (create: from the
 * input). Returns { team, title, description, state, assignee, priority, estimate, dueDate,
 * labels, addLabels, removeLabels, project, cycle, parent, sortOrder } where undefined means
 * "unchanged" and null means "clear".
 */
function normalizeIssueWrite(session, input, mode, currentTeam) {
  const graphql = input.input !== undefined;
  if (graphql) {
    const friendly = [...FRIENDLY_ISSUE_INPUT, ...UNSUPPORTED_ISSUE_INPUT].filter((name) => input[name] !== undefined);
    if (friendly.length > 0) return invalidInput(session.context, `Cannot combine "input" with "${friendly[0]}" in one call`);
    if (!isPlainObject(input.input)) return invalidInput(session.context, '"input" must be an object', ["input"]);
  } else {
    rejectUnsupported(session, input, UNSUPPORTED_ISSUE_INPUT);
    exclusive(session, input, ["labels"], ["addLabels", "removeLabels"]);
  }
  const body = graphql ? input.input : input;
  if (graphql) {
    for (const key of Object.keys(body)) {
      if (!GRAPHQL_ISSUE_INPUT.has(key)) return invalidInput(session.context, `Unknown field "${clipValue(key)}" on Issue${mode === "create" ? "Create" : "Update"}Input`, ["input", key]);
    }
    if (body.id !== undefined) return invalidInput(session.context, "Client-supplied issue ids are not supported", ["input", "id"]);
    if (mode === "update" && body.teamId !== undefined) return invalidInput(session.context, "Changing an issue's team is not supported", ["input", "teamId"]);
    if (mode === "create" && body.labelIds !== undefined && (body.addedLabelIds !== undefined || body.removedLabelIds !== undefined)) {
      return invalidInput(session.context, 'Cannot combine "labelIds" with "addedLabelIds"/"removedLabelIds"', ["input"]);
    }
  } else if (mode === "update" && body.team !== undefined) {
    return invalidInput(session.context, "Changing an issue's team is not supported", ["team"]);
  }
  let team = currentTeam;
  if (mode === "create") {
    const teamRef = graphql ? body.teamId : body.team;
    if (teamRef === undefined || teamRef === null) return invalidInput(session.context, graphql ? '"teamId" is required' : '"team" is required when creating an issue', [graphql ? "teamId" : "team"]);
    team = graphql ? (isUuid(text(teamRef)) ? session.visibleTeam(text(teamRef)) ?? notFound(session.context, "Team") : invalidInput(session.context, `Team id "${clipValue(teamRef)}" is not a UUID`, ["input", "teamId"])) : requireTeam(session, teamRef);
  }
  const write = { team, title: requireTitle(session, body.title, mode), description: requireDescription(session, body.description) };
  const stateValue = graphql ? body.stateId : body.state;
  if (stateValue !== undefined) {
    if (stateValue === null) return invalidInput(session.context, "State cannot be null", [graphql ? "stateId" : "state"]);
    write.state = requireState(session, team, stateValue);
  }
  const assigneeRef = graphql ? body.assigneeId : body.assignee;
  if (assigneeRef !== undefined) write.assignee = assigneeRef === null ? null : graphql ? requireUserById(session, assigneeRef) : requireUser(session, assigneeRef);
  write.priority = requirePriority(session, body.priority);
  write.estimate = requireEstimate(session, body.estimate);
  write.dueDate = requireDate(session, body.dueDate, "dueDate");
  const spelling = graphql ? "graphql" : "friendly";
  write.labels = labelRows(session, team, graphql ? body.labelIds : body.labels, spelling);
  write.addLabels = labelRows(session, team, graphql ? body.addedLabelIds : body.addLabels, spelling);
  write.removeLabels = labelRows(session, team, graphql ? body.removedLabelIds : body.removeLabels, spelling);
  const projectRef = graphql ? body.projectId : body.project;
  if (projectRef !== undefined) write.project = projectRef === null ? null : graphql ? requireProjectById(session, projectRef) : requireProject(session, projectRef);
  const cycleRef = graphql ? body.cycleId : body.cycle;
  if (cycleRef !== undefined) write.cycle = cycleRef === null ? null : graphql ? requireCycleById(session, cycleRef) : requireCycle(session, team, cycleRef);
  if (body.parentId !== undefined) write.parent = body.parentId === null ? null : requireIssue(session, body.parentId);
  if (body.sortOrder !== undefined) {
    if (typeof body.sortOrder !== "number" || !Number.isFinite(body.sortOrder)) return invalidInput(session.context, '"sortOrder" must be a number', ["sortOrder"]);
    write.sortOrder = body.sortOrder;
  }
  return write;
}

function validateIssueRelations(session, team, write, current) {
  const context = session.context;
  if (write.assignee !== undefined && write.assignee !== null) {
    if (write.assignee.active !== true) return invalidInput(context, `${write.assignee.name} is not an active user`, ["assignee"]);
    if (!isMember(write.assignee, team)) return invalidInput(context, `${write.assignee.name} is not a member of team ${team.key}`, ["assignee"]);
  }
  for (const list of [write.labels, write.addLabels]) {
    for (const label of list ?? []) {
      if ((label.archivedAt ?? null) !== null) return invalidInput(context, `Label "${label.name}" is archived and cannot be applied`, ["labels"]);
      if (label.isGroup === true) return invalidInput(context, `Label "${label.name}" is a group and cannot be applied directly`, ["labels"]);
      if ((label.teamId ?? null) !== null && label.teamId !== team.id) return invalidInput(context, `Label "${label.name}" does not belong to team ${team.key}`, ["labels"]);
    }
  }
  for (const label of write.removeLabels ?? []) {
    if ((label.teamId ?? null) !== null && label.teamId !== team.id) return invalidInput(context, `Label "${label.name}" does not belong to team ${team.key}`, ["removeLabels"]);
  }
  if (write.project !== undefined && write.project !== null) {
    if ((write.project.archivedAt ?? null) !== null) return invalidInput(context, `Project "${write.project.name}" is archived`, ["project"]);
    if (!write.project.teamIds.includes(team.id)) return invalidInput(context, `Project "${write.project.name}" is not available to team ${team.key}`, ["project"]);
  }
  if (write.cycle !== undefined && write.cycle !== null) {
    if (write.cycle.teamId !== team.id) return invalidInput(context, `Cycle ${String(write.cycle.number)} does not belong to team ${team.key}`, ["cycle"]);
    if ((write.cycle.archivedAt ?? null) !== null) return invalidInput(context, `Cycle ${String(write.cycle.number)} is archived`, ["cycle"]);
    if (team.cyclesEnabled !== true) return invalidInput(context, `Team ${team.key} has cycles disabled`, ["cycle"]);
  }
  if (write.parent !== undefined && write.parent !== null) {
    if (current !== null && write.parent.id === current.id) return invalidInput(context, "An issue cannot be its own parent", ["parentId"]);
    if (write.parent.teamId !== team.id) return invalidInput(context, `Parent issue ${write.parent.identifier} is in another team`, ["parentId"]);
    if ((write.parent.archivedAt ?? null) !== null) return invalidInput(context, `Parent issue ${write.parent.identifier} is archived`, ["parentId"]);
    if (current !== null) {
      let ancestor = write.parent;
      for (let hops = 0; ancestor !== null && hops < session.limits.childrenPerIssue; hops += 1) {
        if (ancestor.id === current.id) return invalidInput(context, `Parent issue ${write.parent.identifier} is a descendant of this issue`, ["parentId"]);
        ancestor = session.issue(ancestor.parentId);
      }
    }
  }
  if (write.state !== undefined && current !== null) {
    const currentState = session.state(current.stateId);
    if (write.state.type === "triage" && (currentState === null || currentState.type !== "triage") && write.state.id !== current.stateId) {
      return invalidInput(context, "Issues cannot be moved back into triage", ["state"]);
    }
  }
  return undefined;
}

function stateTimestamps(row, state, now) {
  const timestamps = { startedAt: row.startedAt ?? null, completedAt: null, canceledAt: null };
  if (state.type === "started") timestamps.startedAt = timestamps.startedAt ?? now;
  else if (state.type === "completed") timestamps.completedAt = now;
  else if (state.type === "canceled") timestamps.canceledAt = now;
  else timestamps.startedAt = null;
  return timestamps;
}

function createIssue(session, write) {
  const { context } = session;
  const team = write.team;
  if (session.issues().length >= session.limits.issues) return boundExceeded(context, "issues", session.limits.issues);
  const state = write.state ?? session.state(team.defaultIssueStateId) ?? teamStates(session, team)[0];
  if (state === undefined || state === null) return invalidInput(context, `Team ${team.key} has no workflow states`);
  if (state.teamId !== team.id) return invalidInput(context, `State "${state.name}" does not belong to team ${team.key}`, ["state"]);
  validateIssueRelations(session, team, { ...write, state }, null);
  const labels = write.labels ?? write.addLabels ?? [];
  const now = session.iso;
  const number = team.issueCount + 1;
  const id = nextId(context);
  const row = {
    id,
    teamId: team.id,
    number,
    identifier: `${team.key}-${String(number)}`,
    title: write.title,
    description: write.description ?? null,
    priority: write.priority ?? 0,
    estimate: write.estimate ?? null,
    dueDate: write.dueDate ?? null,
    stateId: state.id,
    assigneeId: write.assignee?.id ?? null,
    creatorId: session.me.id,
    projectId: write.project?.id ?? null,
    cycleId: write.cycle?.id ?? null,
    parentId: write.parent?.id ?? null,
    labelIds: [...new Set(labels.map((label) => label.id))],
    sortOrder: write.sortOrder ?? -number,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...stateTimestamps({ startedAt: null }, state, now),
  };
  session.put("issues", id, row);
  session.put("issue-identifiers", row.identifier, { issueId: id });
  const teamRow = { ...team, issueCount: number, updatedAt: now };
  session.put("teams", team.id, teamRow);
  // The caller can see the team (resolved through visibleTeam), so the new issue and the team row are visible too.
  for (const key of ["issues", "visibleIssues"]) session.store(key, row);
  for (const key of ["teams", "visibleTeams"]) session.store(key, teamRow);
  const lastSyncId = bumpSyncId(context);
  context.events.emit("issue.created", { issueId: id, identifier: row.identifier, teamId: team.id, creatorId: session.me.id, title: row.title, stateId: state.id });
  return { row, lastSyncId };
}

function updateIssue(session, issue, write) {
  const { context } = session;
  if ((issue.archivedAt ?? null) !== null) return invalidInput(context, "Cannot update an archived issue");
  const team = session.team(issue.teamId);
  validateIssueRelations(session, team, write, issue);
  const next = { ...issue };
  const changed = [];
  const set = (field, value) => {
    if (value === undefined) return;
    if (JSON.stringify(next[field] ?? null) !== JSON.stringify(value ?? null)) {
      next[field] = value;
      changed.push(field);
    }
  };
  set("title", write.title);
  set("description", write.description);
  set("priority", write.priority);
  set("estimate", write.estimate);
  set("dueDate", write.dueDate);
  if (write.assignee !== undefined) set("assigneeId", write.assignee === null ? null : write.assignee.id);
  if (write.project !== undefined) set("projectId", write.project === null ? null : write.project.id);
  if (write.cycle !== undefined) set("cycleId", write.cycle === null ? null : write.cycle.id);
  if (write.parent !== undefined) set("parentId", write.parent === null ? null : write.parent.id);
  set("sortOrder", write.sortOrder);
  if (write.labels !== undefined) set("labelIds", [...new Set(write.labels.map((label) => label.id))]);
  else if (write.addLabels !== undefined || write.removeLabels !== undefined) {
    const ids = new Set(Array.isArray(issue.labelIds) ? issue.labelIds : []);
    for (const label of write.addLabels ?? []) ids.add(label.id);
    for (const label of write.removeLabels ?? []) ids.delete(label.id);
    set("labelIds", [...ids]);
  }
  if (write.state !== undefined && write.state.id !== issue.stateId) {
    next.stateId = write.state.id;
    changed.push("stateId");
    Object.assign(next, stateTimestamps(issue, write.state, session.iso));
  }
  if (changed.length === 0) return { row: issue, lastSyncId: currentSyncId(context) };
  next.updatedAt = session.iso;
  session.put("issues", issue.id, next);
  for (const key of ["issues", "visibleIssues"]) session.store(key, next);
  const lastSyncId = bumpSyncId(context);
  context.events.emit("issue.updated", { issueId: issue.id, identifier: issue.identifier, teamId: issue.teamId, actorId: session.me.id, updatedFields: changed });
  return { row: next, lastSyncId };
}

function archiveIssue(session, issue, trash) {
  const { context } = session;
  if (trash === true) return invalidInput(context, "Trashing issues is not supported by this Tool", ["trash"]);
  if ((issue.archivedAt ?? null) !== null) return invalidInput(context, "Issue is already archived");
  const next = { ...issue, archivedAt: session.iso, updatedAt: session.iso };
  session.put("issues", issue.id, next);
  for (const key of ["issues", "visibleIssues"]) session.store(key, next);
  const lastSyncId = bumpSyncId(context);
  context.events.emit("issue.updated", { issueId: issue.id, identifier: issue.identifier, teamId: issue.teamId, actorId: session.me.id, updatedFields: ["archivedAt"] });
  return { row: next, lastSyncId };
}

function requireBody(session, value) {
  if (typeof value !== "string" || value.trim().length === 0) return invalidInput(session.context, "Comment body cannot be empty", ["body"]);
  if (value.length > 65_536) return invalidInput(session.context, "Comment body cannot be longer than 65,536 characters", ["body"]);
  return value;
}

function createComment(session, issue, body, parentRef) {
  const { context } = session;
  if ((issue.archivedAt ?? null) !== null) return invalidInput(context, "Cannot comment on an archived issue");
  let parent = null;
  if (parentRef !== undefined && parentRef !== null) {
    parent = requireComment(session, parentRef);
    if (parent.issueId !== issue.id) return notFound(context, "Comment", ["parentId"]);
    if ((parent.parentId ?? null) !== null) return invalidInput(context, "Replies cannot be nested", ["parentId"]);
  }
  if (session.comments(issue.id).length >= session.limits.commentsPerIssue) return boundExceeded(context, "comments", session.limits.commentsPerIssue);
  const id = nextId(context);
  const row = { id, issueId: issue.id, userId: session.me.id, body, parentId: parent === null ? null : parent.id, createdAt: session.iso, updatedAt: session.iso, editedAt: null };
  session.put("comments", `${issue.id}/${id}`, row);
  const touched = { ...issue, updatedAt: session.iso };
  session.put("issues", issue.id, touched);
  for (const key of ["issues", "visibleIssues"]) session.store(key, touched);
  for (const key of ["allComments", `comments/${issue.id}`]) session.store(key, row, commentRowId);
  const lastSyncId = bumpSyncId(context);
  context.events.emit("comment.created", { commentId: id, issueId: issue.id, identifier: issue.identifier, userId: session.me.id, parentId: row.parentId });
  return { row, lastSyncId };
}

/** Row id of a stored comment (`<issueId>/<commentId>`, see createComment). */
const commentRowId = (row) => `${row.issueId}/${row.id}`;

function updateComment(session, comment, body) {
  const { context } = session;
  if (comment.userId !== session.me.id && session.me.admin !== true) return forbidden(context, "You don't have permission to edit this comment.");
  const next = { ...comment, body, updatedAt: session.iso, editedAt: session.iso };
  session.put("comments", `${comment.issueId}/${comment.id}`, next);
  for (const key of ["allComments", `comments/${comment.issueId}`]) session.store(key, next, commentRowId);
  return { row: next, lastSyncId: bumpSyncId(context) };
}

function createLabel(session, input) {
  const { context } = session;
  const graphql = input.input !== undefined;
  let body = input;
  if (graphql) {
    if (!isPlainObject(input.input)) return invalidInput(context, '"input" must be an object', ["input"]);
    const friendly = ["name", "color", "description", "teamId", "team", "isGroup", "parent", "parentId"].filter((name) => input[name] !== undefined);
    if (friendly.length > 0) return invalidInput(context, `Cannot combine "input" with "${friendly[0]}" in one call`);
    body = input.input;
    for (const key of Object.keys(body)) {
      if (!["name", "color", "description", "teamId", "isGroup", "parentId"].includes(key)) return invalidInput(context, `Unknown field "${clipValue(key)}" on IssueLabelCreateInput`, ["input", key]);
    }
  } else exclusive(session, input, ["team"], ["teamId"]);
  const name = text(body.name);
  if (name.length === 0 || name.length > 255) return invalidInput(context, "Label name must be 1 to 255 characters", ["name"]);
  const color = body.color === undefined || body.color === null ? DEFAULT_LABEL_COLOR : body.color;
  if (typeof color !== "string" || !COLOR_PATTERN.test(color)) return invalidInput(context, 'Label color must be a hex color such as "#eb5757"', ["color"]);
  let team = null;
  if (body.teamId !== undefined && body.teamId !== null) {
    if (!isUuid(text(body.teamId))) return invalidInput(context, `Team id "${clipValue(body.teamId)}" is not a UUID`, ["teamId"]);
    team = session.visibleTeam(text(body.teamId)) ?? notFound(context, "Team");
  } else if (!graphql && body.team !== undefined && body.team !== null) team = requireTeam(session, body.team);
  if (team === null && session.organization.restrictLabelManagementToAdmins === true && session.me.admin !== true) {
    return forbidden(context, "You don't have permission to create workspace labels.");
  }
  const isGroup = body.isGroup === true;
  let parent = null;
  const parentRef = graphql ? body.parentId : body.parentId ?? body.parent;
  if (parentRef !== undefined && parentRef !== null) {
    parent = graphql ? requireLabelById(session, parentRef) : requireLabel(session, team, parentRef);
    if (parent.isGroup !== true) return invalidInput(context, `Label "${parent.name}" is not a group`, ["parentId"]);
    if ((parent.teamId ?? null) !== (team?.id ?? null)) return invalidInput(context, `Parent label "${parent.name}" belongs to another scope`, ["parentId"]);
    if (isGroup) return invalidInput(context, "Label groups cannot be nested", ["parentId"]);
  }
  const labels = session.labels();
  if (labels.length >= session.limits.labels) return boundExceeded(context, "labels", session.limits.labels);
  if (labels.some((row) => (row.teamId ?? null) === (team?.id ?? null) && fold(row.name) === fold(name))) {
    return invalidInput(context, `A label with the name "${clipValue(name)}" already exists`, ["name"]);
  }
  const id = nextId(context);
  const row = {
    id,
    name,
    color,
    description: typeof body.description === "string" ? body.description : null,
    teamId: team === null ? null : team.id,
    isGroup,
    parentId: parent === null ? null : parent.id,
    createdAt: session.iso,
    updatedAt: session.iso,
    archivedAt: null,
  };
  session.put("labels", id, row);
  session.invalidate("labels");
  return { row, lastSyncId: bumpSyncId(context) };
}

function projectTimestamps(row, state, now) {
  const timestamps = { startedAt: row.startedAt ?? null, completedAt: null, canceledAt: null };
  if (state === "started") timestamps.startedAt = timestamps.startedAt ?? now;
  else if (state === "completed") timestamps.completedAt = now;
  else if (state === "canceled") timestamps.canceledAt = now;
  else timestamps.startedAt = null;
  return timestamps;
}

function saveProject(session, input) {
  const { context } = session;
  const graphql = input.input !== undefined;
  let body = input;
  if (graphql) {
    if (!isPlainObject(input.input)) return invalidInput(context, '"input" must be an object', ["input"]);
    const friendly = [...FRIENDLY_PROJECT_INPUT, ...UNSUPPORTED_PROJECT_INPUT].filter((name) => input[name] !== undefined);
    if (friendly.length > 0) return invalidInput(context, `Cannot combine "input" with "${friendly[0]}" in one call`);
    body = input.input;
    for (const key of Object.keys(body)) {
      if (!GRAPHQL_PROJECT_INPUT.has(key)) return invalidInput(context, `Unknown field "${clipValue(key)}" on Project${input.id === undefined ? "Create" : "Update"}Input`, ["input", key]);
    }
  } else {
    rejectUnsupported(session, input, UNSUPPORTED_PROJECT_INPUT);
    exclusive(session, input, ["setTeams"], ["addTeams", "removeTeams"]);
  }
  const mode = input.id === undefined || input.id === null ? "create" : "update";
  if (session.me.guest === true) return forbidden(context, mode === "create" ? "Guests cannot create projects." : "Guests cannot update projects.");
  const current = mode === "update" ? (graphql ? requireProjectById(session, input.id) : requireProject(session, input.id)) : null;
  if (current !== null && !current.teamIds.some((teamId) => isMember(session.me, session.team(teamId) ?? { memberIds: [] }))) {
    return forbidden(context, "You don't have permission to update this project.");
  }
  const write = {};
  if (body.name !== undefined || mode === "create") {
    const name = text(body.name);
    if (name.length === 0 || name.length > 255) return invalidInput(context, "Project name must be 1 to 255 characters", ["name"]);
    write.name = name;
  }
  if (body.description !== undefined) write.description = requireDescription(session, body.description) ?? "";
  if (graphql && body.content !== undefined) write.content = body.content === null ? null : typeof body.content !== "string" ? invalidInput(context, '"content" must be a string', ["content"]) : body.content.length > 65_536 ? invalidInput(context, "Content cannot be longer than 65,536 characters", ["content"]) : body.content;
  if (body.state !== undefined) {
    const state = fold(text(body.state));
    const matching = PROJECT_STATES.find((candidate) => candidate === state || fold(PROJECT_STATES_NAMES[candidate]) === state);
    if (matching === undefined) return invalidInput(context, `Unknown project state "${clipValue(body.state)}"`, ["state"]);
    write.state = matching;
  }
  write.priority = requirePriority(session, body.priority);
  write.startDate = requireDate(session, body.startDate, "startDate");
  write.targetDate = requireDate(session, body.targetDate, "targetDate");
  if (body.icon !== undefined) write.icon = body.icon === null ? null : String(body.icon);
  if (body.color !== undefined) {
    if (body.color !== null && (typeof body.color !== "string" || !COLOR_PATTERN.test(body.color))) return invalidInput(context, 'Project color must be a hex color such as "#5e6ad2"', ["color"]);
    write.color = body.color;
  }
  const leadRef = graphql ? body.leadId : body.lead;
  if (leadRef !== undefined) {
    if (leadRef === null) write.leadId = null;
    else {
      const lead = graphql ? requireUserById(session, leadRef) : requireUser(session, leadRef);
      if (lead.active !== true) return invalidInput(context, `${lead.name} is not an active user`, ["lead"]);
      write.leadId = lead.id;
    }
  }
  let teamIds = current === null ? [] : [...current.teamIds];
  const resolveTeams = (values, name) => {
    if (values === undefined) return undefined;
    if (!Array.isArray(values)) return invalidInput(context, `"${name}" must be a list of team references`, [name]);
    return values.map((value) => (graphql ? (isUuid(text(value)) ? session.visibleTeam(text(value)) ?? notFound(context, "Team") : invalidInput(context, `Team id "${clipValue(value)}" is not a UUID`, [name])) : requireTeam(session, value)).id);
  };
  if (graphql) {
    const ids = resolveTeams(body.teamIds, "teamIds");
    if (ids !== undefined) teamIds = ids;
  } else {
    const setTeams = resolveTeams(body.setTeams, "setTeams");
    const addTeams = resolveTeams(body.addTeams, "addTeams");
    const removeTeams = resolveTeams(body.removeTeams, "removeTeams");
    if (setTeams !== undefined) teamIds = setTeams;
    for (const id of addTeams ?? []) if (!teamIds.includes(id)) teamIds.push(id);
    if (removeTeams !== undefined) teamIds = teamIds.filter((id) => !removeTeams.includes(id));
  }
  teamIds = [...new Set(teamIds)];
  if (teamIds.length === 0) return invalidInput(context, "A project needs at least one team", [graphql ? "teamIds" : "addTeams"]);
  if (mode === "create" && !teamIds.some((teamId) => isMember(session.me, session.team(teamId)))) {
    return forbidden(context, "You don't have permission to create projects for these teams.");
  }
  const now = session.iso;
  if (current === null) {
    if (session.projects().length >= session.limits.projects) return boundExceeded(context, "projects", session.limits.projects);
    const id = nextId(context);
    const state = write.state ?? "backlog";
    const row = {
      id,
      name: write.name,
      slugId: fnv1a(id),
      description: write.description ?? "",
      content: write.content ?? null,
      state,
      priority: write.priority ?? 0,
      leadId: write.leadId ?? null,
      teamIds,
      startDate: write.startDate ?? null,
      targetDate: write.targetDate ?? null,
      icon: write.icon ?? null,
      color: write.color ?? null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      ...projectTimestamps({ startedAt: null }, state, now),
    };
    session.put("projects", id, row);
    session.invalidate("projects");
    return { row, lastSyncId: bumpSyncId(context) };
  }
  const next = { ...current, teamIds };
  for (const [field, value] of Object.entries(write)) if (value !== undefined) next[field] = value;
  if (write.state !== undefined && write.state !== current.state) Object.assign(next, projectTimestamps(current, write.state, now));
  next.updatedAt = now;
  session.put("projects", current.id, next);
  session.invalidate("projects");
  return { row: next, lastSyncId: bumpSyncId(context) };
}

// ---------------------------------------------------------------------------------------------
// Canonical operations
// ---------------------------------------------------------------------------------------------

function issueNodes(session, listed) {
  return {
    nodes: listed.rows.map((row) => {
      const rendered = renderIssue(session, row);
      if (listed.selection === null) return rendered;
      return Object.fromEntries(Object.entries(rendered).filter(([key]) => listed.selection.has(key)));
    }),
    pageInfo: listed.pageInfo,
  };
}

function issuePayload(session, result) {
  return { success: true, lastSyncId: result.lastSyncId, issue: renderIssue(session, result.row) };
}

function commentPayload(session, result) {
  return { success: true, lastSyncId: result.lastSyncId, comment: renderComment(session, result.row) };
}

function saveIssue(session, input) {
  if (input.id === undefined || input.id === null) {
    if (input.team === undefined) return invalidInput(session.context, '"team" is required when creating an issue', ["team"]);
    if (input.removeLabels !== undefined) return invalidInput(session.context, '"removeLabels" is only valid when updating an issue', ["removeLabels"]);
    return createIssue(session, normalizeIssueWrite(session, input, "create", null));
  }
  const issue = requireIssue(session, input.id);
  const write = normalizeIssueWrite(session, { ...input, id: undefined }, "update", session.team(issue.teamId));
  return updateIssue(session, issue, write);
}

function saveComment(session, input) {
  rejectUnsupported(session, input, UNSUPPORTED_COMMENT_PARENTS, "comments");
  const body = requireBody(session, input.body);
  if (input.id !== undefined && input.id !== null) return updateComment(session, requireComment(session, input.id), body);
  if (input.parentId !== undefined && input.parentId !== null) {
    const parent = requireComment(session, input.parentId);
    return createComment(session, requireIssue(session, parent.issueId), body, parent.id);
  }
  if (input.issueId === undefined || input.issueId === null) return invalidInput(session.context, 'Provide "issueId" to start a thread or "parentId" to reply', ["issueId"]);
  return createComment(session, requireIssue(session, input.issueId), body, undefined);
}

function commentInput(session, input) {
  if (input.input !== undefined) {
    if (!isPlainObject(input.input)) return invalidInput(session.context, '"input" must be an object', ["input"]);
    const friendly = ["issueId", "body", "parentId"].filter((name) => input[name] !== undefined);
    if (friendly.length > 0) return invalidInput(session.context, `Cannot combine "input" with "${friendly[0]}" in one call`);
    for (const key of Object.keys(input.input)) if (!["issueId", "body", "parentId"].includes(key)) return invalidInput(session.context, `Unknown field "${clipValue(key)}" on CommentCreateInput`, ["input", key]);
    return input.input;
  }
  return input;
}

const operations = {
  "organization.get": (input, context) => renderOrganization(open(context)),
  "viewer.get": (input, context) => {
    const session = open(context);
    return renderUserFull(session, session.me);
  },
  "users.list": (input, context) => {
    const session = open(context);
    return nodes(session, listUsers(session, input), renderUser);
  },
  "users.get": (input, context) => {
    const session = open(context);
    return renderUserFull(session, getUser(session, input));
  },
  "teams.list": (input, context) => {
    const session = open(context);
    return nodes(session, listTeams(session, input), renderTeam);
  },
  "teams.get": (input, context) => {
    const session = open(context);
    return renderTeamFull(session, getTeam(session, input));
  },
  "workflow-states.list": (input, context) => {
    const session = open(context);
    return nodes(session, listStates(session, input), renderState);
  },
  "labels.list": (input, context) => {
    const session = open(context);
    return nodes(session, listLabels(session, input), renderLabel);
  },
  "labels.create": (input, context) => {
    const session = open(context);
    const result = createLabel(session, input);
    return { success: true, lastSyncId: result.lastSyncId, issueLabel: renderLabel(session, result.row) };
  },
  "projects.list": (input, context) => {
    const session = open(context);
    return nodes(session, listProjects(session, input), renderProject);
  },
  "projects.get": (input, context) => {
    const session = open(context);
    return renderProjectFull(session, getProject(session, input), input);
  },
  "projects.save": (input, context) => {
    const session = open(context);
    const result = saveProject(session, input);
    return { success: true, lastSyncId: result.lastSyncId, project: renderProject(session, result.row) };
  },
  "cycles.list": (input, context) => {
    const session = open(context);
    return nodes(session, listCycles(session, input), renderCycle);
  },
  "issues.list": (input, context) => {
    const session = open(context);
    return issueNodes(session, listIssues(session, input));
  },
  "issues.get": (input, context) => {
    const session = open(context);
    return renderIssueFull(session, getIssue(session, input), input);
  },
  "issues.create": (input, context) => {
    const session = open(context);
    return issuePayload(session, createIssue(session, normalizeIssueWrite(session, input, "create", null)));
  },
  "issues.update": (input, context) => {
    const session = open(context);
    const issue = requireIssue(session, input.id);
    const write = normalizeIssueWrite(session, { ...input, id: undefined }, "update", session.team(issue.teamId));
    return issuePayload(session, updateIssue(session, issue, write));
  },
  "issues.save": (input, context) => {
    const session = open(context);
    return issuePayload(session, saveIssue(session, input));
  },
  "issues.archive": (input, context) => {
    const session = open(context);
    const result = archiveIssue(session, requireIssue(session, input.id), input.trash);
    return { success: true, lastSyncId: result.lastSyncId, entity: renderIssue(session, result.row) };
  },
  "comments.list": (input, context) => {
    const session = open(context);
    return nodes(session, listComments(session, input), renderComment);
  },
  "comments.create": (input, context) => {
    const session = open(context);
    const body = commentInput(session, input);
    if (body.issueId === undefined || body.issueId === null) return invalidInput(context, '"issueId" is required', ["issueId"]);
    return commentPayload(session, createComment(session, requireIssue(session, body.issueId), requireBody(session, body.body), body.parentId));
  },
  "comments.update": (input, context) => {
    const session = open(context);
    const body = input.input !== undefined ? input.input : input;
    if (!isPlainObject(body)) return invalidInput(context, '"input" must be an object', ["input"]);
    return commentPayload(session, updateComment(session, requireComment(session, input.id), requireBody(session, body.body)));
  },
  "comments.save": (input, context) => {
    const session = open(context);
    return commentPayload(session, saveComment(session, input));
  },
  "graphql.execute": (input, context) => {
    const session = open(context);
    return executeGraphql(session, input);
  },
};

// ---------------------------------------------------------------------------------------------
// GraphQL type catalog
// ---------------------------------------------------------------------------------------------

const ref = (type, row) => (row === null || row === undefined ? null : { __type: type, row });
const listOf = (type, rows) => rows.map((row) => ({ __type: type, row }));
/** A GraphQL connection over one page; `cursor(index)` reads the cursors `page()` encoded for exactly these rows. */
const conn = (type, paged) => ({ __type: `${type}Connection`, itemType: type, rows: paged.rows, cursor: (index) => paged.cursors[index], pageInfo: paged.pageInfo });
const PAGING_ARGS = { first: { type: "Int" }, after: { type: "String" }, orderBy: { type: "Enum", enum: ["createdAt", "updatedAt"], enumName: "PaginationOrderBy" } };
const ARCHIVABLE_ARGS = { ...PAGING_ARGS, includeArchived: { type: "Boolean" } };

function scalarFields(names, base) {
  return Object.fromEntries(names.map((name) => [name, { resolve: (parent, args, info) => base(info.executor.session, parent.row)[name] }]));
}

/**
 * One nested connection page per (type, scope, paging arguments) per session: the same field under many parents or
 * aliases (`nodes { a1: team { issues { … } } a2: … }`) loads, orders and pages its rows once. `load` runs only on a
 * miss; writes clear the cache (see `invalidate`).
 */
function cachedPage(session, type, scope, paged, extra, build) {
  const key = `derived/page/${type}\n${scope}\n${String(paged.first)}\n${paged.after ?? ""}\n${paged.orderBy}\n${extra}`;
  return session.cached(key, build);
}

function nestedIssues(session, load, args, scope) {
  const paged = paging(session, args);
  const archived = args.includeArchived === true;
  return cachedPage(session, "Issue", scope, paged, String(archived), () => {
    const rows = load();
    const filtered = archived ? rows : rows.filter((row) => (row.archivedAt ?? null) === null);
    return conn("Issue", orderedConnection(session, filtered, paged, scope, { includeArchived: archived }));
  });
}

function nested(session, type, load, args, scope, ordering) {
  const paged = paging(session, args);
  return cachedPage(session, type, scope, paged, ordering === undefined ? "ordered" : "fixed", () => {
    const rows = load();
    if (ordering === undefined) return conn(type, orderedConnection(session, rows, paged, scope, null));
    return conn(type, connection(session, [...rows].sort(ordering), { ...paged, orderBy: "fixed" }, scope, null));
  });
}

function connectionType(itemType) {
  return {
    fields: {
      nodes: { resolve: (parent) => listOf(parent.itemType, parent.rows) },
      edges: { resolve: (parent) => parent.rows.map((row, index) => ({ __type: `${parent.itemType}Edge`, row, cursor: parent.cursor(index) })) },
      pageInfo: { resolve: (parent) => ({ __type: "PageInfo", row: parent.pageInfo }) },
    },
  };
}

function edgeType(itemType) {
  return { fields: { node: { resolve: (parent) => ({ __type: itemType, row: parent.row }) }, cursor: { resolve: (parent) => parent.cursor } } };
}

function payloadType(entityField, entityType) {
  return {
    fields: {
      success: { resolve: (parent) => parent.success },
      lastSyncId: { resolve: (parent) => parent.lastSyncId },
      [entityField]: { resolve: (parent) => ref(entityType, parent.row) },
    },
  };
}

const CONNECTED = ["User", "Team", "WorkflowState", "IssueLabel", "Project", "Cycle", "Issue", "Comment"];

const SCHEMA = {
  types: {
    Query: {
      fields: {
        viewer: { resolve: (parent, args, info) => ref("User", info.executor.session.me) },
        organization: { resolve: (parent, args, info) => ({ __type: "Organization", row: info.executor.session.organization }) },
        user: { args: { id: { type: "String", required: true } }, resolve: (parent, args, info) => ref("User", getUser(info.executor.session, { id: args.id })) },
        users: { args: { ...PAGING_ARGS, filter: { type: "Object" }, includeDisabled: { type: "Boolean" } }, resolve: (parent, args, info) => conn("User", listUsers(info.executor.session, args)) },
        team: { args: { id: { type: "String", required: true } }, resolve: (parent, args, info) => ref("Team", getTeam(info.executor.session, { id: args.id })) },
        teams: { args: { ...ARCHIVABLE_ARGS, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("Team", listTeams(info.executor.session, args)) },
        workflowStates: { args: { first: PAGING_ARGS.first, after: PAGING_ARGS.after, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("WorkflowState", listStates(info.executor.session, args)) },
        issueLabels: { args: { ...ARCHIVABLE_ARGS, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("IssueLabel", listLabels(info.executor.session, args)) },
        project: { args: { id: { type: "String", required: true } }, resolve: (parent, args, info) => ref("Project", getProject(info.executor.session, { id: args.id })) },
        projects: { args: { ...ARCHIVABLE_ARGS, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("Project", listProjects(info.executor.session, args)) },
        cycles: { args: { first: PAGING_ARGS.first, after: PAGING_ARGS.after, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("Cycle", listCycles(info.executor.session, args)) },
        issue: { args: { id: { type: "String", required: true } }, resolve: (parent, args, info) => ref("Issue", getIssue(info.executor.session, { id: args.id })) },
        issues: { args: { ...ARCHIVABLE_ARGS, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("Issue", listIssues(info.executor.session, args)) },
        searchIssues: {
          args: { term: { type: "String", required: true }, first: PAGING_ARGS.first, after: PAGING_ARGS.after, teamId: { type: "String" }, includeArchived: { type: "Boolean" } },
          resolve: (parent, args, info) => conn("Issue", listIssues(info.executor.session, { query: args.term, first: args.first, after: args.after, includeArchived: args.includeArchived, ...(args.teamId === undefined || args.teamId === null ? {} : { team: args.teamId }) })),
        },
        comments: { args: { ...PAGING_ARGS, filter: { type: "Object" } }, resolve: (parent, args, info) => conn("Comment", listComments(info.executor.session, args)) },
      },
    },
    Mutation: {
      fields: {
        issueCreate: {
          args: { input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const session = info.executor.session;
            const result = createIssue(session, normalizeIssueWrite(session, { input: args.input }, "create", null));
            return { __type: "IssuePayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        issueUpdate: {
          args: { id: { type: "String", required: true }, input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const session = info.executor.session;
            const issue = requireIssue(session, args.id);
            const result = updateIssue(session, issue, normalizeIssueWrite(session, { input: args.input }, "update", session.team(issue.teamId)));
            return { __type: "IssuePayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        issueArchive: {
          args: { id: { type: "String", required: true }, trash: { type: "Boolean" } },
          resolve: (parent, args, info) => {
            const session = info.executor.session;
            const result = archiveIssue(session, requireIssue(session, args.id), args.trash);
            return { __type: "IssueArchivePayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        commentCreate: {
          args: { input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const session = info.executor.session;
            const body = commentInput(session, { input: args.input });
            if (body.issueId === undefined || body.issueId === null) return invalidInput(session.context, '"issueId" is required', ["input", "issueId"]);
            const result = createComment(session, requireIssue(session, body.issueId), requireBody(session, body.body), body.parentId);
            return { __type: "CommentPayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        commentUpdate: {
          args: { id: { type: "String", required: true }, input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const session = info.executor.session;
            const result = updateComment(session, requireComment(session, args.id), requireBody(session, args.input.body));
            return { __type: "CommentPayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        projectCreate: {
          args: { input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const result = saveProject(info.executor.session, { input: args.input });
            return { __type: "ProjectPayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        projectUpdate: {
          args: { id: { type: "String", required: true }, input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const result = saveProject(info.executor.session, { id: args.id, input: args.input });
            return { __type: "ProjectPayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
        issueLabelCreate: {
          args: { input: { type: "Object", required: true } },
          resolve: (parent, args, info) => {
            const result = createLabel(info.executor.session, { input: args.input });
            return { __type: "IssueLabelPayload", success: true, lastSyncId: result.lastSyncId, row: result.row };
          },
        },
      },
    },
    Organization: {
      fields: {
        ...scalarFields(["id", "name", "urlKey", "createdAt", "updatedAt", "userCount", "teamCount", "gitBranchFormat"], (session) => renderOrganization(session)),
        users: { args: { ...PAGING_ARGS, includeDisabled: { type: "Boolean" } }, resolve: (parent, args, info) => conn("User", listUsers(info.executor.session, args)) },
        teams: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => conn("Team", listTeams(info.executor.session, args)) },
        labels: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => conn("IssueLabel", listLabels(info.executor.session, args)) },
      },
    },
    User: {
      fields: {
        ...scalarFields(["id", "name", "displayName", "email", "active", "admin", "guest", "isMe", "avatarUrl", "url", "timezone", "createdAt", "updatedAt"], (session, row) => renderUser(session, row)),
        organization: { resolve: (parent, args, info) => ({ __type: "Organization", row: info.executor.session.organization }) },
        teams: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "Team", () => info.executor.session.visibleTeams().filter((team) => isMember(parent.row, team)), args, `user-teams/${parent.row.id}`) },
        assignedIssues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("assigneeId", parent.row.id), args, `assigned/${parent.row.id}`) },
        createdIssues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("creatorId", parent.row.id), args, `created/${parent.row.id}`) },
      },
    },
    Team: {
      fields: {
        ...scalarFields(["id", "key", "name", "description", "private", "timezone", "cyclesEnabled", "triageEnabled", "issueCount", "createdAt", "updatedAt", "archivedAt"], (session, row) => baseTeam(row)),
        organization: { resolve: (parent, args, info) => ({ __type: "Organization", row: info.executor.session.organization }) },
        members: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "User", () => parent.row.memberIds.map((id) => info.executor.session.user(id)).filter((user) => user !== null), args, `members/${parent.row.id}`, () => 0) },
        states: { args: { first: PAGING_ARGS.first, after: PAGING_ARGS.after }, resolve: (parent, args, info) => nested(info.executor.session, "WorkflowState", () => teamStates(info.executor.session, parent.row), args, `states/${parent.row.id}`, (left, right) => left.position - right.position || compareStrings(left.id, right.id)) },
        labels: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "IssueLabel", () => info.executor.session.labels().filter((label) => label.teamId === parent.row.id && (args.includeArchived === true || (label.archivedAt ?? null) === null)), args, `team-labels/${parent.row.id}/${args.includeArchived === true}`) },
        projects: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "Project", () => info.executor.session.projects().filter((project) => project.teamIds.includes(parent.row.id) && (args.includeArchived === true || (project.archivedAt ?? null) === null)), args, `team-projects/${parent.row.id}/${args.includeArchived === true}`) },
        cycles: { args: { first: PAGING_ARGS.first, after: PAGING_ARGS.after }, resolve: (parent, args, info) => conn("Cycle", listCycles(info.executor.session, { teamId: parent.row.id, first: args.first, after: args.after })) },
        issues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("teamId", parent.row.id), args, `team-issues/${parent.row.id}`) },
        activeCycle: { resolve: (parent, args, info) => ref("Cycle", activeCycle(info.executor.session, parent.row)) },
        defaultIssueState: { resolve: (parent, args, info) => ref("WorkflowState", info.executor.session.state(parent.row.defaultIssueStateId)) },
      },
    },
    WorkflowState: {
      fields: {
        ...scalarFields(["id", "name", "type", "color", "position", "description", "createdAt", "updatedAt", "archivedAt"], (session, row) => baseState(row)),
        team: { resolve: (parent, args, info) => ref("Team", info.executor.session.team(parent.row.teamId)) },
        issues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("stateId", parent.row.id), args, `state-issues/${parent.row.id}`) },
      },
    },
    IssueLabel: {
      fields: {
        ...scalarFields(["id", "name", "color", "description", "isGroup", "createdAt", "updatedAt", "archivedAt"], (session, row) => baseLabel(row)),
        team: { resolve: (parent, args, info) => ref("Team", info.executor.session.team(parent.row.teamId)) },
        parent: { resolve: (parent, args, info) => ref("IssueLabel", info.executor.session.label(parent.row.parentId)) },
        children: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "IssueLabel", () => info.executor.session.labels().filter((label) => label.parentId === parent.row.id), args, `label-children/${parent.row.id}`) },
        issues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("labelIds", parent.row.id), args, `label-issues/${parent.row.id}`) },
      },
    },
    Project: {
      fields: {
        ...scalarFields(["id", "name", "slugId", "url", "description", "content", "state", "priority", "priorityLabel", "progress", "startDate", "targetDate", "createdAt", "updatedAt", "archivedAt", "startedAt", "completedAt", "canceledAt"], (session, row) => renderProject(session, row)),
        status: { resolve: (parent, args, info) => ({ __type: "ProjectStatus", row: renderProject(info.executor.session, parent.row).status }) },
        lead: { resolve: (parent, args, info) => ref("User", info.executor.session.user(parent.row.leadId)) },
        teams: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "Team", () => parent.row.teamIds.map((id) => info.executor.session.visibleTeam(id)).filter((team) => team !== null), args, `project-teams/${parent.row.id}`, () => 0) },
        issues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("projectId", parent.row.id), args, `project-issues/${parent.row.id}`) },
        members: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "User", () => [...new Set(parent.row.teamIds.flatMap((id) => info.executor.session.visibleTeam(id)?.memberIds ?? []))].map((id) => info.executor.session.user(id)).filter((user) => user !== null), args, `project-members/${parent.row.id}`) },
      },
    },
    ProjectStatus: { fields: scalarFields(["id", "name", "type"], (session, row) => row) },
    Cycle: {
      fields: {
        ...scalarFields(["id", "number", "name", "description", "startsAt", "endsAt", "completedAt", "isActive", "isFuture", "isPast", "progress", "createdAt", "updatedAt", "archivedAt"], (session, row) => renderCycle(session, row)),
        team: { resolve: (parent, args, info) => ref("Team", info.executor.session.team(parent.row.teamId)) },
        issues: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nestedIssues(info.executor.session, () => info.executor.session.issuesWhere("cycleId", parent.row.id), args, `cycle-issues/${parent.row.id}`) },
      },
    },
    Issue: {
      fields: {
        ...scalarFields(["id", "identifier", "number", "title", "description", "priority", "priorityLabel", "estimate", "dueDate", "url", "branchName", "sortOrder", "createdAt", "updatedAt", "archivedAt", "startedAt", "completedAt", "canceledAt"], (session, row) => renderIssue(session, row)),
        team: { resolve: (parent, args, info) => ref("Team", info.executor.session.team(parent.row.teamId)) },
        state: { resolve: (parent, args, info) => ref("WorkflowState", info.executor.session.state(parent.row.stateId)) },
        assignee: { resolve: (parent, args, info) => ref("User", info.executor.session.user(parent.row.assigneeId)) },
        creator: { resolve: (parent, args, info) => ref("User", info.executor.session.user(parent.row.creatorId)) },
        project: { resolve: (parent, args, info) => ref("Project", info.executor.session.project(parent.row.projectId)) },
        cycle: { resolve: (parent, args, info) => ref("Cycle", info.executor.session.cycle(parent.row.cycleId)) },
        parent: { resolve: (parent, args, info) => ref("Issue", info.executor.session.issue(parent.row.parentId)) },
        children: { args: ARCHIVABLE_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "Issue", () => info.executor.session.issuesWhere("parentId", parent.row.id).filter((row) => (args.includeArchived === true || (row.archivedAt ?? null) === null)), args, `children/${parent.row.id}/${args.includeArchived === true}`, (left, right) => left.number - right.number) },
        labels: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "IssueLabel", () => info.executor.session.labelsOf(parent.row), args, `issue-labels/${parent.row.id}`, (left, right) => compareStrings(left.name, right.name)) },
        comments: { args: PAGING_ARGS, resolve: (parent, args, info) => conn("Comment", issueComments(info.executor.session, parent.row, args)) },
      },
    },
    Comment: {
      fields: {
        ...scalarFields(["id", "body", "url", "createdAt", "updatedAt", "editedAt", "quotedText"], (session, row) => renderComment(session, row)),
        user: { resolve: (parent, args, info) => ref("User", info.executor.session.user(parent.row.userId)) },
        issue: { resolve: (parent, args, info) => ref("Issue", info.executor.session.issue(parent.row.issueId)) },
        parent: { resolve: (parent, args, info) => ref("Comment", parent.row.parentId === null || parent.row.parentId === undefined ? null : info.executor.session.comments(parent.row.issueId).find((row) => row.id === parent.row.parentId) ?? null) },
        children: { args: PAGING_ARGS, resolve: (parent, args, info) => nested(info.executor.session, "Comment", () => info.executor.session.comments(parent.row.issueId).filter((row) => row.parentId === parent.row.id), args, `replies/${parent.row.id}`, (left, right) => parseTimestamp(left.createdAt) - parseTimestamp(right.createdAt) || compareStrings(left.id, right.id)) },
      },
    },
    PageInfo: { fields: scalarFields(["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"], (session, row) => row) },
    IssuePayload: payloadType("issue", "Issue"),
    IssueArchivePayload: payloadType("entity", "Issue"),
    CommentPayload: payloadType("comment", "Comment"),
    ProjectPayload: payloadType("project", "Project"),
    IssueLabelPayload: payloadType("issueLabel", "IssueLabel"),
    ...Object.fromEntries(CONNECTED.map((type) => [`${type}Connection`, connectionType(type)])),
    ...Object.fromEntries(CONNECTED.map((type) => [`${type}Edge`, edgeType(type)])),
  },
};

function executeGraphql(session, input) {
  const { context } = session;
  try {
    const document = parse(input.query);
    const { operation, fragments } = selectOperation(document, input.operationName ?? undefined);
    const variables = coerceVariables(operation, fragments, input.variables ?? {});
    const executed = execute(operation, fragments, variables, { types: SCHEMA.types, session });
    return { data: executed.data, rateLimit: rateLimitMeta(session.nowMs), complexity: executed.complexity };
  } catch (error) {
    if (error instanceof GraphQLError) {
      const options = { path: error.path === undefined || error.path.length === 0 ? undefined : error.path, rateLimit: rateLimitMeta(session.nowMs) };
      return error.kind === "not_implemented" ? notImplemented(context, error.message, options.path) : graphqlValidation(context, error.message, options.path);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Wire codec: POST /graphql
// ---------------------------------------------------------------------------------------------

function errorCode(outcome) {
  return String(outcome.error?.code ?? "").replace(/^tool\./, "");
}

function rateLimitHeaders(meta, limited) {
  const headers = {
    "x-ratelimit-requests-limit": String(meta?.requestsLimit ?? 1500),
    "x-ratelimit-requests-remaining": limited ? "0" : String(meta?.requestsRemaining ?? 1499),
  };
  if (meta?.requestsReset !== undefined) headers["x-ratelimit-requests-reset"] = String(meta.requestsReset);
  if (limited) headers["retry-after"] = "60";
  return headers;
}

function linearErrors(outcome) {
  const error = outcome.error ?? {};
  const details = isPlainObject(error.details) ? error.details : {};
  if (Array.isArray(details.errors) && details.errors.length > 0) return details.errors;
  const message = boundMessage(error.message);
  if (outcome.status === "denied") return [{ message: "Not authorized", extensions: { type: "forbidden", userError: false } }];
  // The framework rejected the request before the handler ran (e.g. a body failing the input schema): still a
  // complete Linear entry, with the declared INVALID_INPUT code.
  if (outcome.status === "invalid") return [errorEntry("INVALID_INPUT", message)];
  if (outcome.status === "unsupported") return [{ message, extensions: { type: "graphql error", userError: false } }];
  const code = errorCode(outcome);
  if (code.length > 0) return [errorEntry(code, message, { userError: false })];
  return [{ message, extensions: { type: "internal error", userError: false } }];
}

/**
 * Nesting bound for the JSON body of `POST /graphql`, checked iteratively in `decode`. Without it a body nested about 3,000
 * levels passes the framework's body parser but overflows the stack in the recursive argument validation that follows, which
 * the framework answers with an opaque 500. A deeper body is replaced by a shallow marker argument; the input schema rejects it
 * (no recursion over the caller value) and `encode` answers Linear's INVALID_INPUT naming the bound.
 */
const MAX_BODY_DEPTH = 512;
const BODY_DEPTH_MARKER = "requestBodyNestingDepthExceeded";

function bodyTooDeep(outcome, invocation) {
  const args = invocation?.arguments;
  return outcome.status === "invalid" && isPlainObject(args) && Object.keys(args).length === 1 && args[BODY_DEPTH_MARKER] === MAX_BODY_DEPTH;
}

const http = {
  graphql: {
    decode: (request) => {
      const body = request.body.kind === "json" && isPlainObject(request.body.value) ? request.body.value : {};
      if (exceedsDepth(body, MAX_BODY_DEPTH)) return { arguments: { [BODY_DEPTH_MARKER]: MAX_BODY_DEPTH } };
      return { arguments: body };
    },
    encode: ({ outcome, invocation }) => {
      if (outcome.status === "ok" && isPlainObject(outcome.value)) {
        return {
          headers: { ...rateLimitHeaders(outcome.value.rateLimit, false), "x-complexity": String(outcome.value.complexity ?? 0) },
          body: { kind: "json", value: { data: outcome.value.data } },
        };
      }
      const details = isPlainObject(outcome.error?.details) ? outcome.error.details : {};
      const limited = errorCode(outcome) === "RATELIMITED";
      return {
        headers: { ...rateLimitHeaders(details.rateLimit, limited), "x-complexity": "0" },
        body: { kind: "json", value: { errors: bodyTooDeep(outcome, invocation) ? [errorEntry("INVALID_INPUT", `Request body nests JSON objects and arrays deeper than the maximum depth of ${String(MAX_BODY_DEPTH)}.`)] : linearErrors(outcome) } },
      };
    },
  },
};

export default { operations, http };
