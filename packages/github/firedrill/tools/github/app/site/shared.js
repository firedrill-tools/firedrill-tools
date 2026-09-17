// State, hash routing, hrefs and the repository shell shared by every screen of the GitHub Tool app.
import { fitRepoNav, notSimulated, outOfScopeTabs, repoActions } from "./chrome.js";
import { $, ToolError, avatar, button, call, pageAll, clear, describe, el, icon, labelChip, link, plural, timeElement } from "./ui.js";

export const state = {
  context: undefined,
  user: undefined, // authenticated user (users.get-authenticated) or undefined when UNAUTHORIZED / denied
  authError: undefined, // ToolError from users.get-authenticated, if any
  repos: undefined, // repos.list-for-authenticated-user result (cached per revision)
  route: undefined,
  repo: undefined, // repos.get view of the current repository
  branches: undefined, // { key, list } cache for the current repository
  labels: undefined, // { key, list } cache for the current repository
  navigation: 0, // incremented on every route change; async renders check it before touching the DOM
  editing: false, // a form has unsaved text: revision polling must not re-render the screen
};

export const PER_PAGE = 25;

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

/** Parse `#/a/b?x=y` into { parts: ["a","b"], query: URLSearchParams, path: "/a/b" }. */
export function parseHash(hash = location.hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path, search = ""] = raw.split("?");
  const parts = path.split("/").filter((part) => part.length > 0).map(safeDecode);
  return { parts, query: new URLSearchParams(search), path: `/${parts.join("/")}` };
}

/** decodeURIComponent that keeps a malformed escape (e.g. a hand-typed `%E0`) as literal text instead of throwing. */
function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

export function withQuery(base, params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") search.set(name, String(value));
  const text = search.toString();
  return text ? `${base}?${text}` : base;
}

export const hrefs = {
  home: () => "#/",
  user: (login) => `#/${encodeURIComponent(login)}`,
  repo: (full) => `#/${full}`,
  tree: (full, ref, path = "") => `#/${full}/tree/${ref}${path ? `/${path}` : ""}`,
  blob: (full, ref, path) => `#/${full}/blob/${ref}/${path}`,
  edit: (full, ref, path) => `#/${full}/edit/${ref}/${path}`,
  commits: (full, ref) => `#/${full}/commits/${ref}`,
  commit: (full, sha) => `#/${full}/commit/${sha}`,
  branches: (full) => `#/${full}/branches`,
  issues: (full, params) => withQuery(`#/${full}/issues`, params ?? {}),
  newIssue: (full) => `#/${full}/issues/new`,
  issue: (full, number) => `#/${full}/issues/${number}`,
  labels: (full) => `#/${full}/labels`,
  pulls: (full, params) => withQuery(`#/${full}/pulls`, params ?? {}),
  pull: (full, number, tab) => `#/${full}/pull/${number}${tab ? `/${tab}` : ""}`,
  compare: (full, base, head) => `#/${full}/compare${base ? `/${base}...${head ?? ""}` : ""}`,
  search: (q) => withQuery("#/search", { q }),
};

// ---------------------------------------------------------------------------------------------
// Repository data
// ---------------------------------------------------------------------------------------------

export const repoFull = (owner, repo) => `${owner}/${repo}`;

/** Load and cache the current repository view (repos.get). Throws ToolError on 404 / denied. */
export async function loadRepo(owner, repo) {
  const full = repoFull(owner, repo).toLowerCase();
  if (state.repo && state.repo.full_name.toLowerCase() === full && state.repo.revision === revisionStamp()) return state.repo;
  const view = await call("repos.get", { owner, repo });
  view.revision = revisionStamp();
  state.repo = view;
  return view;
}

export function revisionStamp() {
  return JSON.stringify(state.context?.revision ?? null);
}

export async function loadBranches(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  if (state.branches && state.branches.key === key && state.branches.revision === revisionStamp()) return state.branches.list;
  const list = [];
  let page = 1;
  for (;;) {
    const result = await call("repos.list-branches", { owner, repo, perPage: 100, page });
    list.push(...result.branches);
    if (list.length >= result.total_count || result.branches.length === 0) break;
    page += 1;
  }
  state.branches = { key, list, revision: revisionStamp() };
  return list;
}

export async function loadLabels(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  if (state.labels && state.labels.key === key && state.labels.revision === revisionStamp()) return state.labels.list;
  const result = await pageAll((page) => call("issues.list-labels-for-repo", { owner, repo, ...page }), "labels");
  state.labels = { key, list: result.labels, revision: revisionStamp() };
  return result.labels;
}

/** Split "ref/with/slashes/path/to/file" against the branch list: longest branch name that prefixes the parts. */
export function splitRefAndPath(parts, branches) {
  for (let length = parts.length; length >= 1; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (branches.some((branch) => branch.name === candidate)) return { ref: candidate, path: parts.slice(length).join("/") };
  }
  return { ref: parts[0] ?? "", path: parts.slice(1).join("/") };
}

/** Repository permission of the current user as the API reports it ({ admin, maintain, push, triage, pull }). */
export function permissions(repo = state.repo) {
  return repo?.permissions ?? { admin: false, maintain: false, push: false, triage: false, pull: true };
}
export const canPush = (repo) => permissions(repo).push === true && repo?.archived !== true;
export const canTriage = (repo) => permissions(repo).triage === true && repo?.archived !== true;

// ---------------------------------------------------------------------------------------------
// Shell: header crumbs, repository tabs, layout containers
// ---------------------------------------------------------------------------------------------

export function setCrumbs(items) {
  const list = clear($("#context-crumbs"));
  items.forEach((item, index) => {
    const li = el("li");
    if (index > 0) li.append(el("span", { class: "crumb-sep", text: "/" }));
    li.append(el("a", { class: item.current ? "crumb-current" : "", text: item.text, href: item.href }));
    list.append(li);
  });
}

export function setTitle(text) {
  document.title = text ? `${text} · GitHub (synthetic)` : "GitHub (synthetic)";
}

/** Repository UnderlineNav (Code · Issues · Pull requests) in the header's local bar. */
export function setRepoNav(repo, current) {
  const bar = $("#local-bar");
  const nav = clear($("#repo-nav"));
  if (!repo) {
    bar.hidden = true;
    return;
  }
  const full = repo.full_name;
  const tabs = [
    { id: "code", label: "Code", icon: "code", href: hrefs.repo(full) },
    { id: "issues", label: "Issues", icon: "issue-opened", href: hrefs.issues(full), count: repo.open_issues_count },
    { id: "pulls", label: "Pull requests", icon: "git-pull-request", href: hrefs.pulls(full) },
  ];
  for (const tab of tabs) {
    const a = el("a", { class: "UnderlineNav-item", href: tab.href, attrs: { "aria-current": tab.id === current ? "page" : undefined, "data-tab": tab.id, "data-icon": tab.icon } });
    a.append(icon(tab.icon), el("span", { text: tab.label }));
    if (tab.count !== undefined) a.append(el("span", { class: "Counter", text: String(tab.count), attrs: { "data-count": tab.id } }));
    nav.append(a);
  }
  for (const item of outOfScopeTabs(repo)) nav.append(item);
  bar.hidden = false;
  fitRepoNav(nav);
  void fillNavCounts(repo);
}

const navCounts = new Map();
/** The API's open_issues_count includes pull requests; the tabs show issues and pull requests separately, from real list totals. */
async function fillNavCounts(repo) {
  const cacheKey = `${repo.full_name.toLowerCase()}@${revisionStamp()}`;
  let counts = navCounts.get(cacheKey);
  if (!counts) {
    const [owner, name] = repo.full_name.split("/");
    counts = await Promise.all([
      call("issues.list", { owner, repo: name, state: "open", perPage: 1 }).then((result) => result.total_count).catch(() => undefined),
      call("pulls.list", { owner, repo: name, state: "open", perPage: 1 }).then((result) => result.total_count).catch(() => undefined),
    ]);
    navCounts.set(cacheKey, counts);
    if (navCounts.size > 20) navCounts.delete(navCounts.keys().next().value);
  }
  if (state.repo?.full_name.toLowerCase() !== repo.full_name.toLowerCase()) return;
  if (counts[0] !== undefined) setNavCount("issues", counts[0]);
  if (counts[1] !== undefined) setNavCount("pulls", counts[1]);
}

/** Update the Issues / Pull requests counters from real list totals once known. */
export function setNavCount(tab, count) {
  const counter = $(`#repo-nav [data-count="${tab}"]`);
  if (counter) counter.textContent = String(count);
  else {
    const anchor = $(`#repo-nav [data-tab="${tab}"]`);
    if (anchor) anchor.append(el("span", { class: "Counter", text: String(count), attrs: { "data-count": tab } }));
  }
  fitRepoNav();
}

export function container(className = "container-xl") {
  return el("div", { class: className });
}

/** Repository title block (icon · owner / name · visibility badge) shown above Code-tab content. */
export function repoHead(repo, actions = []) {
  const head = el("div", { class: "repohead" });
  const title = el("div", { class: "repohead-title" });
  title.append(icon(repo.private ? "repo-locked" : "repo"));
  title.append(link(repo.owner.login, hrefs.user(repo.owner.login)));
  title.append(el("span", { class: "slash", text: "/" }));
  title.append(el("a", { class: "repo-name", text: repo.name, href: hrefs.repo(repo.full_name) }));
  title.append(el("span", { class: "Label Label--secondary", text: repo.archived ? "Public archive" : repo.private ? "Private" : "Public" }));
  title.append(el("div", { class: "repohead-actions" }, [...actions, ...repoActions(repo)]));
  head.append(title);
  return head;
}

export function archivedBanner(repo) {
  if (!repo.archived) return null;
  const banner = el("div", { class: "flash flash-warn archived-banner", attrs: { role: "status" } });
  banner.append(icon("alert", "flash-icon color-fg-attention"), el("span", { class: "flash-text", text: "This repository has been archived by the owner. It is now read-only." }));
  return banner;
}

// ---------------------------------------------------------------------------------------------
// Common blocks: blankslates, error states, pagination, issue/PR rows
// ---------------------------------------------------------------------------------------------

export function blankslate(iconName, heading, text, actions = []) {
  const block = el("div", { class: "blankslate" });
  if (iconName) block.append(icon(iconName, "", 24));
  block.append(el("h3", { text: heading }));
  if (text) block.append(el("p", { text }));
  for (const action of actions) block.append(action);
  return block;
}

export function loadingBlock(text = "Loading…") {
  return el("div", { class: "blankslate blankslate-loading" }, [el("span", { class: "spinner", attrs: { "aria-hidden": "true" } }), el("p", { text })]);
}

/** Render an error the way github.com does: 404 page, 403 permission blankslate, 401 bad credentials, else flash text. */
export function errorBlock(error, { retry } = {}) {
  if (error instanceof ToolError) {
    if (error.is("NOT_FOUND")) return blankslate("alert", "404", "This is not the web page you are looking for. The repository, branch, issue or pull request does not exist or is private.", [button("Back to home", { onClick: () => navigate("#/") })]);
    if (error.denied) return blankslate("lock", "You don't have permission to do that", `Your actor has no grant for the operation this page needs (${error.message}).`, retry ? [button("Try again", { onClick: retry })] : []);
    if (error.is("UNAUTHORIZED")) return blankslate("alert", "Bad credentials", "The actor's login matches no user in this synthetic instance.");
    if (error.is("RATE_LIMITED")) return blankslate("clock", "API rate limit exceeded", error.message, retry ? [button("Try again", { onClick: retry })] : []);
  }
  return blankslate("alert", "Something went wrong", describe(error), retry ? [button("Try again", { onClick: retry })] : []);
}

export function pager({ page, perPage, total, totalPages, onPage, labels = ["Previous", "Next"] }) {
  // Operations cut pages by count and bytes; `totalPages` (the operation's total_pages) is authoritative.
  const pages = typeof totalPages === "number" ? Math.max(1, totalPages) : Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const footer = el("div", { class: "list-footer" });
  footer.append(button(labels[0], { icon: "chevron-left", disabled: page <= 1, onClick: () => onPage(page - 1) }));
  footer.append(el("span", { class: "text-muted", text: `Page ${page} of ${pages}` }));
  footer.append(button(labels[1], { trailingIcon: "chevron-right", disabled: page >= pages, onClick: () => onPage(page + 1) }));
  return footer;
}

/** State icon for an issue or pull request view (pull views carry `draft`/`merged_at`). */
export function stateIcon(item, kind) {
  if (kind === "pr") {
    if (item.merged || item.merged_at) return icon("git-merge");
    if (item.state === "closed") return icon("git-pull-request-closed");
    if (item.draft) return icon("git-pull-request-draft");
    return icon("git-pull-request");
  }
  if (item.state === "closed") return icon(item.state_reason === "not_planned" || item.state_reason === "duplicate" ? "skip" : "issue-closed");
  return icon("issue-opened");
}

export function stateBadge(item, kind) {
  const badge = el("span", { class: "State" });
  let text = "Open";
  let modifier = "State--open";
  if (kind === "pr") {
    if (item.merged || item.merged_at) [text, modifier] = ["Merged", "State--merged"];
    else if (item.state === "closed") [text, modifier] = ["Closed", "State--closed"];
    else if (item.draft) [text, modifier] = ["Draft", "State--draft"];
  } else if (item.state === "closed") {
    if (item.state_reason === "not_planned" || item.state_reason === "duplicate") [text, modifier] = ["Closed", "State--draft"];
    else [text, modifier] = ["Closed", "State--done"];
  }
  badge.classList.add(modifier);
  badge.append(stateIcon(item, kind), el("span", { text }));
  return badge;
}

/** Whether an issue-search item is a pull request (search items carry `pull_request`). */
export const isPull = (item) => item.pull_request !== undefined && item.pull_request !== null;

/** One row of the issues / pull requests / search list. `full` = "owner/repo"; `showRepo` prefixes it. */
export function issueRow(item, full, kind, { showRepo = false, reviews } = {}) {
  const row = el("div", { class: "issue-row", attrs: { role: "listitem" } });
  row.append(el("div", { class: "issue-row-icon" }, [stateIcon(item, kind)]));
  const main = el("div", { class: "issue-row-main" });
  const titleRow = el("div", { class: "issue-row-title" });
  if (showRepo) titleRow.append(el("a", { class: "repo-prefix", text: full, href: hrefs.repo(full) }));
  titleRow.append(el("a", { class: "title", text: item.title, href: kind === "pr" ? hrefs.pull(full, item.number) : hrefs.issue(full, item.number) }));
  for (const label of item.labels ?? []) {
    const chip = labelChip(label);
    chip.classList.add("issue-row-label");
    titleRow.append(chip);
  }
  main.append(titleRow);
  const meta = el("div", { class: "issue-row-meta" });
  const opened = kind === "pr" && (item.merged || item.merged_at) ? "merged" : item.state === "closed" ? "closed" : "opened";
  const when = opened === "opened" ? item.created_at : (item.merged_at ?? item.closed_at ?? item.updated_at);
  meta.append(`#${item.number} ${opened === "opened" ? "opened" : opened} `, timeElement(when), " by ", link(item.user.login, hrefs.user(item.user.login)));
  if (kind === "pr" && item.draft && item.state === "open") meta.append(" · Draft");
  main.append(meta);
  row.append(main);
  const side = el("div", { class: "issue-row-side" });
  if (reviews) side.append(reviews);
  if ((item.assignees ?? []).length > 0) {
    const stack = el("span", { class: "AvatarStack", title: `Assigned to ${item.assignees.map((a) => a.login).join(", ")}` });
    for (const assignee of item.assignees.slice(0, 3)) stack.append(avatar(assignee, 20));
    side.append(stack);
  }
  if (item.comments > 0) {
    side.append(el("a", { class: "comment-count", href: kind === "pr" ? hrefs.pull(full, item.number) : hrefs.issue(full, item.number), attrs: { "aria-label": plural(item.comments, "comment") } }, [icon("comment"), el("span", { text: String(item.comments) })]));
  }
  row.append(side);
  return row;
}

/** "Open N · Closed N" header with filter menus. */
export function listHeader({ open, closed, current, onState, filters = [] }) {
  const header = el("div", { class: "table-list-header" });
  const states = el("div", { class: "states" });
  const openLink = el("a", { href: "#", attrs: { "aria-current": current === "open" ? "page" : undefined } }, [icon("issue-opened"), el("span", { text: open === undefined ? "Open" : `${open} Open` })]);
  const closedLink = el("a", { href: "#", attrs: { "aria-current": current === "closed" ? "page" : undefined } }, [icon("check"), el("span", { text: closed === undefined ? "Closed" : `${closed} Closed` })]);
  openLink.addEventListener("click", (event) => {
    event.preventDefault();
    onState("open");
  });
  closedLink.addEventListener("click", (event) => {
    event.preventDefault();
    onState("closed");
  });
  states.append(openLink, closedLink);
  header.append(states);
  const filterBar = el("div", { class: "filters" });
  for (const filter of filters) filterBar.append(filter);
  header.append(filterBar);
  return header;
}

export function filterMenuButton(label, onClick) {
  const element = button(label, { trailingIcon: "triangle-down", onClick: (event) => onClick(event.currentTarget) });
  element.setAttribute("aria-haspopup", "true");
  element.setAttribute("aria-expanded", "false");
  return element;
}

export function userLink(user, className = "author") {
  return el("a", { class: className, text: user.login, href: hrefs.user(user.login) });
}

/** Number-formatted relative "ago" sentence fragment: "opened this issue 2 weeks ago". */
export function timeAgo(iso) {
  return timeElement(iso);
}
