// State rows → Jira REST v3 / agile 1.0 beans. Pure functions: every link is built from the
// site's `baseUrl`; lookups arrive through the `refs` object the behavior assembles per call.

export const STATUS_CATEGORIES = Object.freeze({
  2: Object.freeze({ id: 2, key: "new", colorName: "blue-gray", name: "To Do" }),
  4: Object.freeze({ id: 4, key: "indeterminate", colorName: "yellow", name: "In Progress" }),
  3: Object.freeze({ id: 3, key: "done", colorName: "green", name: "Done" }),
});

export const RESOLUTIONS = Object.freeze([
  Object.freeze({ id: "10000", name: "Done", description: "Work has been completed on this work item." }),
  Object.freeze({ id: "10001", name: "Won't Do", description: "This work item won't be actioned." }),
  Object.freeze({ id: "10002", name: "Duplicate", description: "The problem is a duplicate of an existing work item." }),
  Object.freeze({
    id: "10003",
    name: "Cannot Reproduce",
    description: "All attempts at reproducing this work item failed, or not enough information was available to reproduce the work item.",
  }),
]);

export const ALL_FIELDS = Object.freeze([
  "summary",
  "description",
  "issuetype",
  "project",
  "status",
  "statuscategorychangedate",
  "priority",
  "resolution",
  "resolutiondate",
  "assignee",
  "reporter",
  "creator",
  "labels",
  "parent",
  "subtasks",
  "duedate",
  "created",
  "updated",
  "customfield_10020",
  "comment",
]);

export const NAVIGABLE_FIELDS = Object.freeze(ALL_FIELDS.filter((field) => field !== "description" && field !== "comment"));

export const FIELD_NAMES = Object.freeze({
  summary: "Summary",
  description: "Description",
  issuetype: "Issue Type",
  project: "Project",
  status: "Status",
  statuscategorychangedate: "Status Category Changed",
  priority: "Priority",
  resolution: "Resolution",
  resolutiondate: "Resolved",
  assignee: "Assignee",
  reporter: "Reporter",
  creator: "Creator",
  labels: "Labels",
  parent: "Parent",
  subtasks: "Sub-tasks",
  duedate: "Due date",
  created: "Created",
  updated: "Updated",
  customfield_10020: "Sprint",
  comment: "Comment",
});

export const INLINE_COMMENT_LIMIT = 100;

function avatarUrls(path) {
  return {
    "48x48": `${path}?size=large`,
    "24x24": `${path}?size=small`,
    "16x16": `${path}?size=xsmall`,
    "32x32": `${path}?size=medium`,
  };
}

export function renderUser(base, user) {
  if (user === null || user === undefined) return null;
  return {
    self: `${base}/rest/api/3/user?accountId=${encodeURIComponent(user.accountId)}`,
    accountId: user.accountId,
    accountType: user.accountType,
    ...(typeof user.emailAddress === "string" && user.emailAddress.length > 0 ? { emailAddress: user.emailAddress } : {}),
    avatarUrls: avatarUrls(`${base}/rest/api/3/universal_avatar/view/type/user/avatar/10122`),
    displayName: user.displayName,
    active: user.active,
    timeZone: user.timeZone,
    locale: user.locale,
  };
}

export function renderStatus(base, status) {
  const category = STATUS_CATEGORIES[status.statusCategoryId];
  return {
    self: `${base}/rest/api/3/status/${status.id}`,
    description: status.description,
    iconUrl: `${base}/images/icons/statuses/generic.png`,
    name: status.name,
    id: status.id,
    statusCategory: {
      self: `${base}/rest/api/3/statuscategory/${String(category.id)}`,
      id: category.id,
      key: category.key,
      colorName: category.colorName,
      name: category.name,
    },
  };
}

export function renderPriority(base, priority) {
  return {
    self: `${base}/rest/api/3/priority/${priority.id}`,
    iconUrl: `${base}/images/icons/priorities/${priority.iconName}.svg`,
    name: priority.name,
    id: priority.id,
    description: priority.description,
    statusColor: priority.statusColor,
    isDefault: priority.id === "3",
  };
}

export function renderIssueType(base, type) {
  return {
    self: `${base}/rest/api/3/issuetype/${type.id}`,
    id: type.id,
    description: type.description,
    iconUrl: `${base}/rest/api/2/universal_avatar/view/type/issuetype/avatar/${type.iconId}?size=medium`,
    name: type.name,
    subtask: type.subtask,
    avatarId: Number(type.iconId),
    hierarchyLevel: type.hierarchyLevel,
  };
}

export function renderResolution(base, resolutionId) {
  const resolution = RESOLUTIONS.find((candidate) => candidate.id === resolutionId);
  if (resolution === undefined) return null;
  return { self: `${base}/rest/api/3/resolution/${resolution.id}`, id: resolution.id, description: resolution.description, name: resolution.name };
}

export function projectAvatarUrls(base, project) {
  return avatarUrls(`${base}/rest/api/3/universal_avatar/view/type/project/avatar/${project.avatarId}`);
}

export function renderProject(base, project, lead) {
  return {
    expand: "description,lead,issueTypes,url,projectKeys,permissions,insight",
    self: `${base}/rest/api/3/project/${project.id}`,
    id: project.id,
    key: project.key,
    name: project.name,
    description: project.description,
    lead: renderUser(base, lead),
    projectTypeKey: project.projectTypeKey,
    simplified: project.simplified,
    style: project.style,
    isPrivate: project.accessLevel === "private",
    avatarUrls: projectAvatarUrls(base, project),
    properties: {},
  };
}

export function renderProjectCompact(base, project) {
  return {
    self: `${base}/rest/api/3/project/${project.id}`,
    id: project.id,
    key: project.key,
    name: project.name,
    projectTypeKey: project.projectTypeKey,
    simplified: project.simplified,
    avatarUrls: projectAvatarUrls(base, project),
  };
}

export function renderSprint(base, sprint) {
  return {
    id: Number(sprint.id),
    self: `${base}/rest/agile/1.0/sprint/${sprint.id}`,
    state: sprint.state,
    name: sprint.name,
    ...(sprint.startDate === null ? {} : { startDate: sprint.startDate }),
    ...(sprint.endDate === null ? {} : { endDate: sprint.endDate }),
    ...(sprint.completeDate === null ? {} : { completeDate: sprint.completeDate }),
    createdDate: sprint.createdDate,
    originBoardId: Number(sprint.originBoardId),
    goal: sprint.goal,
  };
}

/** The Sprint custom field value carried by an issue bean (`customfield_10020`). */
export function renderSprintField(sprint, boardId) {
  return {
    id: Number(sprint.id),
    name: sprint.name,
    state: sprint.state,
    boardId: Number(boardId),
    goal: sprint.goal,
    ...(sprint.startDate === null ? {} : { startDate: sprint.startDate }),
    ...(sprint.endDate === null ? {} : { endDate: sprint.endDate }),
    ...(sprint.completeDate === null ? {} : { completeDate: sprint.completeDate }),
  };
}

export function renderBoard(base, board, project) {
  const display = `${project.name} (${project.key})`;
  return {
    id: Number(board.id),
    self: `${base}/rest/agile/1.0/board/${board.id}`,
    name: board.name,
    type: board.type,
    location: {
      projectId: Number(project.id),
      displayName: display,
      projectName: project.name,
      projectKey: project.key,
      projectTypeKey: project.projectTypeKey,
      avatarURI: `${base}/rest/api/3/universal_avatar/view/type/project/avatar/${project.avatarId}?size=small`,
      name: display,
    },
  };
}

export function renderComment(base, comment, refs) {
  return {
    self: `${base}/rest/api/3/issue/${comment.issueId}/comment/${comment.id}`,
    id: comment.id,
    author: renderUser(base, refs.user(comment.authorAccountId)),
    body: comment.body,
    updateAuthor: renderUser(base, refs.user(comment.updateAuthorAccountId)),
    created: comment.created,
    updated: comment.updated,
    jsdPublic: comment.jsdPublic,
  };
}

/**
 * Resolve a `fields` request (array of `*all`, `*navigable`, names and `-name` exclusions) into the
 * ordered list of field ids to render. Unknown names are ignored, as Jira does.
 */
export function selectFields(requested, defaults) {
  const tokens = Array.isArray(requested) ? requested.filter((token) => typeof token === "string" && token.length > 0) : [];
  const positive = tokens.some((token) => !token.startsWith("-"));
  const selected = new Set(positive ? [] : defaults);
  for (const token of tokens) {
    if (token === "*all") for (const field of ALL_FIELDS) selected.add(field);
    else if (token === "*navigable") for (const field of NAVIGABLE_FIELDS) selected.add(field);
    else if (!token.startsWith("-") && Object.hasOwn(FIELD_NAMES, token)) selected.add(token);
  }
  for (const token of tokens) if (token.startsWith("-")) selected.delete(token.slice(1));
  return ALL_FIELDS.filter((field) => selected.has(field));
}

export function renderIssueCompact(base, issue, refs) {
  return {
    id: issue.id,
    key: issue.key,
    self: `${base}/rest/api/3/issue/${issue.id}`,
    fields: {
      summary: issue.summary,
      status: renderStatus(base, refs.status(issue.statusId)),
      priority: renderPriority(base, refs.priority(issue.priorityId)),
      issuetype: renderIssueType(base, refs.issueType(issue.issueTypeId)),
    },
  };
}

/**
 * One issue bean. `refs` supplies: user, project, status, priority, issueType, sprint, boardOfSprint,
 * parentOf(issue), subtasksOf(issue), commentsOf(issue), transitionsOf(issue).
 * `options`: { fields: string[] (resolved), expand: Set<string> }.
 */
export function renderIssue(base, issue, refs, options) {
  const fields = {};
  for (const field of options.fields) fields[field] = renderField(base, issue, field, refs);
  const bean = {
    expand: [...options.expand].filter((entry) => entry === "names" || entry === "transitions").join(","),
    id: issue.id,
    self: `${base}/rest/api/3/issue/${issue.id}`,
    key: issue.key,
    fields,
  };
  if (options.expand.has("names")) {
    const names = {};
    for (const field of options.fields) names[field] = FIELD_NAMES[field];
    bean.names = names;
  }
  if (options.expand.has("transitions")) bean.transitions = refs.transitionsOf(issue);
  return bean;
}

function renderField(base, issue, field, refs) {
  switch (field) {
    case "summary":
      return issue.summary;
    case "description":
      return issue.description;
    case "issuetype":
      return renderIssueType(base, refs.issueType(issue.issueTypeId));
    case "project":
      return renderProjectCompact(base, refs.project(issue.projectId));
    case "status":
      return renderStatus(base, refs.status(issue.statusId));
    case "statuscategorychangedate":
      return issue.statusCategoryChangeDate;
    case "priority":
      return renderPriority(base, refs.priority(issue.priorityId));
    case "resolution":
      return issue.resolutionId === null ? null : renderResolution(base, issue.resolutionId);
    case "resolutiondate":
      return issue.resolutionDate;
    case "assignee":
      return issue.assigneeAccountId === null ? null : renderUser(base, refs.user(issue.assigneeAccountId));
    case "reporter":
      return renderUser(base, refs.user(issue.reporterAccountId));
    case "creator":
      return renderUser(base, refs.user(issue.creatorAccountId));
    case "labels":
      return [...issue.labels];
    case "parent": {
      const parent = refs.parentOf(issue);
      return parent === null ? null : renderIssueCompact(base, parent, refs);
    }
    case "subtasks":
      return refs.subtasksOf(issue).map((subtask) => renderIssueCompact(base, subtask, refs));
    case "duedate":
      return issue.dueDate;
    case "created":
      return issue.created;
    case "updated":
      return issue.updated;
    case "customfield_10020": {
      if (issue.sprintId === null) return null;
      const sprint = refs.sprint(issue.sprintId);
      return sprint === null ? null : [renderSprintField(sprint, sprint.boardId)];
    }
    case "comment": {
      const comments = refs.commentsOf(issue);
      return {
        comments: comments.slice(0, INLINE_COMMENT_LIMIT).map((comment) => renderComment(base, comment, refs)),
        self: `${base}/rest/api/3/issue/${issue.id}/comment`,
        maxResults: INLINE_COMMENT_LIMIT,
        total: comments.length,
        startAt: 0,
      };
    }
    default:
      return null;
  }
}

/** `parent` is rendered as `null` only when requested and absent; Jira omits it — mirror that. */
export function stripAbsentParent(bean) {
  if (bean.fields !== undefined && bean.fields.parent === null) delete bean.fields.parent;
  return bean;
}
