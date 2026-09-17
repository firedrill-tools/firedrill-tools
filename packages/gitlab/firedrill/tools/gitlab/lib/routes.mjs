// GitLab REST v4 route codecs over the canonical operations. Decoders map path/query/body onto canonical arguments and
// never throw on caller input: malformed values pass through so the operation reports GitLab's own 400/404. Encoders
// unwrap list results into bare arrays plus `x-*`/`link` headers and render GitLab's error envelopes.
import {
  defined,
  errorBody,
  field,
  isRateLimited,
  jsonBody,
  operationInput,
  pageHeaders,
  param,
  pathInt,
  pathText,
  q,
  qAll,
  qBool,
  qInt,
  qPage,
  rateLimitedResponse,
} from "./wire.mjs";

const PATH_ARGUMENTS = new Set(["project_id", "id", "issue_iid", "work_item_iid", "merge_request_iid", "include", "me", "raw"]);

const COMMIT_DIFF_ARGUMENTS = new Set([...PATH_ARGUMENTS, "commit_sha"]);

const projectPath = (args) => `/api/v4/projects/${encodeURIComponent(String(args.project_id ?? args.id ?? ""))}`;

function okValue(outcome) {
  return outcome.status === "ok" && typeof outcome.value === "object" && outcome.value !== null ? outcome.value : undefined;
}

function failure(outcome) {
  if (isRateLimited(outcome)) return rateLimitedResponse();
  return { body: { kind: "json", value: errorBody(outcome) } };
}

/** Single-resource route: `select` maps the canonical value to the REST body. */
function route(decode, select = (value) => value, options = {}) {
  return {
    decode,
    encode({ outcome }) {
      const value = okValue(outcome);
      if (value === undefined) return failure(outcome);
      if (options.empty) return { body: { kind: "empty" } };
      const headers = options.headers === undefined ? undefined : options.headers(value);
      const body = options.text ? { kind: "text", value: select(value), contentType: "text/plain; charset=utf-8" } : { kind: "json", value: select(value) };
      return headers === undefined ? { body } : { headers, body };
    },
  };
}

/** List route: bare array body plus GitLab pagination headers rebuilt from the invocation arguments. */
function listRoute(decode, pathOf) {
  return {
    decode,
    encode({ invocation, outcome }) {
      const value = okValue(outcome);
      if (value === undefined) return failure(outcome);
      const args = invocation.arguments ?? {};
      return { headers: pageHeaders(value.page, pathOf(args), args, PATH_ARGUMENTS), body: { kind: "json", value: value.items } };
    },
  };
}

const iids = (request) => {
  const values = [...(qAll(request, "iids[]") ?? []), ...(qAll(request, "iids") ?? [])];
  return values.length === 0 ? undefined : values.map((value) => (/^[0-9]{1,9}$/.test(value) ? Number(value) : value));
};

/** Any `not[...]` query parameter (negated filters are not supported). */
function negated(request) {
  return Object.keys(request.query).some((name) => name.startsWith("not[")) ? "not" : undefined;
}

/** `assignee_id` / `assignee_ids` style body values: a single id becomes a one-element list. */
function idList(body, request, listName, singleName) {
  const list = field(body, listName);
  if (list !== undefined) return list;
  const listed = qAll(request, `${listName}[]`);
  if (listed !== undefined) return listed.map((value) => (/^[0-9]{1,9}$/.test(value) ? Number(value) : value));
  const single = field(body, singleName) ?? qInt(request, singleName);
  return single === undefined ? undefined : [single];
}

function issueWriteArgs(request, body) {
  return {
    title: param(request, body, "title"),
    description: param(request, body, "description"),
    assignee_ids: idList(body, request, "assignee_ids", "assignee_id"),
    labels: param(request, body, "labels"),
    confidential: field(body, "confidential") ?? qBool(request, "confidential"),
    issue_type: param(request, body, "issue_type"),
    due_date: param(request, body, "due_date"),
    milestone_id: field(body, "milestone_id") ?? qInt(request, "milestone_id"),
    epic_id: field(body, "epic_id") ?? qInt(request, "epic_id"),
  };
}

function mergeRequestWriteArgs(request, body) {
  return {
    title: param(request, body, "title"),
    description: param(request, body, "description"),
    source_branch: param(request, body, "source_branch"),
    target_branch: param(request, body, "target_branch"),
    target_project_id: field(body, "target_project_id") ?? qInt(request, "target_project_id"),
    assignee_ids: idList(body, request, "assignee_ids", "assignee_id"),
    reviewer_ids: idList(body, request, "reviewer_ids", "reviewer_id"),
    labels: param(request, body, "labels"),
    add_labels: param(request, body, "add_labels"),
    remove_labels: param(request, body, "remove_labels"),
    remove_source_branch: field(body, "remove_source_branch") ?? qBool(request, "remove_source_branch"),
    squash: field(body, "squash") ?? qBool(request, "squash"),
    discussion_locked: field(body, "discussion_locked") ?? qBool(request, "discussion_locked"),
    allow_collaboration: field(body, "allow_collaboration") ?? qBool(request, "allow_collaboration"),
    milestone_id: field(body, "milestone_id") ?? qInt(request, "milestone_id"),
  };
}

export const http = {
  "get-current-user": route(
    () => ({ arguments: { me: true } }),
    ({ server_time: _serverTime, ...user }) => user,
  ),
  "get-user": route((request) => ({ arguments: { id: pathInt(request, "user_id") } })),
  "list-projects": listRoute(
    (request) => ({
      arguments: defined({
        search: q(request, "search"),
        visibility: q(request, "visibility"),
        archived: qBool(request, "archived"),
        membership: qBool(request, "membership"),
        min_access_level: qInt(request, "min_access_level"),
        owned: qBool(request, "owned"),
        order_by: q(request, "order_by"),
        sort: q(request, "sort"),
        ...qPage(request),
      }),
    }),
    () => "/api/v4/projects",
  ),
  "get-project": route((request) => ({ arguments: { project_id: pathText(request, "id") } })),
  "list-labels": listRoute(
    (request) => ({
      arguments: defined({
        id: pathText(request, "id"),
        search: q(request, "search"),
        with_counts: qBool(request, "with_counts"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/labels`,
  ),
  "list-branches": listRoute(
    (request) => ({
      arguments: defined({ id: pathText(request, "id"), search: q(request, "search"), regex: q(request, "regex"), ...qPage(request) }),
    }),
    (args) => `${projectPath(args)}/repository/branches`,
  ),
  "get-branch": route((request) => ({ arguments: { id: pathText(request, "id"), branch: pathText(request, "branch") } })),
  "create-branch": route((request) => {
    const body = jsonBody(request);
    return operationInput(request, defined({ project_id: pathText(request, "id"), branch: param(request, body, "branch"), ref: param(request, body, "ref") }));
  }),
  "list-commits": listRoute(
    (request) => ({
      arguments: defined({
        project_id: pathText(request, "id"),
        ref_name: q(request, "ref_name"),
        since: q(request, "since"),
        until: q(request, "until"),
        path: q(request, "path"),
        author: q(request, "author"),
        all: qBool(request, "all"),
        with_stats: qBool(request, "with_stats"),
        first_parent: qBool(request, "first_parent"),
        order: q(request, "order"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/repository/commits`,
  ),
  "get-commit": route((request) => ({
    arguments: defined({ project_id: pathText(request, "id"), commit_sha: pathText(request, "sha"), stats: qBool(request, "stats") }),
  })),
  "get-commit-diff": {
    decode: (request) => ({
      arguments: defined({ project_id: pathText(request, "id"), commit_sha: pathText(request, "sha"), include: ["diff"], ...qPage(request) }),
    }),
    encode({ invocation, outcome }) {
      const value = okValue(outcome);
      if (value === undefined) return failure(outcome);
      const args = invocation.arguments ?? {};
      const pathname = `${projectPath(args)}/repository/commits/${encodeURIComponent(String(args.commit_sha ?? ""))}/diff`;
      return { headers: pageHeaders(value.diffs_page, pathname, args, COMMIT_DIFF_ARGUMENTS), body: { kind: "json", value: value.diffs ?? [] } };
    },
  },
  "create-commit": route((request) => {
    const body = jsonBody(request);
    return operationInput(
      request,
      defined({
        project_id: pathText(request, "id"),
        branch: param(request, body, "branch"),
        commit_message: param(request, body, "commit_message"),
        start_branch: param(request, body, "start_branch"),
        start_sha: param(request, body, "start_sha"),
        start_project: field(body, "start_project") ?? q(request, "start_project"),
        actions: field(body, "actions"),
        author_email: param(request, body, "author_email"),
        author_name: param(request, body, "author_name"),
      }),
    );
  }),
  "get-file": route(
    (request) => ({ arguments: defined({ project_id: pathText(request, "id"), file_path: pathText(request, "file_path"), ref: q(request, "ref") }) }),
    ({ text: _text, ...file }) => file,
    {
      headers: (file) => ({
        "x-gitlab-blob-id": file.blob_id,
        "x-gitlab-commit-id": file.commit_id,
        "x-gitlab-content-sha256": file.content_sha256,
        "x-gitlab-encoding": file.encoding,
        "x-gitlab-execute-filemode": "false",
        "x-gitlab-file-name": encodeURIComponent(file.file_name),
        "x-gitlab-file-path": encodeURIComponent(file.file_path),
        "x-gitlab-last-commit-id": file.last_commit_id ?? "",
        "x-gitlab-ref": encodeURIComponent(file.ref),
        "x-gitlab-size": String(file.size),
      }),
    },
  ),
  "get-file-raw": route(
    (request) => ({
      arguments: defined({ project_id: pathText(request, "id"), file_path: pathText(request, "file_path"), ref: q(request, "ref"), raw: true }),
    }),
    (file) => file.text,
    { text: true },
  ),
  "list-tree": listRoute(
    (request) => ({
      arguments: defined({
        project_id: pathText(request, "id"),
        path: q(request, "path"),
        ref: q(request, "ref"),
        recursive: qBool(request, "recursive"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/repository/tree`,
  ),
  "list-issues": listRoute(
    (request) => ({
      arguments: defined({
        id: pathText(request, "id"),
        state: q(request, "state"),
        labels: q(request, "labels"),
        search: q(request, "search"),
        in: q(request, "in"),
        assignee_id: qInt(request, "assignee_id"),
        assignee_username: q(request, "assignee_username"),
        author_id: qInt(request, "author_id"),
        author_username: q(request, "author_username"),
        confidential: qBool(request, "confidential"),
        iids: iids(request),
        created_after: q(request, "created_after"),
        created_before: q(request, "created_before"),
        updated_after: q(request, "updated_after"),
        updated_before: q(request, "updated_before"),
        order_by: q(request, "order_by"),
        sort: q(request, "sort"),
        with_labels_details: qBool(request, "with_labels_details"),
        milestone: q(request, "milestone"),
        scope: q(request, "scope"),
        my_reaction_emoji: q(request, "my_reaction_emoji"),
        weight: q(request, "weight"),
        not: negated(request),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/issues`,
  ),
  "get-issue": route((request) => ({ arguments: { id: pathText(request, "id"), issue_iid: pathInt(request, "issue_iid") } })),
  "create-issue": route((request) =>
    operationInput(request, defined({ id: pathText(request, "id"), ...issueWriteArgs(request, jsonBody(request)) })),
  ),
  "update-issue": route((request) => {
    const body = jsonBody(request);
    return operationInput(
      request,
      defined({
        id: pathText(request, "id"),
        issue_iid: pathInt(request, "issue_iid"),
        ...issueWriteArgs(request, body),
        state_event: param(request, body, "state_event"),
        add_labels: param(request, body, "add_labels"),
        remove_labels: param(request, body, "remove_labels"),
        discussion_locked: field(body, "discussion_locked") ?? qBool(request, "discussion_locked"),
      }),
    );
  }),
  "delete-issue": route(
    (request) => operationInput(request, { id: pathText(request, "id"), issue_iid: pathInt(request, "issue_iid") }),
    (value) => value,
    { empty: true },
  ),
  "list-issue-notes": listRoute(
    (request) => ({
      arguments: defined({
        id: pathText(request, "id"),
        issue_iid: pathInt(request, "issue_iid"),
        sort: q(request, "sort"),
        order_by: q(request, "order_by"),
        activity_filter: q(request, "activity_filter"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/issues/${args.issue_iid}/notes`,
  ),
  "create-issue-note": route((request) => {
    const body = jsonBody(request);
    return operationInput(
      request,
      defined({
        project_id: pathText(request, "id"),
        work_item_iid: pathInt(request, "issue_iid"),
        body: param(request, body, "body"),
        internal: field(body, "internal") ?? field(body, "confidential") ?? qBool(request, "internal"),
      }),
    );
  }),
  "list-merge-requests": listRoute(
    (request) => ({
      arguments: defined({
        project_id: pathText(request, "id"),
        state: q(request, "state"),
        scope: q(request, "scope"),
        author_username: q(request, "author_username"),
        author_id: qInt(request, "author_id"),
        assignee_username: q(request, "assignee_username"),
        reviewer_username: q(request, "reviewer_username"),
        labels: q(request, "labels"),
        search: q(request, "search"),
        source_branch: q(request, "source_branch"),
        target_branch: q(request, "target_branch"),
        draft: q(request, "draft") ?? q(request, "wip"),
        milestone: q(request, "milestone"),
        order_by: q(request, "order_by"),
        sort: q(request, "sort"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/merge_requests`,
  ),
  "get-merge-request": route((request) => ({
    arguments: { project_id: pathText(request, "id"), merge_request_iid: pathInt(request, "merge_request_iid") },
  })),
  "create-merge-request": route((request) =>
    operationInput(request, defined({ project_id: pathText(request, "id"), ...mergeRequestWriteArgs(request, jsonBody(request)) })),
  ),
  "update-merge-request": route((request) => {
    const body = jsonBody(request);
    return operationInput(
      request,
      defined({
        project_id: pathText(request, "id"),
        merge_request_iid: pathInt(request, "merge_request_iid"),
        ...mergeRequestWriteArgs(request, body),
        state_event: param(request, body, "state_event"),
      }),
    );
  }),
  "list-merge-request-commits": listRoute(
    (request) => ({ arguments: defined({ id: pathText(request, "id"), merge_request_iid: pathInt(request, "merge_request_iid"), ...qPage(request) }) }),
    (args) => `${projectPath(args)}/merge_requests/${args.merge_request_iid}/commits`,
  ),
  "list-merge-request-diffs": listRoute(
    (request) => ({
      arguments: defined({
        id: pathText(request, "id"),
        merge_request_iid: pathInt(request, "merge_request_iid"),
        unidiff: qBool(request, "unidiff"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/merge_requests/${args.merge_request_iid}/diffs`,
  ),
  "list-merge-request-notes": listRoute(
    (request) => ({
      arguments: defined({
        project_id: pathText(request, "id"),
        merge_request_iid: pathInt(request, "merge_request_iid"),
        sort: q(request, "sort"),
        order_by: q(request, "order_by"),
        ...qPage(request),
      }),
    }),
    (args) => `${projectPath(args)}/merge_requests/${args.merge_request_iid}/notes`,
  ),
  "create-merge-request-note": route((request) => {
    const body = jsonBody(request);
    return operationInput(
      request,
      defined({
        project_id: pathText(request, "id"),
        merge_request_iid: pathInt(request, "merge_request_iid"),
        body: param(request, body, "body"),
        internal: field(body, "internal") ?? qBool(request, "internal"),
      }),
    );
  }),
  "merge-merge-request": route((request) => {
    const body = jsonBody(request);
    return operationInput(
      request,
      defined({
        project_id: pathText(request, "id"),
        merge_request_iid: pathInt(request, "merge_request_iid"),
        sha: param(request, body, "sha"),
        squash: field(body, "squash") ?? qBool(request, "squash"),
        commit_message: param(request, body, "merge_commit_message"),
        squash_commit_message: param(request, body, "squash_commit_message"),
        should_remove_source_branch: field(body, "should_remove_source_branch") ?? qBool(request, "should_remove_source_branch"),
      }),
    );
  }),
};
