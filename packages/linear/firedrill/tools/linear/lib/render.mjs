// Rows → Linear GraphQL object shapes. `base*` functions render the scalar fields of one type;
// the GraphQL executor adds relations from its field catalog and the canonical operations add
// one level of nested objects. Pure functions: every input is passed explicitly.

import { parseTimestamp, slugify } from "./state.mjs";

export const PRIORITY_LABELS = Object.freeze(["No priority", "Urgent", "High", "Medium", "Low"]);

export const PROJECT_STATUSES = Object.freeze({
  backlog: { id: "00000012-0000-4000-8000-000000000001", name: "Backlog", type: "backlog" },
  planned: { id: "00000012-0000-4000-8000-000000000002", name: "Planned", type: "planned" },
  started: { id: "00000012-0000-4000-8000-000000000003", name: "In Progress", type: "started" },
  paused: { id: "00000012-0000-4000-8000-000000000004", name: "Paused", type: "paused" },
  completed: { id: "00000012-0000-4000-8000-000000000005", name: "Completed", type: "completed" },
  canceled: { id: "00000012-0000-4000-8000-000000000006", name: "Canceled", type: "canceled" },
});

export const PROJECT_STATES = Object.freeze(Object.keys(PROJECT_STATUSES));
export const STATE_TYPES = Object.freeze(["triage", "backlog", "unstarted", "started", "completed", "canceled"]);

export function priorityLabel(priority) {
  return PRIORITY_LABELS[priority] ?? PRIORITY_LABELS[0];
}

export function appUrl(organization, path) {
  return `https://linear.app/${organization.urlKey}/${path}`;
}

export function issueUrl(organization, issue) {
  return appUrl(organization, `issue/${issue.identifier}/${slugify(issue.title)}`);
}

/** The viewer's suggested branch from the organization's `gitBranchFormat`. */
export function branchName(organization, issue, viewer) {
  const format = typeof organization.gitBranchFormat === "string" ? organization.gitBranchFormat : "{username}/{issueIdentifier}-{issueTitle}";
  return format
    .replace("{username}", slugify(viewer.displayName ?? viewer.name ?? "user"))
    .replace("{issueIdentifier}", issue.identifier.toLowerCase())
    .replace("{issueTitle}", slugify(issue.title).slice(0, 50).replace(/-+$/, ""));
}

export function baseOrganization(row, counts) {
  return {
    id: row.id,
    name: row.name,
    urlKey: row.urlKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    userCount: counts.userCount,
    teamCount: counts.teamCount,
    gitBranchFormat: row.gitBranchFormat,
  };
}

export function baseUser(row, organization, viewer) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    email: row.email,
    active: row.active,
    admin: row.admin === true,
    guest: row.guest === true,
    isMe: row.id === viewer.id,
    avatarUrl: row.avatarUrl ?? null,
    url: appUrl(organization, `profiles/${row.displayName}`),
    timezone: row.timezone ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function baseTeam(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    private: row.private === true,
    timezone: row.timezone ?? null,
    cyclesEnabled: row.cyclesEnabled === true,
    triageEnabled: row.triageEnabled === true,
    issueCount: row.issueCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

export function baseState(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    color: row.color,
    position: row.position,
    description: row.description ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

export function baseLabel(row) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description ?? null,
    isGroup: row.isGroup === true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

export function projectStatus(row) {
  return { ...(PROJECT_STATUSES[row.state] ?? PROJECT_STATUSES.backlog) };
}

export function projectUrl(organization, row) {
  return appUrl(organization, `project/${slugify(row.name)}-${row.slugId}`);
}

export function baseProject(row, organization, progress) {
  return {
    id: row.id,
    name: row.name,
    slugId: row.slugId,
    url: projectUrl(organization, row),
    description: row.description ?? "",
    content: row.content ?? null,
    state: row.state,
    status: projectStatus(row),
    priority: row.priority,
    priorityLabel: priorityLabel(row.priority),
    progress,
    startDate: row.startDate ?? null,
    targetDate: row.targetDate ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    canceledAt: row.canceledAt ?? null,
  };
}

export function cycleFlags(row, nowMs) {
  const starts = parseTimestamp(row.startsAt);
  const ends = parseTimestamp(row.endsAt);
  return { isActive: starts <= nowMs && nowMs < ends, isFuture: starts > nowMs, isPast: ends <= nowMs };
}

export function baseCycle(row, nowMs, progress) {
  return {
    id: row.id,
    number: row.number,
    name: row.name ?? null,
    description: row.description ?? null,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    completedAt: row.completedAt ?? null,
    ...cycleFlags(row, nowMs),
    progress,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

export function baseIssue(row, organization, viewer) {
  return {
    id: row.id,
    identifier: row.identifier,
    number: row.number,
    title: row.title,
    description: row.description ?? null,
    priority: row.priority,
    priorityLabel: priorityLabel(row.priority),
    estimate: row.estimate ?? null,
    dueDate: row.dueDate ?? null,
    url: issueUrl(organization, row),
    branchName: branchName(organization, row, viewer),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    canceledAt: row.canceledAt ?? null,
  };
}

export function commentUrl(organization, issue, comment) {
  return `${issueUrl(organization, issue)}#comment-${comment.id.slice(-8)}`;
}

export function baseComment(row, organization, issue) {
  return {
    id: row.id,
    body: row.body,
    url: commentUrl(organization, issue, row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    editedAt: row.editedAt ?? null,
    quotedText: null,
  };
}

/** Completed ÷ total (0 when empty), rounded to four decimals as a JSON number. */
export function progressOf(issues) {
  if (issues.length === 0) return 0;
  const completed = issues.filter((issue) => issue.completedAt !== null && issue.completedAt !== undefined).length;
  return Math.round((completed / issues.length) * 10_000) / 10_000;
}

export const REF_USER = (user) => (user === null ? null : { id: user.id, name: user.name, displayName: user.displayName, email: user.email });
export const REF_TEAM = (team) => (team === null ? null : { id: team.id, key: team.key, name: team.name });
export const REF_STATE = (state) => (state === null ? null : { id: state.id, name: state.name, type: state.type, color: state.color });
export const REF_LABEL = (label) => ({ id: label.id, name: label.name, color: label.color });
export const REF_PROJECT = (project) => (project === null ? null : { id: project.id, name: project.name });
export const REF_CYCLE = (cycle) => (cycle === null ? null : { id: cycle.id, number: cycle.number, name: cycle.name ?? null });
export const REF_ISSUE = (issue) => (issue === null ? null : { id: issue.id, identifier: issue.identifier, title: issue.title });
