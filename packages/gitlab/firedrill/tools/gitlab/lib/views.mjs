// GitLab REST v4 resource shapes computed from stored rows. Pure functions; callers pass resolved rows.

export function instanceOrigin(project) {
  const match = /^(https:\/\/[^/]+)/.exec(project.web_url);
  return match === null ? "https://gitlab.example.test" : match[1];
}

const apiBase = (project) => `${instanceOrigin(project)}/api/v4`;

export function basicUser(user, origin) {
  if (user === null || user === undefined) {
    return { id: 0, username: "ghost", name: "Ghost User", state: "active", locked: false, avatar_url: "", web_url: `${origin}/ghost` };
  }
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    state: user.state,
    locked: false,
    avatar_url: user.avatar_url,
    web_url: user.web_url,
  };
}

export function publicUser(user) {
  return {
    ...basicUser(user, ""),
    created_at: user.created_at,
    bio: user.bio,
    location: "",
    public_email: null,
    job_title: user.job_title,
    organization: user.organization,
    bot: user.bot,
    last_activity_on: user.last_activity_on,
  };
}

export function currentUser(user, serverTime) {
  return {
    ...publicUser(user),
    email: user.email,
    is_admin: user.is_admin,
    can_create_project: user.external !== true,
    two_factor_enabled: false,
    external: user.external,
    private_profile: false,
    server_time: serverTime,
  };
}

export function projectView(project, level, hasReadme) {
  const origin = instanceOrigin(project);
  const host = origin.replace(/^https:\/\//, "");
  const api = `${apiBase(project)}/projects/${project.id}`;
  return {
    id: project.id,
    description: project.description,
    name: project.name,
    name_with_namespace: project.name_with_namespace,
    path: project.path,
    path_with_namespace: project.path_with_namespace,
    created_at: project.created_at,
    default_branch: project.default_branch,
    tag_list: [...project.topics],
    topics: [...project.topics],
    ssh_url_to_repo: `git@${host}:${project.path_with_namespace}.git`,
    http_url_to_repo: `${project.web_url}.git`,
    web_url: project.web_url,
    readme_url: hasReadme ? `${project.web_url}/-/blob/${project.default_branch}/README.md` : null,
    forks_count: project.forks_count,
    avatar_url: null,
    star_count: project.star_count,
    last_activity_at: project.last_activity_at,
    namespace: {
      id: project.namespace.id,
      name: project.namespace.name,
      path: project.namespace.path,
      kind: project.namespace.kind,
      full_path: project.namespace.full_path,
      parent_id: null,
      avatar_url: null,
      web_url: `${origin}/${project.namespace.full_path}`,
    },
    visibility: project.visibility,
    archived: project.archived,
    empty_repo: !hasReadme && project.default_branch === null,
    issues_enabled: project.issues_enabled,
    merge_requests_enabled: project.merge_requests_enabled,
    open_issues_count: project.open_issues_count,
    merge_method: project.merge_method,
    squash_option: project.squash_option,
    remove_source_branch_after_merge: project.remove_source_branch_after_merge,
    only_allow_merge_if_all_discussions_are_resolved: project.only_allow_merge_if_all_discussions_are_resolved,
    creator_id: project.creator_id,
    _links: {
      self: api,
      issues: `${api}/issues`,
      merge_requests: `${api}/merge_requests`,
      repo_branches: `${api}/repository/branches`,
      labels: `${api}/labels`,
      members: `${api}/members`,
    },
    permissions: {
      project_access: level === null ? null : { access_level: level, notification_level: 3 },
      group_access: null,
    },
  };
}

export function labelView(label, counts) {
  const view = {
    id: label.id,
    name: label.name,
    color: label.color,
    text_color: label.text_color,
    description: label.description,
    priority: label.priority,
    is_project_label: true,
    subscribed: false,
  };
  if (counts !== undefined) {
    view.open_issues_count = counts.open_issues_count;
    view.closed_issues_count = counts.closed_issues_count;
    view.open_merge_requests_count = counts.open_merge_requests_count;
  }
  return view;
}

export function commitView(project, commit, withStats) {
  const view = {
    id: commit.id,
    short_id: commit.short_id,
    created_at: commit.committed_date,
    parent_ids: [...commit.parent_ids],
    title: commit.title,
    message: commit.message,
    author_name: commit.author_name,
    author_email: commit.author_email,
    authored_date: commit.authored_date,
    committer_name: commit.committer_name,
    committer_email: commit.committer_email,
    committed_date: commit.committed_date,
    trailers: {},
    extended_trailers: {},
    web_url: `${project.web_url}/-/commit/${commit.id}`,
  };
  if (withStats) view.stats = { ...commit.stats };
  return view;
}

export function branchView(project, branch, commit, merged, canPush) {
  return {
    name: branch.name,
    merged,
    protected: branch.protected,
    default: branch.name === project.default_branch,
    developers_can_push: branch.developers_can_push,
    developers_can_merge: branch.developers_can_merge,
    can_push: canPush,
    web_url: `${project.web_url}/-/tree/${branch.name}`,
    commit: commitView(project, commit, false),
  };
}

function taskStatus(description) {
  const tasks = description.match(/^\s*[-*+] \[[ xX]\]/gm) ?? [];
  const done = tasks.filter((task) => /\[[xX]\]/.test(task)).length;
  return { count: tasks.length, completed_count: done };
}

const TIME_STATS = Object.freeze({ time_estimate: 0, total_time_spent: 0, human_time_estimate: null, human_total_time_spent: null });

export function issueView(project, issue, userOf, labelsOf) {
  const origin = instanceOrigin(project);
  const api = `${apiBase(project)}/projects/${project.id}/issues/${issue.iid}`;
  const assignees = issue.assignee_ids.map((id) => basicUser(userOf(id), origin));
  const tasks = taskStatus(issue.description);
  return {
    id: issue.id,
    iid: issue.iid,
    project_id: issue.project_id,
    title: issue.title,
    description: issue.description,
    state: issue.state,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    closed_by: issue.closed_by_id === null ? null : basicUser(userOf(issue.closed_by_id), origin),
    labels: labelsOf === undefined ? [...issue.labels] : labelsOf(issue.labels),
    milestone: null,
    assignees,
    assignee: assignees.length > 0 ? assignees[0] : null,
    author: basicUser(userOf(issue.author_id), origin),
    type: issue.issue_type === "incident" ? "INCIDENT" : "ISSUE",
    issue_type: issue.issue_type,
    user_notes_count: issue.user_notes_count,
    merge_requests_count: 0,
    upvotes: 0,
    downvotes: 0,
    due_date: issue.due_date,
    confidential: issue.confidential,
    discussion_locked: issue.discussion_locked,
    web_url: `${project.web_url}/-/issues/${issue.iid}`,
    time_stats: { ...TIME_STATS },
    task_completion_status: tasks,
    has_tasks: tasks.count > 0,
    references: { short: `#${issue.iid}`, relative: `#${issue.iid}`, full: `${project.path_with_namespace}#${issue.iid}` },
    _links: {
      self: api,
      notes: `${api}/notes`,
      award_emoji: `${api}/award_emoji`,
      project: `${apiBase(project)}/projects/${project.id}`,
      closed_as_duplicate_of: null,
    },
    subscribed: false,
  };
}

export function noteView(project, note, userOf) {
  return {
    id: note.id,
    type: null,
    body: note.body,
    author: basicUser(userOf(note.author_id), instanceOrigin(project)),
    created_at: note.created_at,
    updated_at: note.updated_at,
    system: note.system,
    noteable_id: note.noteable_id,
    noteable_type: note.noteable_type,
    noteable_iid: note.noteable_iid,
    project_id: note.project_id,
    resolvable: false,
    confidential: note.internal,
    internal: note.internal,
    imported: false,
    imported_from: "none",
  };
}

/** Deprecated `merge_status` derived from the detailed status. */
function mergeStatusOf(mergeRequest) {
  if (mergeRequest.state === "merged") return "can_be_merged";
  if (mergeRequest.state !== "opened") return "unchecked";
  if (mergeRequest.has_conflicts || mergeRequest.detailed_merge_status === "commits_status") return "cannot_be_merged";
  return "can_be_merged";
}

/** Merge request in GitLab's list shape (`basic`) or single-resource shape (adds diff_refs, merge_error, user, changes_count). */
export function mergeRequestView(project, mergeRequest, userOf, extra) {
  const origin = instanceOrigin(project);
  const user = (id) => (id === null ? null : basicUser(userOf(id), origin));
  const assignees = mergeRequest.assignee_ids.map((id) => basicUser(userOf(id), origin));
  const tasks = taskStatus(mergeRequest.description);
  const view = {
    id: mergeRequest.id,
    iid: mergeRequest.iid,
    project_id: mergeRequest.project_id,
    title: mergeRequest.title,
    description: mergeRequest.description,
    state: mergeRequest.state,
    created_at: mergeRequest.created_at,
    updated_at: mergeRequest.updated_at,
    merged_by: user(mergeRequest.merged_by_id),
    merge_user: user(mergeRequest.merged_by_id),
    merged_at: mergeRequest.merged_at,
    closed_by: user(mergeRequest.closed_by_id),
    closed_at: mergeRequest.closed_at,
    target_branch: mergeRequest.target_branch,
    source_branch: mergeRequest.source_branch,
    user_notes_count: mergeRequest.user_notes_count,
    upvotes: 0,
    downvotes: 0,
    author: basicUser(userOf(mergeRequest.author_id), origin),
    assignees,
    assignee: assignees.length > 0 ? assignees[0] : null,
    reviewers: mergeRequest.reviewer_ids.map((id) => basicUser(userOf(id), origin)),
    source_project_id: mergeRequest.project_id,
    target_project_id: mergeRequest.project_id,
    labels: [...mergeRequest.labels],
    draft: mergeRequest.draft,
    work_in_progress: mergeRequest.draft,
    milestone: null,
    merge_when_pipeline_succeeds: false,
    merge_status: mergeStatusOf(mergeRequest),
    detailed_merge_status: mergeRequest.detailed_merge_status,
    sha: mergeRequest.sha,
    merge_commit_sha: mergeRequest.merge_commit_sha,
    squash_commit_sha: mergeRequest.squash_commit_sha,
    discussion_locked: mergeRequest.discussion_locked,
    should_remove_source_branch: mergeRequest.should_remove_source_branch,
    force_remove_source_branch: mergeRequest.force_remove_source_branch,
    reference: `!${mergeRequest.iid}`,
    references: {
      short: `!${mergeRequest.iid}`,
      relative: `!${mergeRequest.iid}`,
      full: `${project.path_with_namespace}!${mergeRequest.iid}`,
    },
    web_url: `${project.web_url}/-/merge_requests/${mergeRequest.iid}`,
    time_stats: { ...TIME_STATS },
    squash: mergeRequest.squash,
    squash_on_merge: mergeRequest.squash || project.squash_option === "always",
    task_completion_status: tasks,
    has_conflicts: mergeRequest.has_conflicts,
    blocking_discussions_resolved: true,
  };
  if (extra !== undefined) {
    view.diff_refs = { ...mergeRequest.diff_refs };
    view.merge_error = null;
    view.user = { can_merge: extra.canMerge };
    view.head_pipeline = null;
    view.changes_count = extra.changesCount;
  }
  return view;
}
