// Render stored rows as GitHub REST resource objects (snake_case, the same field names as the REST OpenAPI
// description). The `https://github.com` / `https://api.github.com` literals identify the simulated service in
// link fields; nothing here contacts them.
import { sha40 } from "./hash.mjs";
import { PERMISSION_RANK, labelRowId, ownValue } from "./ids.mjs";
import { fitPatch, jsonBytes, pageByBytes } from "./budget.mjs";
import { diffTrees, getCommit } from "./git.mjs";
import { treeEntries } from "./tree.mjs";

export const API = "https://api.github.com";
export const WEB = "https://github.com";

function ghostUser(login) {
  return {
    login,
    id: 0,
    node_id: "U_synthetic_0",
    type: "User",
    name: login,
    bio: "",
    company: "",
    location: "",
    blog: "",
    avatar_url: "",
    html_url: `${WEB}/${login}`,
    site_admin: false,
    public_repos: 0,
    followers: 0,
    following: 0,
    created_at: "1970-01-01T00:00:00Z",
    updated_at: "1970-01-01T00:00:00Z",
  };
}

export function userOf(context, login) {
  if (typeof login !== "string" || login.length === 0) return null;
  return context.state.get("users", login.toLowerCase()) ?? ghostUser(login);
}

export function userShort(user) {
  const url = `${API}/users/${user.login}`;
  return {
    login: user.login,
    id: user.id,
    node_id: user.node_id,
    avatar_url: user.avatar_url,
    gravatar_id: "",
    url,
    html_url: user.html_url,
    followers_url: `${url}/followers`,
    following_url: `${url}/following{/other_user}`,
    gists_url: `${url}/gists{/gist_id}`,
    starred_url: `${url}/starred{/owner}{/repo}`,
    subscriptions_url: `${url}/subscriptions`,
    organizations_url: `${url}/orgs`,
    repos_url: `${url}/repos`,
    events_url: `${url}/events{/privacy}`,
    received_events_url: `${url}/received_events`,
    type: user.type,
    site_admin: user.site_admin,
  };
}

export function userNullable(context, login) {
  const user = userOf(context, login);
  return user === null ? null : userShort(user);
}

export function privateUser(user, counts) {
  return {
    ...userShort(user),
    name: user.name,
    company: user.company,
    blog: user.blog,
    location: user.location,
    email: user.email ?? null,
    hireable: null,
    bio: user.bio,
    twitter_username: null,
    public_repos: user.public_repos,
    public_gists: 0,
    followers: user.followers,
    following: user.following,
    created_at: user.created_at,
    updated_at: user.updated_at,
    private_gists: 0,
    total_private_repos: counts.privateRepos,
    owned_private_repos: counts.ownedPrivateRepos,
    disk_usage: 0,
    collaborators: counts.collaborators,
    two_factor_authentication: true,
    plan: { name: "free", space: 976562499, collaborators: 0, private_repos: 10000 },
  };
}

export function repoView(context, repo, options = {}) {
  const full = repo.full_name;
  const base = `${API}/repos/${full}`;
  const html = `${WEB}/${full}`;
  const owner = userOf(context, repo.owner);
  const view = {
    id: repo.id,
    node_id: repo.node_id,
    name: repo.name,
    full_name: full,
    private: repo.private,
    owner: userShort(owner),
    html_url: html,
    description: repo.description,
    fork: false,
    url: base,
    forks_url: `${base}/forks`,
    keys_url: `${base}/keys{/key_id}`,
    collaborators_url: `${base}/collaborators{/collaborator}`,
    teams_url: `${base}/teams`,
    hooks_url: `${base}/hooks`,
    issue_events_url: `${base}/issues/events{/number}`,
    events_url: `${base}/events`,
    assignees_url: `${base}/assignees{/user}`,
    branches_url: `${base}/branches{/branch}`,
    tags_url: `${base}/tags`,
    blobs_url: `${base}/git/blobs{/sha}`,
    git_tags_url: `${base}/git/tags{/sha}`,
    git_refs_url: `${base}/git/refs{/sha}`,
    trees_url: `${base}/git/trees{/sha}`,
    statuses_url: `${base}/statuses/{sha}`,
    languages_url: `${base}/languages`,
    contributors_url: `${base}/contributors`,
    subscribers_url: `${base}/subscribers`,
    subscription_url: `${base}/subscription`,
    commits_url: `${base}/commits{/sha}`,
    git_commits_url: `${base}/git/commits{/sha}`,
    comments_url: `${base}/comments{/number}`,
    issue_comment_url: `${base}/issues/comments{/number}`,
    contents_url: `${base}/contents/{+path}`,
    compare_url: `${base}/compare/{base}...{head}`,
    merges_url: `${base}/merges`,
    archive_url: `${base}/{archive_format}{/ref}`,
    downloads_url: `${base}/downloads`,
    issues_url: `${base}/issues{/number}`,
    pulls_url: `${base}/pulls{/number}`,
    milestones_url: `${base}/milestones{/number}`,
    notifications_url: `${base}/notifications{?since,all,participating}`,
    labels_url: `${base}/labels{/name}`,
    releases_url: `${base}/releases{/id}`,
    deployments_url: `${base}/deployments`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.pushed_at,
    git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    clone_url: `${html}.git`,
    svn_url: html,
    homepage: repo.homepage,
    size: repo.size,
    watchers_count: repo.watchers_count,
    language: repo.language,
    has_issues: repo.has_issues,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: repo.forks_count,
    mirror_url: null,
    archived: repo.archived,
    disabled: repo.disabled,
    open_issues_count: repo.open_issues_count,
    license:
      repo.license === null
        ? null
        : { key: repo.license.key, name: repo.license.name, spdx_id: repo.license.spdx_id, url: null, node_id: `L_synthetic_${repo.license.key}` },
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [...repo.topics],
    visibility: repo.visibility,
    forks: repo.forks_count,
    open_issues: repo.open_issues_count,
    watchers: repo.watchers_count,
    default_branch: repo.default_branch,
  };
  if (options.permission !== undefined) {
    const rank = ownValue(PERMISSION_RANK, options.permission) ?? 0;
    view.permissions = { admin: rank >= 5, maintain: rank >= 4, push: rank >= 3, triage: rank >= 2, pull: true };
    view.allow_squash_merge = true;
    view.allow_merge_commit = true;
    view.allow_rebase_merge = true;
    view.allow_auto_merge = false;
    view.delete_branch_on_merge = false;
    view.network_count = repo.forks_count;
    view.subscribers_count = repo.watchers_count;
  }
  return view;
}

export function labelView(repo, label) {
  return {
    id: label.id,
    node_id: label.node_id,
    url: `${API}/repos/${repo.full_name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

export function labelsOf(context, repo, names) {
  return names.map((name) => {
    const row = context.state.get("labels", labelRowId(repo.key, name));
    return labelView(
      repo,
      row ?? { id: 0, node_id: "LA_synthetic_0", name, color: "ededed", default: false, description: "" },
    );
  });
}

function reactions(url) {
  return {
    url,
    total_count: 0,
    "+1": 0,
    "-1": 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  };
}

/** Issue object; a pull-request row renders through the same shape with the `pull_request` stub. */
export function issueView(context, repo, row, kind) {
  const base = `${API}/repos/${repo.full_name}`;
  const number = row.number;
  const url = `${base}/issues/${number}`;
  const assignees = row.assignees.map((login) => userShort(userOf(context, login)));
  const view = {
    id: row.id,
    node_id: row.node_id,
    url,
    repository_url: base,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `${WEB}/${repo.full_name}/${kind === "pr" ? "pull" : "issues"}/${number}`,
    number,
    state: row.state,
    state_reason: kind === "pr" ? null : row.state_reason,
    title: row.title,
    body: row.body,
    user: userShort(userOf(context, row.user)),
    labels: labelsOf(context, repo, row.labels),
    assignee: assignees[0] ?? null,
    assignees,
    milestone: null,
    locked: row.locked,
    active_lock_reason: row.active_lock_reason ?? null,
    comments: row.comments,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_by: kind === "pr" ? userNullable(context, row.merged_by) : userNullable(context, row.closed_by),
    author_association: row.author_association,
    reactions: reactions(`${url}/reactions`),
    timeline_url: `${url}/timeline`,
    performed_via_github_app: null,
  };
  if (kind === "pr") {
    const pullUrl = `${base}/pulls/${number}`;
    const html = `${WEB}/${repo.full_name}/pull/${number}`;
    view.pull_request = { url: pullUrl, html_url: html, diff_url: `${html}.diff`, patch_url: `${html}.patch`, merged_at: row.merged_at };
    view.draft = row.draft;
  }
  return view;
}

export function commentView(context, repo, row) {
  const base = `${API}/repos/${repo.full_name}`;
  const url = `${base}/issues/comments/${row.id}`;
  return {
    id: row.id,
    node_id: row.node_id,
    url,
    html_url: `${WEB}/${repo.full_name}/issues/${row.issue_number}#issuecomment-${row.id}`,
    issue_url: `${base}/issues/${row.issue_number}`,
    body: row.body,
    user: userShort(userOf(context, row.user)),
    author_association: row.author_association,
    created_at: row.created_at,
    updated_at: row.updated_at,
    reactions: reactions(`${url}/reactions`),
    performed_via_github_app: null,
  };
}

function refView(context, repo, ref) {
  return {
    label: ref.label,
    ref: ref.ref,
    sha: ref.sha,
    user: userShort(userOf(context, repo.owner)),
    repo: repoView(context, repo),
  };
}

export function pullView(context, repo, row, full) {
  const base = `${API}/repos/${repo.full_name}`;
  const number = row.number;
  const url = `${base}/pulls/${number}`;
  const html = `${WEB}/${repo.full_name}/pull/${number}`;
  const issueUrl = `${base}/issues/${number}`;
  const assignees = row.assignees.map((login) => userShort(userOf(context, login)));
  const view = {
    url,
    id: row.id,
    node_id: row.node_id,
    html_url: html,
    diff_url: `${html}.diff`,
    patch_url: `${html}.patch`,
    issue_url: issueUrl,
    commits_url: `${url}/commits`,
    review_comments_url: `${url}/comments`,
    review_comment_url: `${base}/pulls/comments{/number}`,
    comments_url: `${issueUrl}/comments`,
    statuses_url: `${base}/statuses/${row.head.sha}`,
    number,
    state: row.state,
    locked: row.locked,
    title: row.title,
    user: userShort(userOf(context, row.user)),
    body: row.body,
    labels: labelsOf(context, repo, row.labels),
    milestone: null,
    active_lock_reason: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    merged_at: row.merged_at,
    merge_commit_sha: row.merge_commit_sha,
    assignee: assignees[0] ?? null,
    assignees,
    requested_reviewers: row.requested_reviewers.map((login) => userShort(userOf(context, login))),
    requested_teams: [],
    head: refView(context, repo, row.head),
    base: refView(context, repo, row.base),
    _links: {
      self: { href: url },
      html: { href: html },
      issue: { href: issueUrl },
      comments: { href: `${issueUrl}/comments` },
      review_comments: { href: `${url}/comments` },
      review_comment: { href: `${base}/pulls/comments{/number}` },
      commits: { href: `${url}/commits` },
      statuses: { href: `${base}/statuses/${row.head.sha}` },
    },
    author_association: row.author_association,
    auto_merge: null,
    draft: row.draft,
  };
  if (full) {
    view.merged = row.merged;
    view.mergeable = row.mergeable;
    view.rebaseable = row.rebaseable;
    view.mergeable_state = row.mergeable_state;
    view.merged_by = userNullable(context, row.merged_by);
    view.comments = row.comments;
    view.review_comments = row.review_comments;
    view.maintainer_can_modify = row.maintainer_can_modify;
    view.commits = row.commits;
    view.additions = row.additions;
    view.deletions = row.deletions;
    view.changed_files = row.changed_files;
  }
  return view;
}

export function reviewView(context, repo, row) {
  const pullUrl = `${API}/repos/${repo.full_name}/pulls/${row.pull_number}`;
  const html = `${WEB}/${repo.full_name}/pull/${row.pull_number}#pullrequestreview-${row.id}`;
  return {
    id: row.id,
    node_id: row.node_id,
    user: userShort(userOf(context, row.user)),
    body: row.body,
    state: row.state,
    html_url: html,
    pull_request_url: pullUrl,
    _links: { html: { href: html }, pull_request: { href: pullUrl } },
    submitted_at: row.submitted_at,
    commit_id: row.commit_id,
    author_association: row.author_association,
  };
}

function person(value) {
  return { name: value.name, email: value.email, date: value.date };
}

export function diffEntryView(repo, sha, file, withPatch) {
  const entry = {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `${WEB}/${repo.full_name}/blob/${sha}/${file.filename}`,
    raw_url: `${WEB}/${repo.full_name}/raw/${sha}/${file.filename}`,
    contents_url: `${API}/repos/${repo.full_name}/contents/${file.filename}?ref=${sha}`,
  };
  if (withPatch && typeof file.patch === "string" && file.patch.length > 0) entry.patch = file.patch;
  return entry;
}

export function commitView(context, repo, row, options = {}) {
  const base = `${API}/repos/${repo.full_name}`;
  const url = `${base}/commits/${row.sha}`;
  const view = {
    url,
    sha: row.sha,
    node_id: row.node_id,
    html_url: `${WEB}/${repo.full_name}/commit/${row.sha}`,
    comments_url: `${url}/comments`,
    commit: {
      url: `${base}/git/commits/${row.sha}`,
      author: person(row.author),
      committer: person(row.committer),
      message: row.message,
      tree: { sha: row.tree_sha, url: `${base}/git/trees/${row.tree_sha}` },
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null, verified_at: null },
    },
    author: userNullable(context, row.author.login),
    committer: userNullable(context, row.committer.login),
    parents: row.parents.map((sha) => ({ sha, url: `${base}/commits/${sha}`, html_url: `${WEB}/${repo.full_name}/commit/${sha}` })),
  };
  if (options.full) {
    const detail = options.detail ?? "full_patch";
    view.stats = { ...row.stats };
    if (detail !== "none") {
      const parentTree = row.parents.length > 0 ? (getCommit(context, repo.key, row.parents[0])?.tree ?? {}) : {};
      const files = detail === "full_patch" ? diffTrees(parentTree, row.tree) : row.files;
      // Files are paged by count and bytes after the commit header; an oversized patch is omitted as on GitHub.
      const reserved = jsonBytes(view) + 64;
      const page = pageByBytes(files, options.page ?? 1, options.perPage ?? 300, (file) => fitPatch(diffEntryView(repo, row.sha, file, detail === "full_patch"), reserved), { reserved });
      view.files = page.items ?? [];
      view.total_pages = page.pages ?? 1;
    }
  }
  return view;
}

export function gitRefView(repo, branch) {
  const base = `${API}/repos/${repo.full_name}`;
  return {
    ref: `refs/heads/${branch.name}`,
    node_id: `REF_synthetic_${sha40(branch.name).slice(0, 12)}`,
    url: `${base}/git/refs/heads/${branch.name}`,
    object: { type: "commit", sha: branch.sha, url: `${base}/git/commits/${branch.sha}` },
  };
}

export function branchShortView(repo, branch) {
  const base = `${API}/repos/${repo.full_name}`;
  return {
    name: branch.name,
    commit: { sha: branch.sha, url: `${base}/commits/${branch.sha}` },
    protected: branch.protected,
    protection: { enabled: branch.protected, required_status_checks: null },
    protection_url: `${base}/branches/${branch.name}/protection`,
  };
}

export function branchFullView(context, repo, branch, commit) {
  const base = `${API}/repos/${repo.full_name}`;
  const protection = { enabled: branch.protected };
  if (branch.protection !== null) {
    protection.required_pull_request_reviews = {
      required_approving_review_count: branch.protection.required_approving_review_count,
      dismiss_stale_reviews: branch.protection.dismiss_stale_reviews,
      require_code_owner_reviews: branch.protection.require_code_owner_reviews,
    };
  }
  return {
    name: branch.name,
    commit: commitView(context, repo, commit),
    _links: { html: `${WEB}/${repo.full_name}/tree/${branch.name}`, self: `${base}/branches/${branch.name}` },
    protected: branch.protected,
    protection,
    protection_url: `${base}/branches/${branch.name}/protection`,
  };
}

function contentLinks(repo, ref, path, kind, sha) {
  const base = `${API}/repos/${repo.full_name}`;
  const self = `${base}/contents/${path}?ref=${ref}`;
  const git = kind === "dir" ? `${base}/git/trees/${sha}` : `${base}/git/blobs/${sha}`;
  const html = `${WEB}/${repo.full_name}/${kind === "dir" ? "tree" : "blob"}/${ref}/${path}`;
  return { self, git, html };
}

export function contentFileView(repo, ref, path, entry) {
  const links = contentLinks(repo, ref, path, "file", entry.sha);
  return {
    type: "file",
    encoding: "utf-8",
    size: entry.size,
    name: path.split("/").pop(),
    path,
    content: entry.content,
    sha: entry.sha,
    url: links.self,
    git_url: links.git,
    html_url: links.html,
    download_url: `${WEB}/${repo.full_name}/raw/${ref}/${path}`,
    _links: links,
  };
}

/** Direct children of `directory` in a flat tree, GitHub-style entries sorted by name. */
export function directoryEntries(repo, ref, directory, tree) {
  const prefix = directory.length === 0 ? "" : `${directory}/`;
  const children = new Map();
  for (const [path, entry] of treeEntries(tree)) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) children.set(rest, { kind: "file", entry });
    else {
      const name = rest.slice(0, slash);
      const child = children.get(name) ?? { kind: "dir", lines: [] };
      child.lines.push(`${rest.slice(slash + 1)} ${entry.sha}`);
      children.set(name, child);
    }
  }
  return [...children.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, child]) => {
      const path = `${prefix}${name}`;
      const sha = child.kind === "file" ? child.entry.sha : sha40(`tree\0${child.lines.sort().join("\n")}`);
      const links = contentLinks(repo, ref, path, child.kind, sha);
      return {
        type: child.kind,
        size: child.kind === "file" ? child.entry.size : 0,
        name,
        path,
        sha,
        url: links.self,
        git_url: links.git,
        html_url: links.html,
        download_url: child.kind === "file" ? `${WEB}/${repo.full_name}/raw/${ref}/${path}` : null,
        _links: links,
      };
    });
}
