// Token identity, workspace members, notes and tasks.
import { caller, findMember, scopeString } from "./access.mjs";
import { PAGE_BYTES, clip, compare, encodedSize, fail, integerParam, isPlainObject, isUuid, nextId, notFound, now, rows, validation, valueNotFound } from "./common.mjs";
import { markdownToPlaintext, plaintextToMarkdown } from "./markdown.mjs";
import { begin, requireObject } from "./records.mjs";
import { normalizeDomain, normalizeEmail, parseInstant } from "./values.mjs";

const MAX_NOTE_CONTENT = 100_000;
const MAX_LINKS = 50;

function epochSeconds(iso) {
  const parsed = parseInstant(iso);
  if (parsed === undefined) return 0;
  const [date, time] = parsed.timestamp.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = time.slice(0, 8).split(":").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss) / 1_000);
}

export function selfIdentify(_input, context) {
  const who = caller(context);
  const ws = who.workspace;
  return {
    active: true,
    scope: scopeString(who),
    client_id: ws.client_id,
    token_type: "Bearer",
    exp: null,
    iat: epochSeconds(ws.token_issued_at),
    sub: ws.workspace_id,
    aud: ws.client_id,
    iss: "attio.com",
    authorized_by_workspace_member_id: who.member.workspace_member_id,
    workspace_id: ws.workspace_id,
    workspace_name: ws.workspace_name,
    workspace_slug: ws.workspace_slug,
    workspace_logo_url: ws.workspace_logo_url,
    server_time: now(context),
  };
}

export function workspaceMembersList(_input, context) {
  const env = begin(context, ["user_management:read"]);
  const data = rows(context, "workspace-members", { bounded: true }).map((member) => ({
    id: { workspace_id: env.ws.workspace_id, workspace_member_id: member.workspace_member_id },
    first_name: member.first_name,
    last_name: member.last_name,
    avatar_url: member.avatar_url,
    email_address: member.email_address,
    created_at: member.created_at,
    access_level: member.access_level,
  }));
  return { data };
}

// ------------------------------------------------------------------------------------------------------------
// Notes

function noteOut(env, row) {
  return {
    id: { workspace_id: env.ws.workspace_id, note_id: row.note_id },
    parent_object: row.parent_object,
    parent_record_id: row.parent_record_id,
    title: row.title,
    meeting_id: null,
    content_plaintext: row.content_plaintext,
    content_markdown: row.content_markdown,
    tags: [],
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
  };
}

function requireNote(context, noteId) {
  const row = isUuid(noteId) ? context.state.get("notes", noteId) : null;
  if (row === null) return notFound(context, `Note with ID "${clip(String(noteId))}" not found.`);
  return row;
}

export function notesList(input, context) {
  const env = begin(context, ["note:read", "record_permission:read"]);
  const limit = integerParam(context, input.limit, "limit", { min: 1, max: 50, fallback: 10 });
  const offset = integerParam(context, input.offset, "offset", { min: 0, max: 1_000_000_000, fallback: 0 });
  const hasObject = input.parent_object !== undefined && input.parent_object !== null;
  const hasRecord = input.parent_record_id !== undefined && input.parent_record_id !== null;
  if (hasObject !== hasRecord) return validation(context, "parent_object and parent_record_id must be provided together.");
  let object = null;
  if (hasObject) {
    object = requireObject(context, input.parent_object);
    if (typeof input.parent_record_id !== "string") return validation(context, `"parent_record_id" must be a string.`);
  }
  const matched = rows(context, "notes", { bounded: true })
    .filter((note) => object === null || (note.parent_object === object.api_slug && note.parent_record_id === input.parent_record_id))
    .sort((a, b) => compare(b.created_at, a.created_at) || compare(b.note_id, a.note_id));
  const result = { data: matched.slice(offset, offset + limit).map((note) => noteOut(env, note)) };
  if (encodedSize(result) > PAGE_BYTES) return fail(context, "FAILED_PRECONDITION", "Response too large; lower limit");
  return result;
}

export function notesGet(input, context) {
  const env = begin(context, ["note:read", "record_permission:read"]);
  return { data: noteOut(env, requireNote(context, input.note_id)) };
}

export function notesCreate(input, context) {
  const env = begin(context, ["note:read-write", "record_permission:read"]);
  const data = input.data;
  if (!isPlainObject(data)) return validation(context, `Expected "data" to be an object.`);
  const object = requireObject(context, data.parent_object);
  const parent = isUuid(data.parent_record_id) ? context.state.get(object.api_slug, data.parent_record_id) : null;
  if (parent === null) return notFound(context, `Record with ID "${clip(String(data.parent_record_id))}" not found.`);
  if (typeof data.title !== "string" || data.title.length > 1_000) return validation(context, `"data.title" must be a string of at most 1000 characters.`);
  if (data.format !== "plaintext" && data.format !== "markdown") return validation(context, `"data.format" must be "plaintext" or "markdown".`);
  if (typeof data.content !== "string") return validation(context, `"data.content" must be a string.`);
  if (data.content.length > MAX_NOTE_CONTENT) {
    return fail(context, "CONTENT_TOO_LARGE", `Note content exceeds the maximum length of ${MAX_NOTE_CONTENT} characters.`);
  }
  if (data.meeting_id !== undefined && data.meeting_id !== null) return validation(context, `"data.meeting_id" must be null: meetings are not simulated.`);
  let createdAt = env.now;
  if (data.created_at !== undefined && data.created_at !== null) {
    const parsed = parseInstant(data.created_at);
    if (parsed === undefined || !parsed.hasTime) return validation(context, `"data.created_at" must be an ISO 8601 timestamp.`);
    createdAt = parsed.timestamp;
  }
  const noteId = nextId(context, "00000007");
  const row = {
    note_id: noteId,
    parent_object: object.api_slug,
    parent_record_id: parent.record_id,
    title: data.title,
    format: data.format,
    content_plaintext: data.format === "markdown" ? markdownToPlaintext(data.content) : data.content,
    content_markdown: data.format === "markdown" ? data.content : plaintextToMarkdown(data.content),
    meeting_id: null,
    tags: [],
    created_by_actor: env.actor,
    created_at: createdAt,
  };
  context.state.put("notes", noteId, row);
  return { data: noteOut(env, row) };
}

export function notesDelete(input, context) {
  begin(context, ["note:read-write", "record_permission:read"]);
  const row = requireNote(context, input.note_id);
  context.state.delete("notes", row.note_id);
  return {};
}

// ------------------------------------------------------------------------------------------------------------
// Tasks

const TASK_SORTS = new Set(["created_at:asc", "created_at:desc", "completed_at:asc", "completed_at:desc"]);
const TASK_UPDATE_FIELDS = new Set(["deadline_at", "is_completed", "linked_records", "assignees"]);

function taskOut(env, row) {
  return {
    id: { workspace_id: env.ws.workspace_id, task_id: row.task_id },
    content_plaintext: row.content_plaintext,
    deadline_at: row.deadline_at,
    is_completed: row.is_completed,
    completed_at: row.completed_at,
    linked_records: row.linked_records,
    assignees: row.assignees,
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
  };
}

function requireTask(context, taskId) {
  const row = isUuid(taskId) ? context.state.get("tasks", taskId) : null;
  if (row === null) return notFound(context, `Task with ID "${clip(String(taskId))}" not found.`);
  return row;
}

function findByUnique(context, object, slug, field, raw) {
  const normalized = slug === "email_addresses" ? normalizeEmail(raw)?.address : normalizeDomain(raw);
  if (normalized === undefined) return null;
  return rows(context, object.api_slug, { bounded: true }).find((row) => Object.hasOwn(row.values, slug) && row.values[slug].some((entry) => entry[field] === normalized)) ?? null;
}

function resolveLinks(context, links) {
  if (!Array.isArray(links) || links.length > MAX_LINKS) return validation(context, `"linked_records" must be an array of at most ${MAX_LINKS} record links.`);
  const out = [];
  for (const link of links) {
    if (!isPlainObject(link)) return validation(context, "Each linked record must be an object with target_object and target_record_id.");
    const object = requireObject(context, link.target_object);
    let record = null;
    let label = "";
    if (typeof link.target_record_id === "string") {
      label = link.target_record_id;
      record = isUuid(link.target_record_id) ? context.state.get(object.api_slug, link.target_record_id) : null;
    } else if (typeof link.email_addresses === "string" && object.api_slug === "people") {
      label = link.email_addresses;
      record = findByUnique(context, object, "email_addresses", "email_address", link.email_addresses);
    } else if (typeof link.domains === "string" && object.api_slug === "companies") {
      label = link.domains;
      record = findByUnique(context, object, "domains", "domain", link.domains);
    } else {
      return validation(context, "Each linked record needs target_record_id, or email_addresses (people) or domains (companies).");
    }
    if (record === null) return notFound(context, `Record "${clip(label)}" of object "${object.api_slug}" not found.`);
    if (!out.some((item) => item.target_record_id === record.record_id)) out.push({ target_object_id: object.object_id, target_record_id: record.record_id });
  }
  return out;
}

function resolveAssignees(context, assignees) {
  if (!Array.isArray(assignees) || assignees.length > MAX_LINKS) return validation(context, `"assignees" must be an array of at most ${MAX_LINKS} workspace members.`);
  const out = [];
  for (const reference of assignees) {
    if (!isPlainObject(reference)) return validation(context, "Each assignee must be an object referencing a workspace member.");
    const member = findMember(context, reference);
    if (member === null) return valueNotFound(context, `Workspace member ${clip(JSON.stringify(reference))} not found.`);
    if (member.access_level === "suspended") return validation(context, "Suspended workspace members cannot be assigned tasks.");
    if (!out.some((item) => item.referenced_actor_id === member.workspace_member_id)) {
      out.push({ referenced_actor_type: "workspace-member", referenced_actor_id: member.workspace_member_id });
    }
  }
  return out;
}

function deadlineFrom(context, value) {
  if (value === null) return null;
  const parsed = parseInstant(value);
  if (parsed === undefined) return validation(context, `"deadline_at" must be an ISO 8601 timestamp or null.`);
  return parsed.timestamp;
}

export function tasksList(input, context) {
  const env = begin(context, ["task:read", "user_management:read"]);
  const limit = integerParam(context, input.limit, "limit", { min: 1, max: 500, fallback: 500 });
  const offset = integerParam(context, input.offset, "offset", { min: 0, max: 1_000_000_000, fallback: 0 });
  const sort = input.sort ?? "created_at:asc";
  if (typeof sort !== "string" || !TASK_SORTS.has(sort)) return validation(context, `"sort" must be one of ${[...TASK_SORTS].join(", ")}.`);
  const hasObject = input.linked_object !== undefined && input.linked_object !== null;
  const hasRecord = input.linked_record_id !== undefined && input.linked_record_id !== null;
  if (hasObject !== hasRecord) return validation(context, "linked_object and linked_record_id must be provided together.");
  const linkedObject = hasObject ? requireObject(context, input.linked_object) : null;
  if (hasRecord && typeof input.linked_record_id !== "string") return validation(context, `"linked_record_id" must be a string.`);
  const completed = input.is_completed;
  if (completed !== undefined && completed !== null && typeof completed !== "boolean") return validation(context, `"is_completed" must be true or false.`);
  let assigneeFilter;
  if (input.assignee === null || input.assignee === "") assigneeFilter = null;
  else if (input.assignee !== undefined) {
    const member = typeof input.assignee === "string" ? findMember(context, input.assignee) : null;
    if (member === null) return valueNotFound(context, `Workspace member "${clip(String(input.assignee))}" not found.`);
    assigneeFilter = member.workspace_member_id;
  }
  const [field, direction] = sort.split(":");
  const sign = direction === "asc" ? 1 : -1;
  const matched = rows(context, "tasks", { bounded: true })
    .filter((task) => linkedObject === null || task.linked_records.some((link) => link.target_object_id === linkedObject.object_id && link.target_record_id === input.linked_record_id))
    .filter((task) => typeof completed !== "boolean" || task.is_completed === completed)
    .filter((task) => assigneeFilter === undefined || (assigneeFilter === null ? task.assignees.length === 0 : task.assignees.some((a) => a.referenced_actor_id === assigneeFilter)))
    .sort((a, b) => {
      const left = a[field];
      const right = b[field];
      if (left !== right) {
        if (left === null) return 1;
        if (right === null) return -1;
        return compare(left, right) * sign;
      }
      return compare(a.created_at, b.created_at) || compare(a.task_id, b.task_id);
    });
  const result = { data: matched.slice(offset, offset + limit).map((task) => taskOut(env, task)) };
  if (encodedSize(result) > PAGE_BYTES) return fail(context, "FAILED_PRECONDITION", "Response too large; lower limit");
  return result;
}

export function tasksCreate(input, context) {
  const env = begin(context, ["task:read-write", "user_management:read"]);
  const data = input.data;
  if (!isPlainObject(data)) return validation(context, `Expected "data" to be an object.`);
  for (const field of ["content", "format", "deadline_at", "is_completed", "linked_records", "assignees"]) {
    if (!Object.hasOwn(data, field)) return validation(context, `Missing required field "data.${field}".`);
  }
  if (typeof data.content !== "string" || data.content.length === 0 || data.content.length > 2_000) {
    return validation(context, `"data.content" must be a string of 1 to 2000 characters.`);
  }
  if (data.format !== "plaintext") return validation(context, `"data.format" must be "plaintext".`);
  if (typeof data.is_completed !== "boolean") return validation(context, `"data.is_completed" must be true or false.`);
  const deadline = deadlineFrom(context, data.deadline_at);
  const linked = resolveLinks(context, data.linked_records);
  const assignees = resolveAssignees(context, data.assignees);
  const taskId = nextId(context, "00000008");
  const row = {
    task_id: taskId,
    content_plaintext: data.content,
    format: "plaintext",
    deadline_at: deadline,
    is_completed: data.is_completed,
    completed_at: data.is_completed ? env.now : null,
    linked_records: linked,
    assignees,
    created_by_actor: env.actor,
    created_at: env.now,
  };
  context.state.put("tasks", taskId, row);
  return { data: taskOut(env, row) };
}

export function tasksUpdate(input, context) {
  const env = begin(context, ["task:read-write", "user_management:read"]);
  const existing = requireTask(context, input.task_id);
  const data = input.data;
  if (!isPlainObject(data)) return validation(context, `Expected "data" to be an object.`);
  if (Object.hasOwn(data, "content")) return validation(context, "Task content cannot be updated.");
  const keys = Object.keys(data);
  if (keys.length === 0) return validation(context, "You passed an empty payload. Please ensure you are updating at least one property in your request.");
  for (const key of keys) if (!TASK_UPDATE_FIELDS.has(key)) return validation(context, `Unknown task field "${clip(key)}".`);
  const row = { ...existing };
  if (Object.hasOwn(data, "deadline_at")) row.deadline_at = deadlineFrom(context, data.deadline_at);
  if (Object.hasOwn(data, "is_completed")) {
    if (typeof data.is_completed !== "boolean") return validation(context, `"data.is_completed" must be true or false.`);
    if (data.is_completed && !existing.is_completed) row.completed_at = env.now;
    if (!data.is_completed) row.completed_at = null;
    row.is_completed = data.is_completed;
  }
  if (Object.hasOwn(data, "linked_records")) row.linked_records = resolveLinks(context, data.linked_records);
  if (Object.hasOwn(data, "assignees")) row.assignees = resolveAssignees(context, data.assignees);
  context.state.put("tasks", existing.task_id, row);
  return { data: taskOut(env, row) };
}

export function tasksDelete(input, context) {
  begin(context, ["task:read-write", "user_management:read"]);
  const existing = requireTask(context, input.task_id);
  context.state.delete("tasks", existing.task_id);
  return {};
}
