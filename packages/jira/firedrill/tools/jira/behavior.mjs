// Synthetic Jira Cloud site. Every operation computes from context.state: issue ids come from the
// `meta/counters` row, keys from each project's counter, timestamps from the virtual clock and
// visibility from the calling actor's Atlassian account and project roles. Nothing here contacts
// Atlassian; no notification is ever sent.
import { adfText, coerceBody, textToAdf } from "./lib/adf.mjs";
import { RESPONSE_BUDGET, TEXT_LIMIT, TEXT_TOO_LONG, fillByBytes, jsonBytes, textFieldLength } from "./lib/budget.mjs";
import { JqlError, compileJql, normalizeJql } from "./lib/jql.mjs";
import { canBrowse, canWrite, isAdministrator, isAssignable, projectRoles, resolveIdentity, roleOf } from "./lib/permissions.mjs";
import {
  ALL_FIELDS,
  FIELD_NAMES,
  RESOLUTIONS,
  renderBoard,
  renderComment,
  renderIssue,
  renderIssueType,
  renderPriority,
  renderProject,
  renderResolution,
  renderSprint,
  renderStatus,
  renderUser,
  selectFields,
  stripAbsentParent,
} from "./lib/render.mjs";
import {
  allRows,
  boundExceeded,
  clip,
  fail,
  commentRowId,
  compareFold,
  fieldError,
  invalidJql,
  isNumericId,
  isPlainObject,
  jiraNow,
  nextCommentId,
  nextIssueId,
  notFound,
  nowMs,
  padId,
  permissionDenied,
  prefixRows,
  siteOf,
  validationError,
} from "./lib/state.mjs";
import { bool, defined, int, jiraError, jsonBody, list, operationInput, responseHeaders, str } from "./lib/wire.mjs";

const DEFINITION_BOUND = 1000;
const ISSUE_NOT_FOUND = "Issue does not exist or you do not have permission to see it.";
const SCOPES = Object.freeze(["read:jira-work", "write:jira-work", "read:jira-user", "manage:jira-project", "offline_access"]);
const CREATE_FIELDS = new Set(["project", "issuetype", "summary", "description", "priority", "assignee", "reporter", "labels", "parent", "duedate"]);
const EDIT_FIELDS = new Set(["summary", "description", "priority", "assignee", "reporter", "labels", "parent", "duedate"]);
const FLATTENED_KEYS = ["projectKey", "issueTypeName", "summary", "description", "assignee_account_id", "additional_fields"];
const ADF_MESSAGE = "Operation value must be an Atlassian Document (see the Atlassian Document Format)";
const DEFAULT_PRIORITY_ID = "3";
const DEFAULT_RESOLUTION_ID = "10000";

// ---------------------------------------------------------------------------------------------
// Session: identity first, then lazily loaded (bounded) reference data
// ---------------------------------------------------------------------------------------------

function open(context, input) {
  const site = siteOf(context);
  const me = resolveIdentity(context, site);
  if (typeof input.cloudId === "string" && input.cloudId !== site.cloudId) {
    return notFound(context, `No Atlassian site could be found with cloud id '${input.cloudId}'.`);
  }
  const cache = new Map();
  const session = {
    context,
    site,
    base: site.baseUrl,
    limits: site.limits,
    me,
    now: () => jiraNow(context),
    cached(key, load) {
      if (!cache.has(key)) cache.set(key, load());
      return cache.get(key);
    },
  };
  session.users = () => session.cached("users", () => allRows(context, "users", site.limits.maxUsers));
  session.projects = () => session.cached("projects", () => allRows(context, "projects", site.limits.maxProjects));
  session.statuses = () => session.cached("statuses", () => allRows(context, "statuses", DEFINITION_BOUND));
  session.priorities = () =>
    session.cached("priorities", () => allRows(context, "priorities", DEFINITION_BOUND).sort((left, right) => Number(left.id) - Number(right.id)));
  session.issueTypes = () => session.cached("issue-types", () => allRows(context, "issue-types", DEFINITION_BOUND));
  session.workflows = () => session.cached("workflows", () => allRows(context, "workflows", DEFINITION_BOUND));
  session.sprints = () => session.cached("sprints", () => allRows(context, "sprints", site.limits.maxSprints));
  session.boards = () => session.cached("boards", () => allRows(context, "boards", site.limits.maxBoards));
  session.issues = () => session.cached("issues", () => allRows(context, "issues", site.limits.maxIssues));
  session.roles = (project) => session.cached(`roles/${project.id}`, () => projectRoles(context, site, project));
  session.comments = (issueId) => prefixRows(context, "comments", `${padId(issueId)}/`, site.limits.maxCommentsPerIssue);
  session.user = (accountId) => (accountId === null || accountId === undefined ? null : context.state.get("users", accountId));
  session.status = (id) => session.statuses().find((row) => row.id === id) ?? { id, name: "Unknown", description: "", statusCategoryId: 2 };
  session.priority = (id) => session.priorities().find((row) => row.id === id) ?? { id, name: "Unknown", description: "", statusColor: "#000000", iconName: "medium" };
  session.issueType = (id) => session.issueTypes().find((row) => row.id === id) ?? { id, name: "Unknown", description: "", subtask: false, hierarchyLevel: 0, iconId: "0" };
  session.project = (id) => context.state.get("projects", padId(id));
  session.workflow = (project) => session.workflows().find((row) => row.id === project.workflowId) ?? null;
  return session;
}

function roleFor(session, project) {
  return roleOf(session.roles(project), session.me.accountId);
}

function browsable(session, project) {
  return project !== null && canBrowse(project, roleFor(session, project));
}

function requireWrite(session, project, message) {
  return canWrite(project, roleFor(session, project)) ? project : permissionDenied(session.context, message);
}

function requireAdmin(session, project, message) {
  return isAdministrator(roleFor(session, project)) ? project : permissionDenied(session.context, message);
}

/** A visible project by id or key (case-insensitive key), or null. */
function findProject(session, value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return null;
  const project = isNumericId(text) ? session.project(text) : (session.projects().find((row) => row.key.toLowerCase() === text.toLowerCase()) ?? null);
  return browsable(session, project) ? project : null;
}

function requireProject(session, value) {
  const project = findProject(session, value);
  if (project !== null) return project;
  const text = String(value ?? "");
  return notFound(session.context, isNumericId(text) ? `No project could be found with id '${text}'.` : `No project could be found with key '${text}'.`);
}

/** A visible issue by numeric id or key, or null. */
function findIssue(session, value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return null;
  const issue = isNumericId(text)
    ? session.context.state.get("issues", padId(text))
    : (session.issues().find((row) => row.key.toLowerCase() === text.toLowerCase()) ?? null);
  if (issue === null) return null;
  return browsable(session, session.project(issue.projectId)) ? issue : null;
}

function requireIssue(session, value) {
  const issue = findIssue(session, value);
  return issue === null ? notFound(session.context, ISSUE_NOT_FOUND) : issue;
}

function saveIssue(session, issue) {
  session.context.state.put("issues", padId(issue.id), issue);
}

function issueSelf(session, issue) {
  return `${session.base}/rest/api/3/issue/${issue.id}`;
}

function projectOf(session, issue) {
  return session.project(issue.projectId);
}

function transitionsFor(session, issue) {
  const workflow = session.workflow(projectOf(session, issue));
  if (workflow === null) return [];
  return workflow.transitions
    .filter((transition) => transition.from.length === 0 || transition.from.includes(issue.statusId))
    .map((transition) => ({
      id: transition.id,
      name: transition.name,
      to: renderStatus(session.base, session.status(transition.to)),
      hasScreen: false,
      isGlobal: transition.from.length === 0,
      isInitial: false,
      isAvailable: true,
      isConditional: false,
      isLooped: transition.to === issue.statusId,
    }));
}

/** Lookups the renderer needs for one issue bean. */
function refsFor(session) {
  return {
    user: (id) => session.user(id),
    project: (id) => session.project(id),
    status: (id) => session.status(id),
    priority: (id) => session.priority(id),
    issueType: (id) => session.issueType(id),
    sprint: (id) => session.sprints().find((row) => row.id === id) ?? null,
    parentOf: (issue) => (issue.parentId === null ? null : session.context.state.get("issues", padId(issue.parentId))),
    subtasksOf: (issue) => session.issues().filter((row) => row.parentId === issue.id && session.issueType(row.issueTypeId).subtask),
    commentsOf: (issue) => session.comments(issue.id),
    transitionsOf: (issue) => transitionsFor(session, issue),
  };
}

/**
 * One issue bean within `budget` encoded bytes where possible: the inline `comment` field keeps as
 * many comments as fit (`maxResults` then says how many are inline, `total` how many exist; the rest
 * are paged with comments.list). A bean still over budget is left to the caller's too-large error.
 */
function issueBean(session, issue, fields, expand, budget = RESPONSE_BUDGET) {
  const bean = stripAbsentParent(renderIssue(session.base, issue, refsFor(session), { fields, expand }));
  const inline = bean.fields.comment;
  if (inline === undefined || jsonBytes(bean) <= budget) return bean;
  const all = inline.comments;
  inline.comments = [];
  inline.maxResults = 0;
  const { values } = fillByBytes(all, (comment) => comment, jsonBytes(bean) + 8, budget);
  inline.comments = values;
  inline.maxResults = values.length;
  return bean;
}

function tooLarge(context, what, bytes) {
  return validationError(context, {}, [
    `The ${what} is too large to return (${String(bytes)} bytes; the response limit is ${String(RESPONSE_BUDGET)} bytes). Request fewer fields, for example without 'subtasks', 'labels' or 'description'.`,
  ]);
}

/** Unpaged responses built only from site definitions: over budget is a state bound, never an oversized body. */
function withinBudget(context, value) {
  const bytes = jsonBytes(value);
  if (bytes > RESPONSE_BUDGET) return fail(context, "FAILED_PRECONDITION", `the response of ${String(bytes)} bytes exceeds the supported bound of ${String(RESPONSE_BUDGET)} bytes`);
  return value;
}

function expandSet(value) {
  return new Set(Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : []);
}

function emitUpdated(session, issue, changedFields, transition) {
  session.context.events.emit("issue.updated", {
    issueId: issue.id,
    key: issue.key,
    projectKey: projectOf(session, issue).key,
    actorAccountId: session.me.accountId,
    changedFields,
    ...(transition === undefined ? {} : { transition }),
  });
}

function insertComment(session, issue, body, now) {
  const id = nextCommentId(session.context);
  const comment = {
    id,
    issueId: issue.id,
    authorAccountId: session.me.accountId,
    updateAuthorAccountId: session.me.accountId,
    body,
    created: now,
    updated: now,
    jsdPublic: true,
  };
  session.context.state.put("comments", commentRowId(issue.id, id), comment);
  session.context.events.emit("comment.created", { issueId: issue.id, key: issue.key, commentId: id, authorAccountId: session.me.accountId });
  return comment;
}

// ---------------------------------------------------------------------------------------------
// Paging and shared validation
// ---------------------------------------------------------------------------------------------

function paging(session, input, maxLimit, defaultLimit) {
  const startAt = input.startAt === undefined ? 0 : input.startAt;
  const maxResults = input.maxResults === undefined ? defaultLimit : input.maxResults;
  if (!Number.isInteger(startAt) || startAt < 0) return validationError(session.context, {}, ["The 'startAt' parameter must be zero or greater."]);
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > maxLimit) {
    return validationError(session.context, {}, [`The 'maxResults' parameter must be between 1 and ${String(maxLimit)}.`]);
  }
  return { startAt, maxResults };
}

function includes(haystack, needle) {
  return String(haystack).toLowerCase().includes(needle.toLowerCase());
}

function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return !Number.isNaN(ms) && new Date(ms).getUTCMonth() === Number(match[2]) - 1 && new Date(ms).getUTCDate() === Number(match[3]);
}

function refId(value, keys) {
  if (!isPlainObject(value)) return undefined;
  for (const key of keys) if (typeof value[key] === "string" && value[key].length > 0) return { key, value: value[key] };
  return undefined;
}

function normalizeLabels(session, labels, errors) {
  const set = new Set();
  for (const label of labels) {
    if (typeof label !== "string" || label.trim().length === 0) {
      errors.labels = "Labels must be non-empty strings.";
      continue;
    }
    if (/\s/.test(label)) {
      errors.labels = `The label '${clip(label)}' contains spaces which is invalid.`;
      continue;
    }
    if (label.length > 255) {
      errors.labels = `The label '${label.slice(0, 20)}…' exceeds 255 characters.`;
      continue;
    }
    set.add(label);
  }
  return [...set].sort();
}

function resolveAssignee(session, project, value, errors, field = "assignee") {
  if (value === null) return null;
  const ref = refId(value, ["accountId", "id"]);
  if (ref === undefined) {
    errors[field] = `Specify an account id for the ${field}.`;
    return undefined;
  }
  const user = session.user(ref.value);
  if (user === null) {
    errors[field] = `User '${clip(ref.value)}' does not exist.`;
    return undefined;
  }
  if (!isAssignable(project, session.roles(project), user)) {
    errors[field] = `User '${user.displayName}' cannot be assigned issues.`;
    return undefined;
  }
  return user.accountId;
}

function resolvePriority(session, value, errors) {
  const ref = refId(value, ["id", "name"]);
  if (ref === undefined) {
    errors.priority = "Specify a priority id or name.";
    return undefined;
  }
  const priority = session.priorities().find((row) => (ref.key === "id" ? row.id === ref.value : row.name.toLowerCase() === ref.value.toLowerCase()));
  if (priority === undefined) {
    errors.priority = `Priority ${ref.key} '${clip(ref.value)}' is not valid`;
    return undefined;
  }
  return priority.id;
}

function resolveParent(session, project, issueType, value, errors, self) {
  if (value === null) {
    if (issueType.subtask) errors.parent = "Subtask work items require a parent.";
    return null;
  }
  const ref = refId(value, ["id", "key"]);
  if (ref === undefined) {
    errors.parent = "Specify a parent id or key.";
    return undefined;
  }
  const parent = findIssue(session, ref.value);
  if (parent === null) {
    errors.parent = ISSUE_NOT_FOUND;
    return undefined;
  }
  const parentType = session.issueType(parent.issueTypeId);
  if (parent.projectId !== project.id || parentType.hierarchyLevel !== issueType.hierarchyLevel + 1 || (self !== undefined && parent.id === self)) {
    errors.parent = "Given parent work item does not belong to appropriate hierarchy.";
    return undefined;
  }
  return parent.id;
}

function resolveDescription(value, errors) {
  if (value === null) return null;
  if (typeof value === "string" && value.length > TEXT_LIMIT) {
    errors.description = TEXT_TOO_LONG;
    return undefined;
  }
  if (typeof value === "string") return value.trim().length === 0 ? null : textToAdf(value);
  const body = coerceBody(value);
  if (body.error === "malformed") {
    errors.description = ADF_MESSAGE;
    return undefined;
  }
  if (body.error === "empty") return null;
  if (textFieldLength(value, body.doc) > TEXT_LIMIT) {
    errors.description = TEXT_TOO_LONG;
    return undefined;
  }
  return body.doc;
}

function labelUpdates(session, current, operations, errors) {
  let labels = [...current];
  if (operations === undefined) return labels;
  if (!Array.isArray(operations)) {
    errors.labels = "update.labels must be an array of add/remove operations.";
    return labels;
  }
  for (const operation of operations) {
    if (!isPlainObject(operation)) continue;
    if (typeof operation.add === "string") labels = normalizeLabels(session, [...labels, operation.add], errors);
    if (typeof operation.remove === "string") labels = labels.filter((label) => label !== operation.remove);
  }
  return labels;
}

/** Comments added through `update.comment` respect the same per-issue bound as comments.add. */
function requireCommentRoom(session, issue, adding) {
  if (adding === 0) return;
  const bound = session.limits.maxCommentsPerIssue;
  if (session.comments(issue.id).length + adding > bound) boundExceeded(session.context, "comments", bound);
}

function commentAdds(operations, errors) {
  const bodies = [];
  if (operations === undefined) return bodies;
  if (!Array.isArray(operations)) {
    errors.comment = "update.comment must be an array of add operations.";
    return bodies;
  }
  for (const operation of operations) {
    if (!isPlainObject(operation) || !isPlainObject(operation.add)) {
      errors.comment = "Only 'add' comment operations are supported.";
      continue;
    }
    const raw = operation.add.body;
    const body = typeof raw === "string" && raw.length > TEXT_LIMIT ? { error: "long" } : coerceBody(raw);
    if (body.error === "empty") errors.comment = "Comment body can not be empty!";
    else if (body.error === "malformed") errors.comment = ADF_MESSAGE;
    else if (body.error === "long" || textFieldLength(raw, body.doc) > TEXT_LIMIT) errors.comment = TEXT_TOO_LONG;
    else bodies.push(body.doc);
  }
  return bodies;
}

// ---------------------------------------------------------------------------------------------
// Site, identity and metadata
// ---------------------------------------------------------------------------------------------

function resourcesList(input, context) {
  const session = open(context, input);
  return [
    {
      id: session.site.cloudId,
      url: session.base,
      name: session.site.name,
      scopes: [...SCOPES],
      avatarUrl: `${session.base}/rest/api/3/universal_avatar/view/type/project/avatar/10400?size=medium`,
    },
  ];
}

function myselfGet(input, context) {
  const session = open(context, input);
  return {
    ...renderUser(session.base, session.me),
    expand: "groups,applicationRoles",
    groups: { size: 0, items: [] },
    applicationRoles: { size: 1, items: [{ key: "jira-software", name: "Jira Software" }] },
  };
}

function serverInfoGet(input, context) {
  const session = open(context, input);
  return {
    baseUrl: session.base,
    version: "1001.0.0-SNAPSHOT",
    versionNumbers: [1001, 0, 0],
    deploymentType: "Cloud",
    buildNumber: 100312,
    buildDate: "2026-09-01T00:00:00.000+0000",
    serverTime: session.now(),
    scmInfo: "0000000000000000000000000000000000000000",
    serverTitle: session.site.serverTitle,
    defaultLocale: { locale: session.site.locale },
    serverTimeZone: session.site.timeZone,
  };
}

function projectBean(session, project, withIssueTypes) {
  const bean = renderProject(session.base, project, session.user(project.leadAccountId));
  if (withIssueTypes) bean.issueTypes = project.issueTypeIds.map((id) => renderIssueType(session.base, session.issueType(id)));
  return bean;
}

function visibleProjects(session) {
  return session.projects().filter((project) => browsable(session, project));
}

function projectsSearch(input, context) {
  const session = open(context, input);
  const page = paging(session, input, 100, 50);
  const query = typeof input.query === "string" ? input.query : typeof input.searchString === "string" ? input.searchString : "";
  const orderBy = input.orderBy ?? "key";
  const action = input.action ?? "view";
  if (!["key", "-key", "+key", "name", "-name", "+name"].includes(orderBy)) return validationError(context, {}, [`The 'orderBy' parameter '${orderBy}' is invalid.`]);
  if (input.typeKey !== undefined && !["software", "business"].includes(input.typeKey)) {
    return validationError(context, {}, [`The project type key '${input.typeKey}' is invalid.`]);
  }
  if (!["view", "browse", "edit", "create"].includes(action)) return validationError(context, {}, [`The 'action' parameter '${action}' is invalid.`]);
  const keys = Array.isArray(input.keys) ? input.keys.map((key) => String(key).toLowerCase()) : null;
  const expand = expandSet(input.expand);
  const matches = visibleProjects(session).filter((project) => {
    if (query.length > 0 && !includes(project.key, query) && !includes(project.name, query)) return false;
    if (keys !== null && !keys.includes(project.key.toLowerCase())) return false;
    if (input.typeKey !== undefined && project.projectTypeKey !== input.typeKey) return false;
    if ((action === "edit" || action === "create") && !canWrite(project, roleFor(session, project))) return false;
    return true;
  });
  const field = orderBy.replace(/^[-+]/, "");
  const sign = orderBy.startsWith("-") ? -1 : 1;
  matches.sort((left, right) => compareFold(left[field], right[field]) * sign || Number(left.id) - Number(right.id));
  const url = (startAt) => `${session.base}/rest/api/3/project/search?startAt=${String(startAt)}&maxResults=${String(page.maxResults)}`;
  const slice = matches.slice(page.startAt, page.startAt + page.maxResults);
  const envelope = jsonBytes({ self: url(page.startAt), nextPage: url(page.startAt + page.maxResults), maxResults: page.maxResults, startAt: page.startAt, total: matches.length, isLast: false, values: [] });
  const { values } = fillByBytes(slice, (project) => projectBean(session, project, expand.has("issueTypes")), envelope);
  if (values.length === 0 && slice.length > 0) return tooLarge(context, `project '${slice[0].key}'`, jsonBytes(projectBean(session, slice[0], expand.has("issueTypes"))) + envelope);
  const isLast = page.startAt + values.length >= matches.length;
  return {
    self: url(page.startAt),
    ...(isLast ? {} : { nextPage: url(page.startAt + values.length) }),
    maxResults: values.length < slice.length ? values.length : page.maxResults,
    startAt: page.startAt,
    total: matches.length,
    isLast,
    values,
  };
}

function projectsGet(input, context) {
  const session = open(context, input);
  const project = requireProject(session, input.projectIdOrKey);
  return withinBudget(context, { ...projectBean(session, project, true), roles: {}, assigneeType: project.assigneeType });
}

function projectsStatuses(input, context) {
  const session = open(context, input);
  const project = requireProject(session, input.projectIdOrKey);
  const workflow = session.workflow(project);
  const statuses = workflow === null ? [] : workflow.statusIds.map((id) => renderStatus(session.base, session.status(id)));
  return withinBudget(
    context,
    project.issueTypeIds.map((id) => {
      const type = session.issueType(id);
      return { self: `${session.base}/rest/api/3/issuetype/${type.id}`, id: type.id, name: type.name, subtask: type.subtask, statuses };
    }),
  );
}

function issueTypesCreateMeta(input, context) {
  const session = open(context, input);
  const project = requireProject(session, input.projectIdOrKey);
  const page = paging(session, input, 200, 50);
  const types = project.issueTypeIds.map((id) => renderIssueType(session.base, session.issueType(id)));
  const slice = types.slice(page.startAt, page.startAt + page.maxResults);
  const { values } = fillByBytes(slice, (type) => type, jsonBytes({ issueTypes: [], startAt: page.startAt, maxResults: page.maxResults, total: types.length }));
  if (values.length === 0 && slice.length > 0) return tooLarge(context, `issue type '${slice[0].id}'`, jsonBytes(slice[0]));
  return { issueTypes: values, startAt: page.startAt, maxResults: values.length < slice.length ? values.length : page.maxResults, total: types.length };
}

function prioritiesList(input, context) {
  const session = open(context, input);
  return withinBudget(context, session.priorities().map((priority) => renderPriority(session.base, priority)));
}

function statusesList(input, context) {
  const session = open(context, input);
  return withinBudget(context, [...session.statuses()].sort((left, right) => Number(left.id) - Number(right.id)).map((status) => renderStatus(session.base, status)));
}

// ---------------------------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------------------------

function createFields(session, input) {
  const flattened = FLATTENED_KEYS.filter((key) => input[key] !== undefined);
  if (flattened.length > 0 && input.fields !== undefined) {
    return validationError(session.context, {}, ["Provide either 'fields' (REST spelling) or the flattened projectKey/issueTypeName/summary arguments, not both."]);
  }
  if (flattened.length === 0) {
    if (!isPlainObject(input.fields)) return validationError(session.context, { project: "Specify a valid project ID or key" }, []);
    return { fields: input.fields, update: input.update };
  }
  const additional = isPlainObject(input.additional_fields) ? input.additional_fields : {};
  return {
    fields: defined({
      ...additional,
      project: input.projectKey === undefined ? additional.project : { key: input.projectKey },
      issuetype: input.issueTypeName === undefined ? additional.issuetype : { name: input.issueTypeName },
      summary: input.summary ?? additional.summary,
      description: input.description ?? additional.description,
      assignee: input.assignee_account_id === undefined ? additional.assignee : { accountId: input.assignee_account_id },
    }),
    update: input.update,
  };
}

function issuesCreate(input, context) {
  const session = open(context, input);
  const { fields, update } = createFields(session, input);
  const errors = Object.create(null);
  for (const key of Object.keys(fields)) if (!CREATE_FIELDS.has(key)) errors[key] = `Field '${clip(key)}' cannot be set. It is not on the appropriate screen, or unknown.`;
  const projectRef = refId(fields.project, ["id", "key"]);
  if (projectRef === undefined) return validationError(context, { ...errors, project: "Specify a valid project ID or key" }, []);
  const project = requireProject(session, projectRef.value);
  requireWrite(session, project, "You do not have permission to create issues in this project.");

  const typeRef = refId(fields.issuetype, ["id", "name"]);
  const issueType =
    typeRef === undefined
      ? undefined
      : project.issueTypeIds
          .map((id) => session.issueType(id))
          .find((type) => (typeRef.key === "id" ? type.id === typeRef.value : type.name.toLowerCase() === typeRef.value.toLowerCase()));
  if (typeRef === undefined) errors.issuetype = "Specify a valid issue type";
  else if (issueType === undefined) errors.issuetype = "The issue type selected is invalid.";

  const summary = typeof fields.summary === "string" ? fields.summary.trim() : "";
  if (summary.length === 0) errors.summary = "You must specify a summary of the issue.";
  else if (summary.length > 255) errors.summary = "Summary must be less than 255 characters.";

  const description = fields.description === undefined ? null : resolveDescription(fields.description, errors);
  const priorityId = fields.priority === undefined ? DEFAULT_PRIORITY_ID : resolvePriority(session, fields.priority, errors);
  const assigneeId = fields.assignee === undefined ? null : resolveAssignee(session, project, fields.assignee, errors);
  let reporterId = session.me.accountId;
  if (fields.reporter !== undefined) {
    const ref = refId(fields.reporter, ["accountId", "id"]);
    const reporter = ref === undefined ? null : session.user(ref.value);
    if (reporter === null || reporter.active !== true) errors.reporter = "The reporter specified is not a user.";
    else reporterId = reporter.accountId;
  }
  let labels = fields.labels === undefined ? [] : Array.isArray(fields.labels) ? normalizeLabels(session, fields.labels, errors) : [];
  if (fields.labels !== undefined && !Array.isArray(fields.labels)) errors.labels = "Labels must be an array of strings.";
  if (isPlainObject(update)) {
    for (const key of Object.keys(update)) if (key !== "labels") errors[key] = `Field '${clip(key)}' cannot be set. It is not on the appropriate screen, or unknown.`;
    labels = labelUpdates(session, labels, update.labels, errors);
  }
  const parentId = issueType === undefined ? null : resolveParent(session, project, issueType, fields.parent === undefined ? null : fields.parent, errors);
  let dueDate = null;
  if (fields.duedate !== undefined && fields.duedate !== null) {
    if (typeof fields.duedate === "string" && isValidDate(fields.duedate)) dueDate = fields.duedate;
    else errors.duedate = `Error parsing date string: ${clip(fields.duedate)}`;
  }
  if (Object.keys(errors).length > 0) return validationError(context, errors, []);

  const workflow = session.workflow(project);
  const now = session.now();
  const id = nextIssueId(context);
  const number = project.issueKeyCounter + 1;
  const issue = {
    id,
    key: `${project.key}-${String(number)}`,
    projectId: project.id,
    issueTypeId: issueType.id,
    summary,
    description,
    statusId: workflow === null ? "10000" : workflow.initialStatusId,
    priorityId,
    resolutionId: null,
    resolutionDate: null,
    assigneeAccountId: assigneeId,
    reporterAccountId: reporterId,
    creatorAccountId: session.me.accountId,
    labels,
    parentId,
    sprintId: null,
    dueDate,
    created: now,
    updated: now,
    statusCategoryChangeDate: now,
  };
  context.state.put("projects", padId(project.id), { ...project, issueKeyCounter: number });
  saveIssue(session, issue);
  context.events.emit("issue.created", {
    issueId: issue.id,
    key: issue.key,
    projectKey: project.key,
    issueTypeId: issue.issueTypeId,
    reporterAccountId: issue.reporterAccountId,
    summary: issue.summary,
  });
  return { id: issue.id, key: issue.key, self: issueSelf(session, issue) };
}

function issuesGet(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const bean = issueBean(session, issue, selectFields(input.fields, ALL_FIELDS), expandSet(input.expand));
  const bytes = jsonBytes(bean);
  return bytes > RESPONSE_BUDGET ? tooLarge(context, `issue '${issue.key}'`, bytes) : bean;
}

function issuesUpdate(input, context) {
  const session = open(context, input);
  if (input.returnIssue === true) return validationError(context, {}, ["returnIssue is not supported by this Tool; read the issue after the update."]);
  const issue = requireIssue(session, input.issueIdOrKey);
  const project = requireWrite(session, projectOf(session, issue), "You do not have permission to edit issues in this project.");
  const fields = isPlainObject(input.fields) ? input.fields : {};
  const update = isPlainObject(input.update) ? input.update : {};
  const errors = Object.create(null);
  const next = { ...issue };
  for (const key of Object.keys(fields)) if (!EDIT_FIELDS.has(key)) errors[key] = `Field '${clip(key)}' cannot be set. It is not on the appropriate screen, or unknown.`;
  for (const key of Object.keys(update)) if (key !== "labels" && key !== "comment") errors[key] = `Field '${clip(key)}' cannot be set. It is not on the appropriate screen, or unknown.`;
  if (fields.summary !== undefined) {
    const summary = typeof fields.summary === "string" ? fields.summary.trim() : "";
    if (summary.length === 0) errors.summary = "You must specify a summary of the issue.";
    else if (summary.length > 255) errors.summary = "Summary must be less than 255 characters.";
    else next.summary = summary;
  }
  if (fields.description !== undefined) {
    const description = resolveDescription(fields.description, errors);
    if (description !== undefined) next.description = description;
  }
  if (fields.priority !== undefined) {
    const priorityId = resolvePriority(session, fields.priority, errors);
    if (priorityId !== undefined) next.priorityId = priorityId;
  }
  if (fields.assignee !== undefined) {
    const assigneeId = resolveAssignee(session, project, fields.assignee, errors);
    if (assigneeId !== undefined) next.assigneeAccountId = assigneeId;
  }
  if (fields.reporter !== undefined) {
    const ref = refId(fields.reporter, ["accountId", "id"]);
    const reporter = ref === undefined ? null : session.user(ref.value);
    if (reporter === null || reporter.active !== true) errors.reporter = "The reporter specified is not a user.";
    else next.reporterAccountId = reporter.accountId;
  }
  if (fields.labels !== undefined) {
    if (Array.isArray(fields.labels)) next.labels = normalizeLabels(session, fields.labels, errors);
    else errors.labels = "Labels must be an array of strings.";
  }
  next.labels = labelUpdates(session, next.labels, update.labels, errors);
  if (fields.parent !== undefined) {
    const parentId = resolveParent(session, project, session.issueType(issue.issueTypeId), fields.parent, errors, issue.id);
    if (parentId !== undefined) next.parentId = parentId;
  }
  if (fields.duedate !== undefined) {
    if (fields.duedate === null) next.dueDate = null;
    else if (typeof fields.duedate === "string" && isValidDate(fields.duedate)) next.dueDate = fields.duedate;
    else errors.duedate = `Error parsing date string: ${clip(fields.duedate)}`;
  }
  const comments = commentAdds(update.comment, errors);
  if (Object.keys(errors).length > 0) return validationError(context, errors, []);
  requireCommentRoom(session, issue, comments.length);

  const now = session.now();
  const changedFields = [];
  const watched = [
    ["summary", "summary"],
    ["description", "description"],
    ["priority", "priorityId"],
    ["assignee", "assigneeAccountId"],
    ["reporter", "reporterAccountId"],
    ["labels", "labels"],
    ["parent", "parentId"],
    ["duedate", "dueDate"],
  ];
  for (const [field, key] of watched) if (JSON.stringify(issue[key]) !== JSON.stringify(next[key])) changedFields.push(field);
  next.updated = now;
  saveIssue(session, next);
  for (const body of comments) insertComment(session, next, body, now);
  emitUpdated(session, next, changedFields);
  return { id: next.id, key: next.key, self: issueSelf(session, next) };
}

function deleteIssueRows(session, issue) {
  for (const comment of session.comments(issue.id)) session.context.state.delete("comments", commentRowId(issue.id, comment.id));
  session.context.state.delete("issues", padId(issue.id));
}

function issuesDelete(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  requireAdmin(session, projectOf(session, issue), "You do not have permission to delete issues in this project.");
  const children = session.issues().filter((row) => row.parentId === issue.id);
  const subtasks = children.filter((row) => session.issueType(row.issueTypeId).subtask);
  if (subtasks.length > 0 && input.deleteSubtasks !== true) {
    return validationError(context, {}, [`The work item '${issue.key}' has subtasks; set deleteSubtasks=true to delete them.`]);
  }
  const now = session.now();
  for (const child of children) {
    if (subtasks.includes(child)) deleteIssueRows(session, child);
    else saveIssue(session, { ...child, parentId: null, updated: now });
  }
  deleteIssueRows(session, issue);
  return { id: issue.id, key: issue.key };
}

function issuesAssign(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const project = requireWrite(session, projectOf(session, issue), "You do not have permission to assign issues in this project.");
  let assigneeId = null;
  if (input.accountId === "-1") assigneeId = project.assigneeType === "PROJECT_LEAD" ? project.leadAccountId : null;
  else if (input.accountId !== null) {
    const errors = Object.create(null);
    assigneeId = resolveAssignee(session, project, { accountId: input.accountId }, errors);
    if (assigneeId === undefined) return validationError(context, errors, []);
  }
  const next = { ...issue, assigneeAccountId: assigneeId, updated: session.now() };
  saveIssue(session, next);
  emitUpdated(session, next, ["assignee"]);
  return { id: next.id, key: next.key, assignee: assigneeId === null ? null : renderUser(session.base, session.user(assigneeId)) };
}

function issuesTransitions(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const transitions = transitionsFor(session, issue).filter((transition) => input.transitionId === undefined || transition.id === String(input.transitionId));
  return withinBudget(context, { expand: "transitions", transitions });
}

function issuesTransition(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const project = requireWrite(session, projectOf(session, issue), "You do not have permission to transition issues in this project.");
  const transitionId = isPlainObject(input.transition) ? String(input.transition.id ?? "") : "";
  const workflow = session.workflow(project);
  const transition = workflow === null ? undefined : workflow.transitions.find((candidate) => candidate.id === transitionId);
  if (transition === undefined || (transition.from.length > 0 && !transition.from.includes(issue.statusId))) {
    return validationError(context, {}, [`Transition id '${clip(transitionId)}' is not valid for this issue.`]);
  }
  const target = session.status(transition.to);
  const targetDone = target.statusCategoryId === 3;
  const fields = isPlainObject(input.fields) ? input.fields : {};
  const update = isPlainObject(input.update) ? input.update : {};
  const errors = Object.create(null);
  for (const key of Object.keys(fields)) if (key !== "resolution" && key !== "assignee") errors[key] = `Field '${clip(key)}' cannot be set. It is not on the appropriate screen, or unknown.`;
  for (const key of Object.keys(update)) if (key !== "comment") errors[key] = `Field '${clip(key)}' cannot be set. It is not on the appropriate screen, or unknown.`;
  let resolutionId;
  if (fields.resolution !== undefined) {
    if (!targetDone) errors.resolution = "Field 'resolution' cannot be set. It is not on the appropriate screen, or unknown.";
    else {
      const ref = refId(fields.resolution, ["id", "name"]);
      const resolution = ref === undefined ? undefined : RESOLUTIONS.find((row) => (ref.key === "id" ? row.id === ref.value : row.name.toLowerCase() === ref.value.toLowerCase()));
      if (resolution === undefined) errors.resolution = `Resolution ${ref === undefined ? "value" : ref.key} '${ref === undefined ? "" : clip(ref.value)}' is not valid`;
      else resolutionId = resolution.id;
    }
  }
  let assigneeId;
  if (fields.assignee !== undefined) assigneeId = resolveAssignee(session, project, fields.assignee, errors);
  const comments = commentAdds(update.comment, errors);
  if (Object.keys(errors).length > 0) return validationError(context, errors, []);
  requireCommentRoom(session, issue, comments.length);

  const now = session.now();
  const previous = session.status(issue.statusId);
  const next = { ...issue, statusId: target.id, updated: now };
  const changedFields = ["status"];
  if (previous.statusCategoryId !== target.statusCategoryId) next.statusCategoryChangeDate = now;
  if (targetDone) {
    next.resolutionId = resolutionId ?? issue.resolutionId ?? DEFAULT_RESOLUTION_ID;
    if (next.resolutionId !== issue.resolutionId || issue.resolutionDate === null) next.resolutionDate = now;
  } else {
    next.resolutionId = null;
    next.resolutionDate = null;
  }
  if (next.resolutionId !== issue.resolutionId) changedFields.push("resolution");
  if (assigneeId !== undefined) {
    next.assigneeAccountId = assigneeId;
    changedFields.push("assignee");
  }
  saveIssue(session, next);
  for (const body of comments) insertComment(session, next, body, now);
  emitUpdated(session, next, changedFields, { id: transition.id, name: transition.name, fromStatusId: issue.statusId, toStatusId: target.id });
  return {
    id: next.id,
    key: next.key,
    status: renderStatus(session.base, target),
    resolution: next.resolutionId === null ? null : renderResolution(session.base, next.resolutionId),
  };
}

// ---------------------------------------------------------------------------------------------
// JQL search
// ---------------------------------------------------------------------------------------------

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// Self-contained base64url over ASCII text (the page token is `<offset>:<hex>`), so the behavior
// depends on no host globals such as btoa/atob or TextEncoder.
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64urlEncode(text) {
  let output = "";
  for (let index = 0; index < text.length; index += 3) {
    const bytes = [text.charCodeAt(index), text.charCodeAt(index + 1), text.charCodeAt(index + 2)];
    const count = Math.min(3, text.length - index);
    const chunk = ((bytes[0] & 0xff) << 16) | ((count > 1 ? bytes[1] & 0xff : 0) << 8) | (count > 2 ? bytes[2] & 0xff : 0);
    output += BASE64URL[(chunk >> 18) & 63] + BASE64URL[(chunk >> 12) & 63];
    if (count > 1) output += BASE64URL[(chunk >> 6) & 63];
    if (count > 2) output += BASE64URL[chunk & 63];
  }
  return output;
}

/** Decodes base64url to ASCII text; null when the input is not well-formed or not ASCII. */
function base64urlDecode(text) {
  if (typeof text !== "string" || text.length % 4 === 1 || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  let output = "";
  for (let index = 0; index < text.length; index += 4) {
    const values = [];
    for (let offset = 0; offset < 4 && index + offset < text.length; offset += 1) values.push(BASE64URL.indexOf(text[index + offset]));
    const chunk = (values[0] << 18) | ((values[1] ?? 0) << 12) | ((values[2] ?? 0) << 6) | (values[3] ?? 0);
    const bytes = [(chunk >> 16) & 0xff, (chunk >> 8) & 0xff, chunk & 0xff].slice(0, values.length - 1);
    for (const byte of bytes) {
      if (byte > 0x7f) return null;
      output += String.fromCharCode(byte);
    }
  }
  return output;
}

function jqlEnvironment(session) {
  const statuses = session.statuses();
  const statusById = new Map(statuses.map((status) => [status.id, status]));
  const commentTexts = new Map();
  return {
    nowMs: nowMs(session.context),
    currentUserId: session.me.accountId,
    projects: session.projects(),
    issueTypes: session.issueTypes(),
    statuses,
    priorities: session.priorities(),
    users: session.users(),
    sprints: session.sprints(),
    statusCategoryOf: (id) => statusById.get(id)?.statusCategoryId ?? 2,
    statusName: (id) => statusById.get(id)?.name ?? "",
    userName: (id) => session.user(id)?.displayName ?? "",
    issueByKey: (key) => session.issues().find((row) => row.key.toLowerCase() === String(key).toLowerCase()) ?? null,
    issueById: (id) => (isNumericId(String(id)) ? session.context.state.get("issues", padId(id)) : null),
    descriptionText: (issue) => adfText(issue.description),
    commentText: (issue) => {
      if (!commentTexts.has(issue.id)) commentTexts.set(issue.id, session.comments(issue.id).map((comment) => adfText(comment.body)).join("\n"));
      return commentTexts.get(issue.id);
    },
  };
}

/** Visible issues matching `jql`, sorted (or INVALID_JQL). */
function evaluateJql(session, jql) {
  let compiled;
  try {
    compiled = compileJql(jql, jqlEnvironment(session));
  } catch (error) {
    if (error instanceof JqlError) return invalidJql(session.context, error.message);
    throw error;
  }
  return session
    .issues()
    .filter((issue) => browsable(session, projectOf(session, issue)) && compiled.predicate(issue))
    .sort(compiled.comparator);
}

function issuesSearch(input, context) {
  const session = open(context, input);
  const jql = typeof input.jql === "string" ? input.jql : "";
  const maxResults = input.maxResults === undefined ? 50 : input.maxResults;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100) return validationError(context, {}, ["The 'maxResults' parameter must be between 1 and 100."]);
  const signature = fnv1a(`${normalizeJql(jql)}|${session.me.accountId}`);
  let offset = 0;
  if (input.nextPageToken !== undefined) {
    const decoded = base64urlDecode(String(input.nextPageToken));
    const match = decoded === null ? null : /^(\d{1,9}):([0-9a-f]{8})$/.exec(decoded);
    if (match === null || match[2] !== signature) return validationError(context, {}, ["The page token is invalid."]);
    offset = Number(match[1]);
  }
  const matches = evaluateJql(session, jql);
  const candidates = matches.slice(offset, offset + maxResults);
  const fields = selectFields(input.fields, []);
  const expand = expandSet(input.expand);
  const names = expand.has("names") ? { names: Object.fromEntries(fields.map((field) => [field, FIELD_NAMES[field]])) } : {};
  // The page is filled by encoded bytes: the token (at its longest) and names count toward the budget.
  const envelope = jsonBytes({ issues: [], isLast: false, nextPageToken: base64urlEncode(`999999999:${signature}`), ...names });
  const render = (issue) => issueBean(session, issue, fields, new Set(), RESPONSE_BUDGET - envelope);
  const { values: issues } = fillByBytes(candidates, render, envelope);
  if (issues.length === 0 && candidates.length > 0) return tooLarge(context, `issue '${candidates[0].key}'`, jsonBytes(render(candidates[0])) + envelope);
  const next = offset + issues.length;
  const isLast = next >= matches.length;
  return {
    issues,
    isLast,
    ...(isLast ? {} : { nextPageToken: base64urlEncode(`${String(next)}:${signature}`) }),
    ...names,
  };
}

function issuesCount(input, context) {
  const session = open(context, input);
  return { count: evaluateJql(session, typeof input.jql === "string" ? input.jql : "").length };
}

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

function commentsList(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const page = paging(session, input, 100, 50);
  const orderBy = input.orderBy ?? "created";
  if (!["created", "+created", "-created"].includes(orderBy)) return validationError(context, {}, [`The orderBy value '${orderBy}' is not valid.`]);
  const comments = session.comments(issue.id).sort((left, right) => (Number(left.id) - Number(right.id)) * (orderBy === "-created" ? -1 : 1));
  const refs = refsFor(session);
  const slice = comments.slice(page.startAt, page.startAt + page.maxResults);
  const envelope = jsonBytes({ comments: [], startAt: page.startAt, maxResults: page.maxResults, total: comments.length });
  const { values } = fillByBytes(slice, (comment) => renderComment(session.base, comment, refs), envelope);
  if (values.length === 0 && slice.length > 0) return tooLarge(context, `comment '${slice[0].id}'`, jsonBytes(renderComment(session.base, slice[0], refs)) + envelope);
  return {
    comments: values,
    startAt: page.startAt,
    // A page ended early by the byte budget reports how many it holds, so startAt + maxResults resumes exactly.
    maxResults: values.length < slice.length ? values.length : page.maxResults,
    total: comments.length,
  };
}

function commentBody(session, input) {
  if (input.body !== undefined && input.commentBody !== undefined) return validationError(session.context, {}, ["Provide either 'body' or 'commentBody', not both."]);
  const raw = input.body !== undefined ? input.body : input.commentBody;
  if (raw === undefined || raw === null) return validationError(session.context, { comment: "Comment body can not be empty!" }, []);
  if (typeof raw === "string" && raw.length > TEXT_LIMIT) return validationError(session.context, { comment: TEXT_TOO_LONG }, []);
  const body = coerceBody(raw);
  if (body.error === "empty") return validationError(session.context, { comment: "Comment body can not be empty!" }, []);
  if (body.error === "malformed") return validationError(session.context, { comment: ADF_MESSAGE }, []);
  if (textFieldLength(raw, body.doc) > TEXT_LIMIT) return validationError(session.context, { comment: TEXT_TOO_LONG }, []);
  return body.doc;
}

function commentsAdd(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  requireWrite(session, projectOf(session, issue), "You do not have permission to comment on issues in this project.");
  if (input.visibility !== undefined) return validationError(context, {}, ["Comment visibility restrictions are not supported by this Tool."]);
  const body = commentBody(session, input);
  if (session.comments(issue.id).length >= session.limits.maxCommentsPerIssue) return boundExceeded(context, "comments", session.limits.maxCommentsPerIssue);
  const now = session.now();
  saveIssue(session, { ...issue, updated: now });
  const comment = insertComment(session, issue, body, now);
  return renderComment(session.base, comment, refsFor(session));
}

function requireComment(session, issue, commentId) {
  const comment = isNumericId(String(commentId)) ? session.context.state.get("comments", commentRowId(issue.id, String(commentId))) : null;
  return comment === null ? notFound(session.context, `Can not find a comment for the id: ${clip(commentId)}.`) : comment;
}

function requireCommentAccess(session, issue, comment, message) {
  if (comment.authorAccountId === session.me.accountId) return;
  requireAdmin(session, projectOf(session, issue), message);
}

function commentsUpdate(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const comment = requireComment(session, issue, input.commentId);
  requireCommentAccess(session, issue, comment, "You do not have permission to edit this comment.");
  const body = commentBody(session, { body: input.body });
  const now = session.now();
  const next = { ...comment, body, updated: now, updateAuthorAccountId: session.me.accountId };
  context.state.put("comments", commentRowId(issue.id, comment.id), next);
  saveIssue(session, { ...issue, updated: now });
  return renderComment(session.base, next, refsFor(session));
}

function commentsDelete(input, context) {
  const session = open(context, input);
  const issue = requireIssue(session, input.issueIdOrKey);
  const comment = requireComment(session, issue, input.commentId);
  requireCommentAccess(session, issue, comment, "You do not have permission to delete this comment.");
  context.state.delete("comments", commentRowId(issue.id, comment.id));
  saveIssue(session, { ...issue, updated: session.now() });
  return { id: comment.id };
}

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

/** Jira's user arrays carry no paging metadata: a page ended by the byte budget is shorter, and startAt + length resumes. */
function userPage(session, matches, page) {
  const slice = matches.slice(page.startAt, page.startAt + page.maxResults);
  const { values } = fillByBytes(slice, (user) => renderUser(session.base, user), 2);
  if (values.length === 0 && slice.length > 0) return tooLarge(session.context, `user '${slice[0].accountId}'`, jsonBytes(renderUser(session.base, slice[0])));
  return values;
}

function usersSearch(input, context) {
  const session = open(context, input);
  if (input.query !== undefined && input.searchString !== undefined) return validationError(context, {}, ["Provide either 'query' or 'searchString', not both."]);
  const query = typeof input.query === "string" ? input.query.trim() : typeof input.searchString === "string" ? input.searchString.trim() : "";
  if (query.length === 0) return validationError(context, {}, ["The username or property query parameter is required."]);
  const page = paging(session, input, 1000, 50);
  const matches = session
    .users()
    .filter((user) => includes(user.displayName, query) || includes(user.emailAddress ?? "", query))
    .sort((left, right) => compareFold(left.displayName, right.displayName) || compareFold(left.accountId, right.accountId));
  return userPage(session, matches, page);
}

function usersAssignable(input, context) {
  const session = open(context, input);
  const hasProject = typeof input.project === "string" && input.project.length > 0;
  const hasIssue = typeof input.issueKey === "string" && input.issueKey.length > 0;
  if (hasProject === hasIssue) return validationError(context, {}, ["Either project or issueKey must be specified."]);
  const project = hasProject ? requireProject(session, input.project) : projectOf(session, requireIssue(session, input.issueKey));
  const page = paging(session, input, 1000, 50);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const roles = session.roles(project);
  const matches = session
    .users()
    .filter((user) => isAssignable(project, roles, user) && (query.length === 0 || includes(user.displayName, query) || includes(user.emailAddress ?? "", query)))
    .sort((left, right) => compareFold(left.displayName, right.displayName) || compareFold(left.accountId, right.accountId));
  return userPage(session, matches, page);
}

// ---------------------------------------------------------------------------------------------
// Agile: boards and sprints
// ---------------------------------------------------------------------------------------------

function boardsList(input, context) {
  const session = open(context, input);
  const page = paging(session, input, 50, 50);
  if (input.type !== undefined && !["scrum", "kanban"].includes(input.type)) return validationError(context, {}, [`The board type '${input.type}' is not valid.`]);
  const project = input.projectKeyOrId === undefined ? null : requireProject(session, input.projectKeyOrId);
  const matches = session
    .boards()
    .filter((board) => {
      const owner = session.project(board.projectId);
      if (!browsable(session, owner)) return false;
      if (input.type !== undefined && board.type !== input.type) return false;
      if (typeof input.name === "string" && input.name.length > 0 && !includes(board.name, input.name)) return false;
      if (project !== null && board.projectId !== project.id) return false;
      return true;
    })
    .sort((left, right) => Number(left.id) - Number(right.id));
  const slice = matches.slice(page.startAt, page.startAt + page.maxResults);
  const render = (board) => renderBoard(session.base, board, session.project(board.projectId));
  const { values } = fillByBytes(slice, render, jsonBytes({ maxResults: page.maxResults, startAt: page.startAt, total: matches.length, isLast: false, values: [] }));
  if (values.length === 0 && slice.length > 0) return tooLarge(context, `board '${slice[0].id}'`, jsonBytes(render(slice[0])));
  return {
    maxResults: values.length < slice.length ? values.length : page.maxResults,
    startAt: page.startAt,
    total: matches.length,
    isLast: page.startAt + values.length >= matches.length,
    values,
  };
}

function requireBoard(session, boardId) {
  const board = isNumericId(String(boardId)) ? session.context.state.get("boards", padId(String(boardId))) : null;
  if (board === null || !browsable(session, session.project(board.projectId))) {
    return notFound(session.context, "The board does not exist or you do not have permission to view it.");
  }
  return board;
}

function sprintsList(input, context) {
  const session = open(context, input);
  const board = requireBoard(session, input.boardId);
  const page = paging(session, input, 50, 50);
  if (board.type !== "scrum") return validationError(context, {}, ["The board does not support sprints."]);
  const states = typeof input.state === "string" && input.state.trim().length > 0 ? input.state.split(",").map((state) => state.trim().toLowerCase()) : null;
  if (states !== null) for (const state of states) if (!["future", "active", "closed"].includes(state)) return validationError(context, {}, [`The sprint state '${state}' is not valid.`]);
  const matches = session
    .sprints()
    .filter((sprint) => sprint.boardId === board.id && (states === null || states.includes(sprint.state)))
    .sort((left, right) => Number(left.id) - Number(right.id));
  const slice = matches.slice(page.startAt, page.startAt + page.maxResults);
  const { values } = fillByBytes(slice, (sprint) => renderSprint(session.base, sprint), jsonBytes({ maxResults: page.maxResults, startAt: page.startAt, isLast: false, values: [] }));
  if (values.length === 0 && slice.length > 0) return tooLarge(context, `sprint '${slice[0].id}'`, jsonBytes(renderSprint(session.base, slice[0])));
  return {
    maxResults: values.length < slice.length ? values.length : page.maxResults,
    startAt: page.startAt,
    isLast: page.startAt + values.length >= matches.length,
    values,
  };
}

function sprintsMoveIssues(input, context) {
  const session = open(context, input);
  const sprint = isNumericId(String(input.sprintId)) ? context.state.get("sprints", padId(String(input.sprintId))) : null;
  const board = sprint === null ? null : context.state.get("boards", padId(sprint.boardId));
  if (sprint === null || board === null || !browsable(session, session.project(board.projectId))) {
    return notFound(context, "The sprint does not exist or you do not have permission to view it.");
  }
  const keys = Array.isArray(input.issues) ? input.issues.map((entry) => String(entry)) : [];
  if (keys.length < 1 || keys.length > 50) return validationError(context, {}, ["issues must contain between 1 and 50 issue keys or ids."]);
  if (sprint.state === "closed") return validationError(context, {}, ["Cannot move issues to a closed sprint."]);
  const moved = [];
  for (const key of keys) {
    const issue = requireIssue(session, key);
    requireWrite(session, projectOf(session, issue), "You do not have permission to edit issues in this project.");
    if (issue.projectId !== board.projectId) return validationError(context, {}, [`Issue '${issue.key}' cannot be moved to this sprint because it is not on the board.`]);
    if (session.issueType(issue.issueTypeId).subtask) return validationError(context, {}, ["Subtasks cannot be moved to a sprint independently."]);
    if (!moved.some((entry) => entry.id === issue.id)) moved.push(issue);
  }
  const now = session.now();
  for (const issue of moved) {
    const next = { ...issue, sprintId: sprint.id, updated: now };
    saveIssue(session, next);
    emitUpdated(session, next, ["customfield_10020"]);
  }
  return { sprintId: sprint.id, issues: moved.map((issue) => issue.key) };
}

// ---------------------------------------------------------------------------------------------
// HTTP codecs (pure): Jira paths in, Jira bodies/headers out
// ---------------------------------------------------------------------------------------------

function route(decode, options = {}) {
  return {
    decode,
    encode({ invocation, outcome }) {
      const headers = responseHeaders(invocation.correlationId, outcome);
      if (outcome.status !== "ok") return { headers, body: { kind: "json", value: jiraError(outcome) } };
      if (options.empty) return { headers, body: { kind: "empty" } };
      return { headers, body: { kind: "json", value: outcome.value } };
    },
  };
}

/** Integer query parameter, or the raw string when malformed so the schema reports it as invalid. */
function intOrRaw(query, name) {
  try {
    return int(query, name);
  } catch {
    return str(query, name);
  }
}

function boolOrRaw(query, name) {
  try {
    return bool(query, name);
  } catch {
    return str(query, name);
  }
}

function pick(body, keys) {
  return defined(Object.fromEntries(keys.map((key) => [key, body[key]])));
}

function issuePath(request) {
  return { issueIdOrKey: request.path.issueIdOrKey };
}

const http = {
  "accessible-resources": route(() => ({ arguments: {} })),
  "get-myself": route((request) => ({ arguments: defined({ expand: str(request.query, "expand") }) })),
  "get-server-info": route(() => ({ arguments: {} })),
  "search-projects": route((request) => ({
    arguments: defined({
      startAt: intOrRaw(request.query, "startAt"),
      maxResults: intOrRaw(request.query, "maxResults"),
      query: str(request.query, "query"),
      keys: list(request.query, "keys"),
      typeKey: str(request.query, "typeKey"),
      orderBy: str(request.query, "orderBy"),
      action: str(request.query, "action"),
      expand: list(request.query, "expand"),
    }),
  })),
  "get-project-statuses": route((request) => ({ arguments: { projectIdOrKey: request.path.projectIdOrKey } })),
  "get-create-meta-issue-types": route((request) => ({
    arguments: defined({ projectIdOrKey: request.path.projectIdOrKey, startAt: intOrRaw(request.query, "startAt"), maxResults: intOrRaw(request.query, "maxResults") }),
  })),
  "list-priorities": route(() => ({ arguments: {} })),
  "list-statuses": route(() => ({ arguments: {} })),
  "create-issue": route((request) => operationInput(request, jsonBody(request))),
  "get-issue": route((request) => ({
    arguments: defined({ ...issuePath(request), fields: list(request.query, "fields"), expand: list(request.query, "expand") }),
  })),
  "edit-issue": route(
    (request) =>
      operationInput(
        request,
        defined({
          ...issuePath(request),
          ...pick(jsonBody(request), ["fields", "update"]),
          notifyUsers: boolOrRaw(request.query, "notifyUsers"),
          returnIssue: boolOrRaw(request.query, "returnIssue"),
        }),
      ),
    { empty: true },
  ),
  "delete-issue": route((request) => operationInput(request, defined({ ...issuePath(request), deleteSubtasks: boolOrRaw(request.query, "deleteSubtasks") })), { empty: true }),
  "assign-issue": route(
    (request) => {
      const body = jsonBody(request);
      return operationInput(request, { ...issuePath(request), ...(Object.hasOwn(body, "accountId") ? { accountId: body.accountId } : {}) });
    },
    { empty: true },
  ),
  "get-transitions": route((request) => ({
    arguments: defined({
      ...issuePath(request),
      transitionId: str(request.query, "transitionId"),
      expand: str(request.query, "expand"),
      includeUnavailableTransitions: boolOrRaw(request.query, "includeUnavailableTransitions"),
      skipRemoteOnlyCondition: boolOrRaw(request.query, "skipRemoteOnlyCondition"),
    }),
  })),
  "do-transition": route((request) => operationInput(request, { ...issuePath(request), ...pick(jsonBody(request), ["transition", "fields", "update"]) }), { empty: true }),
  "search-jql-get": route((request) => ({
    arguments: defined({
      jql: str(request.query, "jql") ?? "",
      nextPageToken: str(request.query, "nextPageToken"),
      maxResults: intOrRaw(request.query, "maxResults"),
      fields: list(request.query, "fields"),
      expand: list(request.query, "expand"),
    }),
  })),
  "search-jql-post": route((request) => ({
    arguments: pick(jsonBody(request), ["jql", "nextPageToken", "maxResults", "fields", "expand", "properties", "fieldsByKeys", "reconcileIssues"]),
  })),
  "search-approximate-count": route((request) => ({ arguments: pick(jsonBody(request), ["jql"]) })),
  "list-comments": route((request) => ({
    arguments: defined({
      ...issuePath(request),
      startAt: intOrRaw(request.query, "startAt"),
      maxResults: intOrRaw(request.query, "maxResults"),
      orderBy: str(request.query, "orderBy"),
      expand: str(request.query, "expand"),
    }),
  })),
  "add-comment": route((request) => operationInput(request, { ...issuePath(request), ...pick(jsonBody(request), ["body", "commentBody", "visibility"]) })),
  "update-comment": route((request) => operationInput(request, { ...issuePath(request), commentId: request.path.commentId, ...pick(jsonBody(request), ["body"]) })),
  "delete-comment": route((request) => operationInput(request, { ...issuePath(request), commentId: request.path.commentId }), { empty: true }),
  "find-users": route((request) => ({
    arguments: defined({ query: str(request.query, "query"), startAt: intOrRaw(request.query, "startAt"), maxResults: intOrRaw(request.query, "maxResults") }),
  })),
  "find-assignable-users": route((request) => ({
    arguments: defined({
      project: str(request.query, "project"),
      issueKey: str(request.query, "issueKey"),
      query: str(request.query, "query"),
      startAt: intOrRaw(request.query, "startAt"),
      maxResults: intOrRaw(request.query, "maxResults"),
    }),
  })),
  "list-boards": route((request) => ({
    arguments: defined({
      startAt: intOrRaw(request.query, "startAt"),
      maxResults: intOrRaw(request.query, "maxResults"),
      type: str(request.query, "type"),
      name: str(request.query, "name"),
      projectKeyOrId: str(request.query, "projectKeyOrId"),
    }),
  })),
  "list-board-sprints": route((request) => ({
    arguments: defined({
      boardId: request.path.boardId,
      state: str(request.query, "state"),
      startAt: intOrRaw(request.query, "startAt"),
      maxResults: intOrRaw(request.query, "maxResults"),
    }),
  })),
  "move-issues-to-sprint": route(
    (request) => operationInput(request, { sprintId: request.path.sprintId, ...pick(jsonBody(request), ["issues", "rankBeforeIssue", "rankAfterIssue", "rankCustomFieldId"]) }),
    { empty: true },
  ),
};

const operations = {
  "resources.list": resourcesList,
  "myself.get": myselfGet,
  "server-info.get": serverInfoGet,
  "projects.search": projectsSearch,
  "projects.get": projectsGet,
  "projects.statuses": projectsStatuses,
  "issue-types.create-meta": issueTypesCreateMeta,
  "priorities.list": prioritiesList,
  "statuses.list": statusesList,
  "issues.create": issuesCreate,
  "issues.get": issuesGet,
  "issues.update": issuesUpdate,
  "issues.delete": issuesDelete,
  "issues.assign": issuesAssign,
  "issues.transitions": issuesTransitions,
  "issues.transition": issuesTransition,
  "issues.search": issuesSearch,
  "issues.count": issuesCount,
  "comments.list": commentsList,
  "comments.add": commentsAdd,
  "comments.update": commentsUpdate,
  "comments.delete": commentsDelete,
  "users.search": usersSearch,
  "users.assignable": usersAssignable,
  "boards.list": boardsList,
  "sprints.list": sprintsList,
  "sprints.move-issues": sprintsMoveIssues,
};

export default { operations, http };
