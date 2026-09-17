// Shared state, hash routing, data loaders and the GitLab frame (super sidebar, breadcrumbs, list toolbars).
import { $, ToolError, avatar, badge, button, call, clear, closeMenus, describe, el, icon, iconButton, openListbox, openMenu, openModal, pageAll, pageUpTo, projectAvatar } from "./ui.js";

export const state = {
  context: undefined,
  user: undefined, // users.get {me:true}
  authError: undefined,
  project: undefined, // projects.get view of the current project
  projectCache: new Map(), // path → { revision, view }
  branches: undefined, // { key, revision, list }
  labels: undefined, // { key, revision, list }
  people: new Map(), // username → user, collected from records the viewer can see
  navigation: 0,
  editing: false, // unsaved form text: revision polling must not re-render
  counts: undefined, // sidebar counters { revision, issues, mrs, reviews }
  peopleScan: undefined, // { key, revision, notice } for loadPeople
};

export const PER_PAGE = 20;

export const ROLE = { 10: "Guest", 15: "Planner", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };

export function revisionStamp() {
  return JSON.stringify(state.context?.revision ?? null);
}

// ---------------------------------------------------------------------------------------------
// Routing: #/<namespace>/<project>/-/<page>/<rest…>?query
// ---------------------------------------------------------------------------------------------

function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function parseRoute(hash = location.hash) {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf("?");
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex === -1 ? "" : raw.slice(queryIndex + 1));
  const parts = path.split("/").filter((part) => part.length > 0).map(safeDecode);
  const dash = parts.indexOf("-");
  if (parts[0] === "dashboard") return { kind: "dashboard", page: parts[1] ?? "projects", rest: parts.slice(2), query };
  if (parts.length === 0) return { kind: "dashboard", page: "projects", rest: [], query };
  if (dash === -1) {
    if (parts.length === 1) return { kind: "namespace", namespace: parts[0], query };
    return { kind: "project", projectPath: parts.join("/"), page: "overview", rest: [], query };
  }
  return { kind: "project", projectPath: parts.slice(0, dash).join("/"), page: parts[dash + 1] ?? "overview", rest: parts.slice(dash + 2), query };
}

export function navigate(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

export function withQuery(base, params) {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null && value !== "") search.set(name, String(value));
  const text = search.toString();
  return text ? `${base}?${text}` : base;
}

const encodePath = (path) => String(path).split("/").map(encodeURIComponent).join("/");

export const hrefs = {
  home: () => "#/",
  dashboard: (page, params) => withQuery(`#/dashboard/${page}`, params),
  namespace: (path) => `#/${encodePath(path)}`,
  user: (username) => `#/${encodeURIComponent(username)}`,
  project: (path) => `#/${encodePath(path)}`,
  tree: (path, ref, dir = "") => `#/${encodePath(path)}/-/tree/${encodePath(ref)}${dir ? `/${encodePath(dir)}` : ""}`,
  blob: (path, ref, file) => `#/${encodePath(path)}/-/blob/${encodePath(ref)}/${encodePath(file)}`,
  edit: (path, ref, file) => `#/${encodePath(path)}/-/edit/${encodePath(ref)}/${encodePath(file)}`,
  newFile: (path, ref, dir = "") => `#/${encodePath(path)}/-/new/${encodePath(ref)}${dir ? `/${encodePath(dir)}` : ""}`,
  commits: (path, ref, params) => withQuery(`#/${encodePath(path)}/-/commits/${encodePath(ref)}`, params),
  commit: (path, sha) => `#/${encodePath(path)}/-/commit/${sha}`,
  branches: (path, tab, params) => withQuery(`#/${encodePath(path)}/-/branches${tab ? `/${tab}` : ""}`, params),
  newBranch: (path, ref) => withQuery(`#/${encodePath(path)}/-/branches/new`, { ref }),
  issues: (path, params) => withQuery(`#/${encodePath(path)}/-/issues`, params),
  newIssue: (path) => `#/${encodePath(path)}/-/issues/new`,
  issue: (path, iid) => `#/${encodePath(path)}/-/issues/${iid}`,
  labels: (path) => `#/${encodePath(path)}/-/labels`,
  mrs: (path, params) => withQuery(`#/${encodePath(path)}/-/merge_requests`, params),
  newMr: (path, params) => withQuery(`#/${encodePath(path)}/-/merge_requests/new`, params),
  mr: (path, iid, tab) => `#/${encodePath(path)}/-/merge_requests/${iid}${tab ? `/${tab}` : ""}`,
};

// ---------------------------------------------------------------------------------------------
// Data loaders (cached per world revision)
// ---------------------------------------------------------------------------------------------

export async function loadProject(path) {
  const key = path.toLowerCase();
  const cached = state.projectCache.get(key);
  if (cached && cached.revision === revisionStamp()) {
    state.project = cached.view;
    return cached.view;
  }
  const view = await call("projects.get", { id: path });
  state.projectCache.set(key, { revision: revisionStamp(), view });
  if (state.projectCache.size > 12) state.projectCache.delete(state.projectCache.keys().next().value);
  state.project = view;
  return view;
}

export async function loadBranches(project) {
  const key = String(project.id);
  if (state.branches?.key === key && state.branches.revision === revisionStamp()) return state.branches.list;
  const list = await pageAll((page) => call("branches.list", { id: project.id, ...page }));
  state.branches = { key, revision: revisionStamp(), list };
  return list;
}

export async function loadLabels(project) {
  const key = String(project.id);
  if (state.labels?.key === key && state.labels.revision === revisionStamp()) return state.labels.list;
  const list = await pageAll((page) => call("labels.list", { id: project.id, ...page }));
  state.labels = { key, revision: revisionStamp(), list };
  return list;
}

/** Remember users that appear in records (authors, assignees, reviewers) so pickers can offer them. */
export function rememberPeople(...users) {
  for (const user of users.flat()) if (user && typeof user.username === "string") state.people.set(user.username.toLowerCase(), user);
}

/** Pages of issues or merge requests loadPeople reads per project before it says the candidate list may be incomplete. */
export const PEOPLE_SCAN_PAGES = 100;

/**
 * Candidate users for assignee/reviewer pickers: the signed-in user plus everyone who appears (author, assignee,
 * reviewer) on any of this project's issues and merge requests. Both lists are paged, newest activity first, so older
 * participants are not dropped; when a list is longer than PEOPLE_SCAN_PAGES pages or cannot be read, the returned
 * array carries a `notice` sentence the pickers show. Cached per project and world revision.
 */
export async function loadPeople(project) {
  if (state.user) rememberPeople(state.user);
  const key = String(project.id);
  if (!(state.peopleScan?.key === key && state.peopleScan.revision === revisionStamp())) {
    const revision = revisionStamp();
    const scan = async (operation, noun) => {
      try {
        const { items, complete } = await pageUpTo((page) => call(operation, { id: project.id, state: "all", order_by: "updated_at", sort: "desc", ...page }), { maxPages: PEOPLE_SCAN_PAGES });
        for (const item of items) rememberPeople(item.author, item.assignees ?? [], item.reviewers ?? []);
        return complete ? undefined : `people from the ${items.length.toLocaleString("en-US")} most recently updated ${noun}`;
      } catch (error) {
        return `no people from ${noun} (${describe(error)})`;
      }
    };
    const gaps = (await Promise.all([scan("issues.list", "issues"), scan("merge-requests.list", "merge requests")])).filter(Boolean);
    const notice = gaps.length ? `This list may be incomplete: it includes ${gaps.join(" and ")}. Type a username to filter by someone not listed.` : undefined;
    state.peopleScan = { key, revision, notice };
  }
  const people = [...state.people.values()].filter((user) => user.state !== "blocked").sort((a, b) => a.name.localeCompare(b.name));
  people.notice = state.peopleScan.notice;
  return people;
}

export function accessLevel(project = state.project) {
  return project?.permissions?.project_access?.access_level ?? 0;
}
export const canPlan = (project) => accessLevel(project) >= 15 && !project?.archived;
export const canReport = (project) => accessLevel(project) >= 20 && !project?.archived;
export const canDevelop = (project) => accessLevel(project) >= 30 && !project?.archived;

/** Split "ref/with/slashes/path" by the longest branch name that prefixes it. */
export function splitRefAndPath(parts, branches) {
  for (let length = parts.length; length >= 1; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (branches.some((branch) => branch.name === candidate)) return { ref: candidate, path: parts.slice(length).join("/") };
  }
  return { ref: parts[0] ?? "", path: parts.slice(1).join("/") };
}

// ---------------------------------------------------------------------------------------------
// Not simulated (chrome outside this Tool's scope)
// ---------------------------------------------------------------------------------------------

export function notSimulated(feature) {
  closeMenus();
  void openModal(feature, (body, close, footer) => {
    body.append(
      el("p", { text: `${feature} is part of GitLab but is not simulated by this Tool.` }),
      el("p", { class: "gl-text-subtle", text: "This synthetic instance covers projects, repository files, branches, commits, labels, issues, comments and merge requests. Nothing here reaches a real GitLab instance." }),
    );
    footer.append(button("Close", { variant: "confirm", onClick: () => close() }));
  }, { size: "sm" });
}

// ---------------------------------------------------------------------------------------------
// Super sidebar
// ---------------------------------------------------------------------------------------------

const PROJECT_SECTIONS = [
  { id: "manage", label: "Manage", icon: "users", items: [["Activity"], ["Members"], ["Labels", "labels"]] },
  { id: "plan", label: "Plan", icon: "planning", items: [["Issues", "issues"], ["Issue boards"], ["Milestones"], ["Iterations"], ["Wiki"], ["Requirements"]] },
  { id: "code", label: "Code", icon: "code", items: [["Merge requests", "merge_requests"], ["Repository", "tree"], ["Branches", "branches"], ["Commits", "commits"], ["Tags"], ["Repository graph"], ["Compare revisions"], ["Snippets"]] },
  { id: "build", label: "Build", icon: "rocket", items: [["Pipelines"], ["Jobs"], ["Pipeline editor"], ["Pipeline schedules"], ["Artifacts"]] },
  { id: "secure", label: "Secure", icon: "shield", items: [["Security configuration"]] },
  { id: "deploy", label: "Deploy", icon: "deployments", items: [["Releases"], ["Feature flags"], ["Package registry"], ["Container registry"]] },
  { id: "operate", label: "Operate", icon: "cloud-gear", items: [["Environments"], ["Kubernetes clusters"], ["Terraform states"]] },
  { id: "monitor", label: "Monitor", icon: "monitor", items: [["Error Tracking"], ["Alerts"], ["Incidents"]] },
  { id: "analyze", label: "Analyze", icon: "chart", items: [["Value stream analytics"], ["Contributor analytics"], ["CI/CD analytics"], ["Repository analytics"]] },
  { id: "settings", label: "Settings", icon: "settings", items: [["General"], ["Integrations"], ["Webhooks"], ["Access tokens"], ["Repository"], ["Merge requests"], ["CI/CD"]] },
];

const WORK_ITEMS = [
  ["Projects", "project", "projects"],
  ["Groups", "group"],
  ["Issues", "issues", "issues"],
  ["Merge requests", "merge-request", "merge_requests"],
  ["To-Do List", "todo-done"],
  ["Milestones", "milestone"],
  ["Snippets", "snippet"],
  ["Activity", "history"],
];

const PAGE_SECTION = { issues: "plan", labels: "manage", merge_requests: "code", tree: "code", blob: "code", edit: "code", new: "code", branches: "code", commits: "code", commit: "code" };
const PAGE_ITEM = { issues: "issues", labels: "labels", merge_requests: "merge_requests", tree: "tree", blob: "tree", edit: "tree", new: "tree", overview: "overview", branches: "branches", commits: "commits", commit: "commits" };

function sectionOpen(id, current) {
  try {
    const stored = localStorage.getItem(`gitlab-tool:section:${id}`);
    if (stored !== null) return stored === "1" || id === current;
  } catch {
    /* ignore */
  }
  return id === current;
}
function rememberSection(id, open) {
  try {
    localStorage.setItem(`gitlab-tool:section:${id}`, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function navItem({ label, iconName, href, active, count, onClick, sub = false }) {
  const element = el(href ? "a" : "button", { class: `nav-item ${sub ? "nav-item-sub" : ""} ${active ? "active" : ""}`.trim(), href, attrs: { type: href ? undefined : "button", "aria-current": active ? "page" : undefined } });
  element.append(el("span", { class: "nav-item-indicator", attrs: { "aria-hidden": "true" } }));
  if (iconName) element.append(el("span", { class: "nav-icon-container" }, [icon(iconName)]));
  element.append(el("span", { class: "nav-item-label", text: label }));
  if (count !== undefined) element.append(el("span", { class: "gl-badge badge-neutral badge-sm nav-item-count", text: String(count) }));
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

/** Render the sidebar for the current route. */
export function renderSidebar(route) {
  const nav = clear($("#sidebar-nav"));
  const project = route.kind === "project" ? state.project : undefined;
  const context = $("#sidebar-context");
  clear(context);
  if (project && project.path_with_namespace.toLowerCase() === route.projectPath.toLowerCase()) {
    context.append(el("div", { class: "super-sidebar-context-header", text: "Project" }));
    const header = el("a", { class: "super-sidebar-project", href: hrefs.project(project.path_with_namespace) }, [projectAvatar(project, 24), el("span", { class: "super-sidebar-project-name", text: project.name })]);
    context.append(header);
    const path = project.path_with_namespace;
    const current = PAGE_SECTION[route.page];
    const activeItem = PAGE_ITEM[route.page];
    // Pinned
    const pinned = el("section", { class: "nav-section pinned" });
    const pinnedToggle = el("button", { class: "nav-section-toggle", attrs: { type: "button", "aria-expanded": "true" } }, [el("span", { class: "nav-icon-container" }, [icon("thumbtack")]), el("span", { class: "nav-item-label", text: "Pinned" }), icon("chevron-up", "nav-chevron")]);
    const pinnedList = el("div", { class: "nav-section-items" }, [
      navItem({ label: "Issues", href: hrefs.issues(path), active: activeItem === "issues", count: project.open_issues_count, sub: true }),
      navItem({ label: "Merge requests", href: hrefs.mrs(path), active: activeItem === "merge_requests", count: state.counts?.projectMrs?.[project.id], sub: true }),
    ]);
    pinnedToggle.addEventListener("click", () => {
      const open = pinnedList.hidden;
      pinnedList.hidden = !open;
      pinnedToggle.setAttribute("aria-expanded", String(open));
      pinnedToggle.querySelector(".nav-chevron")?.replaceWith(icon(open ? "chevron-up" : "chevron-down", "nav-chevron"));
    });
    pinned.append(pinnedToggle, pinnedList);
    nav.append(pinned, el("hr", { class: "nav-divider" }));
    nav.append(navItem({ label: project.name, iconName: undefined, href: hrefs.project(path), active: activeItem === "overview", sub: false }));
    nav.lastChild.classList.add("nav-item-project");
    nav.lastChild.prepend(el("span", { class: "nav-icon-container" }, [projectAvatar(project, 16)]));
    for (const section of PROJECT_SECTIONS) {
      const open = sectionOpen(section.id, current);
      const wrapper = el("section", { class: `nav-section ${section.id === current ? "has-active" : ""}` });
      const toggle = el("button", { class: "nav-section-toggle", attrs: { type: "button", "aria-expanded": String(open) } }, [el("span", { class: "nav-icon-container" }, [icon(section.icon)]), el("span", { class: "nav-item-label", text: section.label }), icon(open ? "chevron-up" : "chevron-down", "nav-chevron")]);
      const items = el("div", { class: "nav-section-items" });
      items.hidden = !open;
      for (const [label, page] of section.items) {
        if (page) {
          const href = page === "tree" ? hrefs.tree(path, project.default_branch ?? "main") : page === "commits" ? hrefs.commits(path, project.default_branch ?? "main") : page === "branches" ? hrefs.branches(path) : page === "labels" ? hrefs.labels(path) : page === "issues" ? hrefs.issues(path) : hrefs.mrs(path);
          items.append(navItem({ label, href, active: activeItem === page, sub: true }));
        } else items.append(navItem({ label, sub: true, onClick: () => notSimulated(`${section.label}: ${label}`) }));
      }
      toggle.addEventListener("click", () => {
        const nowOpen = items.hidden;
        items.hidden = !nowOpen;
        toggle.setAttribute("aria-expanded", String(nowOpen));
        toggle.querySelector(".nav-chevron")?.replaceWith(icon(nowOpen ? "chevron-up" : "chevron-down", "nav-chevron"));
        rememberSection(section.id, nowOpen);
      });
      wrapper.append(toggle, items);
      nav.append(wrapper);
    }
  } else {
    context.append(el("div", { class: "super-sidebar-context-header", text: "Your work" }));
    const page = route.kind === "dashboard" ? route.page : "projects";
    for (const [label, iconName, target] of WORK_ITEMS) {
      if (target) {
        const count = target === "issues" ? state.counts?.issues : target === "merge_requests" ? state.counts?.mrs : undefined;
        nav.append(navItem({ label, iconName, href: hrefs.dashboard(target), active: page === target, count }));
      } else nav.append(navItem({ label, iconName, onClick: () => notSimulated(label) }));
    }
    nav.append(el("hr", { class: "nav-divider" }), navItem({ label: "Explore", iconName: "earth", onClick: () => notSimulated("Explore") }));
  }
}

/** Header counters (assigned issues, merge requests, to-do) computed from real lists across visible projects. */
export async function loadCounters() {
  if (!state.user) return undefined;
  if (state.counts?.revision === revisionStamp()) return state.counts;
  const projects = await pageAll((page) => call("projects.list", { membership: true, archived: false, ...page })).catch(() => []);
  let issues = 0;
  let assignedMrs = 0;
  let reviews = 0;
  const projectMrs = {};
  await Promise.all(
    projects.map(async (project) => {
      const [assignedIssues, mine, review, open] = await Promise.all([
        project.issues_enabled ? call("issues.list", { id: project.id, state: "opened", assignee_username: state.user.username, per_page: 1 }).catch(() => undefined) : undefined,
        project.merge_requests_enabled ? call("merge-requests.list", { id: project.id, state: "opened", assignee_username: state.user.username, per_page: 1 }).catch(() => undefined) : undefined,
        project.merge_requests_enabled ? call("merge-requests.list", { id: project.id, state: "opened", reviewer_username: state.user.username, per_page: 1 }).catch(() => undefined) : undefined,
        project.merge_requests_enabled ? call("merge-requests.list", { id: project.id, state: "opened", per_page: 1 }).catch(() => undefined) : undefined,
      ]);
      issues += assignedIssues?.page?.total ?? 0;
      assignedMrs += mine?.page?.total ?? 0;
      reviews += review?.page?.total ?? 0;
      if (open?.page?.total !== undefined) projectMrs[project.id] = open.page.total;
    }),
  );
  state.counts = { revision: revisionStamp(), issues, mrs: assignedMrs + reviews, assignedMrs, reviews, projectMrs };
  return state.counts;
}

export function renderCounters() {
  const counts = state.counts;
  const set = (id, value) => {
    const target = $(id);
    if (target) target.textContent = value === undefined ? "" : String(value);
  };
  set("#count-issues", counts?.issues);
  set("#count-mrs", counts?.mrs);
}

// ---------------------------------------------------------------------------------------------
// Top bar: breadcrumbs
// ---------------------------------------------------------------------------------------------

export function setBreadcrumbs(items) {
  const list = clear($("#breadcrumbs"));
  items.forEach((item, index) => {
    const li = el("li", { class: "gl-breadcrumb-item" });
    if (item.avatar) li.append(item.avatar);
    const last = index === items.length - 1;
    li.append(el("a", { href: item.href, text: item.text, attrs: { "aria-current": last ? "page" : undefined } }));
    list.append(li);
  });
}

export function projectCrumbs(project, extra = []) {
  const namespace = project.namespace;
  return [
    { text: namespace.name, href: hrefs.namespace(namespace.full_path) },
    { text: project.name, href: hrefs.project(project.path_with_namespace) },
    ...extra,
  ];
}

export function setTitle(parts) {
  document.title = [...parts.filter(Boolean), "GitLab"].join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Page states
// ---------------------------------------------------------------------------------------------

export function loadingBlock(label = "Loading") {
  return el("div", { class: "gl-loading-block", attrs: { role: "status", "aria-label": label } }, [el("span", { class: "gl-spinner", attrs: { "aria-hidden": "true" } })]);
}

export function skeletonRows(count = 5) {
  const wrap = el("ul", { class: "content-list skeleton", attrs: { "aria-hidden": "true" } });
  for (let index = 0; index < count; index += 1) wrap.append(el("li", {}, [el("span", { class: "skeleton-line w-60" }), el("span", { class: "skeleton-line w-30" })]));
  return el("div", { attrs: { role: "status", "aria-label": "Loading" } }, [wrap]);
}

/** GlEmptyState (text-only, as GitLab renders it without illustrations in list filters). */
export function emptyState(title, description, actions = [], { iconName } = {}) {
  const box = el("section", { class: "gl-empty-state" });
  if (iconName) box.append(el("div", { class: "gl-empty-state-icon" }, [icon(iconName, "", 32)]));
  box.append(el("h1", { class: "gl-empty-state-title", text: title }));
  if (description) box.append(el("p", { class: "gl-empty-state-description", text: description }));
  if (actions.length) box.append(el("div", { class: "gl-empty-state-actions" }, actions));
  return box;
}

/** Full-page error in GitLab's wording: 404 page, 403 page, 401 page, or an alert for other failures. */
export function errorPage(error, { what = "page" } = {}) {
  if (error instanceof ToolError && error.denied) {
    return el("div", { class: "error-page" }, [
      el("h1", { class: "error-code", text: "403" }),
      el("h2", { class: "error-title", text: "Access Denied" }),
      el("p", { text: `You don't have permission to view this ${what}. This Firedrill actor has no grant for the operation this ${what} needs.` }),
      el("p", { class: "gl-text-subtle", text: error.message }),
    ]);
  }
  if (error instanceof ToolError && error.is("NOT_FOUND")) {
    return el("div", { class: "error-page" }, [
      el("h1", { class: "error-code", text: "404" }),
      el("h2", { class: "error-title", text: "Page not found" }),
      el("p", { text: "Make sure the address is correct and the page has not moved." }),
      el("p", { class: "gl-text-subtle", text: error.message }),
      el("div", { class: "error-actions" }, [el("a", { class: "gl-button btn-confirm btn-md", href: "#/", text: "Go to homepage" })]),
    ]);
  }
  if (error instanceof ToolError && error.is("UNAUTHORIZED")) {
    return el("div", { class: "error-page" }, [
      el("h1", { class: "error-code", text: "401" }),
      el("h2", { class: "error-title", text: "Unauthorized" }),
      el("p", { text: "The Firedrill actor's identity does not match an active GitLab user, so every request is refused like a revoked token." }),
      el("p", { class: "gl-text-subtle", text: error.message }),
    ]);
  }
  const box = el("div", { class: "page-padded" });
  const retry = button("Try again", { size: "sm", onClick: () => navigate(location.hash || "#/") });
  box.append(alertBox(describe(error), "danger", "Something went wrong while loading this page.", [retry]));
  return box;
}

/** Listbox footer that states why the options may be incomplete, above any existing footer content. */
function withNotice(notice, footer) {
  if (!notice) return footer;
  return el("div", { class: "listbox-footer-stack" }, [el("p", { class: "gl-text-sm people-scan-notice", attrs: { role: "status" }, text: notice }), footer ?? ""]);
}

function alertBox(text, variant, title, actions) {
  const box = el("div", { class: `gl-alert gl-alert-${variant}`, attrs: { role: "alert" } }, [icon(variant === "danger" ? "warning" : "information-o", "gl-alert-icon")]);
  const content = el("div", { class: "gl-alert-content" }, [el("h2", { class: "gl-alert-title", text: title }), el("div", { class: "gl-alert-body", text })]);
  if (actions?.length) content.append(el("div", { class: "gl-alert-actions" }, actions));
  box.append(content);
  return box;
}

// ---------------------------------------------------------------------------------------------
// List toolbars: state tabs, filtered search, sort, pagination
// ---------------------------------------------------------------------------------------------

/** GlTabs with counters: tabs [{ id, label, count?, href }]. */
export function stateTabs(tabs, current, trailing = []) {
  const bar = el("div", { class: "top-area" });
  const list = el("ul", { class: "gl-tabs-nav", attrs: { role: "tablist" } });
  for (const tab of tabs) {
    const a = el("a", { class: `gl-tab-nav-item ${tab.id === current ? "gl-tab-nav-item-active" : ""}`, href: tab.href, attrs: { role: "tab", "aria-selected": String(tab.id === current) } }, [el("span", { text: tab.label })]);
    if (tab.count !== undefined) a.append(el("span", { class: "gl-badge badge-neutral badge-sm gl-tab-counter-badge", text: String(tab.count) }));
    list.append(el("li", { attrs: { role: "presentation" } }, [a]));
  }
  bar.append(list, el("div", { class: "nav-controls" }, trailing));
  return bar;
}

/**
 * GitLab filtered search. tokens: [{ type, title, icon, operator?, options?: () => Promise<[{ value, label, avatar?, swatch? }]>, multi? }]
 * values: { type → value } plus search text. onSubmit({ values, search }).
 */
export function filteredSearch({ tokens, values, search, placeholder = "Search or filter results…", onSubmit }) {
  const current = { ...values };
  const root = el("div", { class: "gl-filtered-search", attrs: { role: "search" } });
  const history = el("button", { class: "gl-search-box-by-click-history", attrs: { type: "button", "aria-label": "Recent searches", title: "Recent searches" } }, [icon("history")]);
  history.addEventListener("click", () => notSimulated("Recent searches"));
  const field = el("div", { class: "gl-filtered-search-scrollable" });
  const input = el("input", { class: "gl-filtered-search-term-input", attrs: { type: "search", placeholder, "aria-label": placeholder, autocomplete: "off" } });
  input.value = search ?? "";
  const clearButton = iconButton("close", "Clear", { size: "sm", class: "gl-search-box-by-click-clear" });
  clearButton.replaceChildren(icon("close"));
  const submitButton = el("button", { class: "gl-search-box-by-click-search-button", attrs: { type: "button", "aria-label": "Search" } }, [icon("search")]);
  const submit = () => onSubmit({ values: { ...current }, search: input.value.trim() });
  const renderTokens = () => {
    for (const chip of [...field.querySelectorAll(".gl-token-chip")]) chip.remove();
    for (const token of tokens) {
      const value = current[token.type];
      if (value === undefined || value === "") continue;
      const chip = el("span", { class: "gl-token-chip" }, [
        el("span", { class: "gl-token-segment gl-token-type" }, [icon(token.icon, "", 14), el("span", { text: token.title })]),
        el("span", { class: "gl-token-segment gl-token-operator", text: "=" }),
        el("span", { class: "gl-token-segment gl-token-value", text: token.display ? token.display(value) : value }),
      ]);
      const remove = el("button", { class: "gl-token-close", attrs: { type: "button", "aria-label": `Remove ${token.title} filter` } }, [icon("close", "", 12)]);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        delete current[token.type];
        submit();
      });
      chip.lastChild.append(remove);
      field.insertBefore(chip, input);
    }
    clearButton.hidden = !input.value && !tokens.some((token) => current[token.type]);
  };
  const chooseValue = async (token, anchor) => {
    let options = [];
    let notice;
    try {
      options = token.options ? await token.options() : [];
      notice = options.notice;
    } catch (error) {
      options = [];
      notice = `Suggestions could not be loaded (${describe(error)}).`;
    }
    openListbox(anchor, {
      title: token.title,
      placeholder: token.placeholder ?? `Search ${token.title.toLowerCase()}`,
      options: options.map((option) => ({ id: option.value, label: option.label, description: option.description, avatar: option.avatar, swatch: option.swatch, selected: current[token.type] === option.value })),
      onSelect: (value) => {
        current[token.type] = value;
        submit();
      },
      footer: withNotice(notice, token.freeText ? freeTextFooter(token, (value) => {
        current[token.type] = value;
        submit();
      }) : undefined),
    });
  };
  const openTokenMenu = () => {
    const available = tokens.filter((token) => !current[token.type]);
    if (available.length === 0) return;
    openMenu(field, available.map((token) => ({ label: token.title, icon: token.icon, onSelect: () => void chooseValue(token, field) })), { width: 240 });
  };
  field.addEventListener("click", (event) => {
    if (event.target === field) openTokenMenu();
  });
  input.addEventListener("focus", () => {
    if (!input.value) openTokenMenu();
  });
  input.addEventListener("input", () => {
    closeMenus();
    clearButton.hidden = !input.value && !tokens.some((token) => current[token.type]);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      closeMenus();
      submit();
    } else if (event.key === "Backspace" && !input.value) {
      const last = [...tokens].reverse().find((token) => current[token.type]);
      if (last) {
        delete current[last.type];
        submit();
      }
    }
  });
  clearButton.addEventListener("click", () => {
    for (const token of tokens) delete current[token.type];
    input.value = "";
    submit();
  });
  submitButton.addEventListener("click", submit);
  field.append(input);
  root.append(history, field, clearButton, submitButton);
  renderTokens();
  return root;
}

function freeTextFooter(token, commit) {
  const wrap = el("form", { class: "free-text-token" });
  const input = el("input", { class: "gl-form-input form-control-sm", attrs: { type: "text", placeholder: token.freeTextPlaceholder ?? "Type a value and press Enter", "aria-label": `${token.title} value` } });
  wrap.append(input);
  wrap.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value) {
      closeMenus();
      commit(value);
    }
  });
  return wrap;
}

/** GitLab sort control: listbox of fields plus a direction toggle. */
export function sortControl({ options, value, direction, onChange }) {
  const wrap = el("div", { class: "gl-sorting", attrs: { role: "group" } });
  const current = options.find((option) => option.value === value) ?? options[0];
  const picker = button(current.label, { trailingIcon: "chevron-down", class: "gl-sorting-selector" });
  picker.addEventListener("click", () => openMenu(picker, options.map((option) => ({ label: option.label, checked: option.value === current.value, onSelect: () => onChange(option.value, direction) })), { align: "end", width: 200 }));
  const toggle = iconButton(direction === "asc" ? "sort-lowest" : "sort-highest", direction === "asc" ? "Sort direction: Ascending" : "Sort direction: Descending", { variant: "default", class: "gl-sorting-direction", onClick: () => onChange(current.value, direction === "asc" ? "desc" : "asc") });
  wrap.append(picker, toggle);
  return wrap;
}

/** GlPagination / GlKeysetPagination from the operation's page object. */
export function pagination(pageInfo, hrefFor) {
  if (!pageInfo) return null;
  const { page, next_page: next, prev_page: prev, total_pages: totalPages } = pageInfo;
  if (!next && !prev) return null;
  const nav = el("nav", { class: "gl-pagination", attrs: { "aria-label": "Pagination" } });
  const list = el("ul", { class: "pagination" });
  const item = (label, target, { disabled = false, active = false, iconName, trailing } = {}) => {
    const li = el("li", { class: `page-item ${disabled ? "disabled" : ""} ${active ? "active" : ""}`.trim() });
    const content = [];
    if (iconName && !trailing) content.push(icon(iconName));
    content.push(el("span", { text: label }));
    if (iconName && trailing) content.push(icon(iconName));
    li.append(disabled || active ? el("span", { class: "page-link", attrs: { "aria-current": active ? "page" : undefined, "aria-disabled": disabled ? "true" : undefined } }, content) : el("a", { class: "page-link", href: hrefFor(target) }, content));
    return li;
  };
  list.append(item("Previous", prev, { disabled: !prev, iconName: "chevron-left" }));
  if (totalPages && totalPages <= 9) for (let number = 1; number <= totalPages; number += 1) list.append(item(String(number), number, { active: number === page }));
  else if (totalPages) {
    const shown = new Set([1, totalPages, page - 1, page, page + 1].filter((number) => number >= 1 && number <= totalPages));
    let last = 0;
    for (const number of [...shown].sort((a, b) => a - b)) {
      if (number - last > 1) list.append(el("li", { class: "page-item disabled" }, [el("span", { class: "page-link", text: "…" })]));
      list.append(item(String(number), number, { active: number === page }));
      last = number;
    }
  }
  list.append(item("Next", next, { disabled: !next, iconName: "chevron-right", trailing: true }));
  nav.append(list);
  return nav;
}

/** "Copy to clipboard" icon button for SHAs, branch names and references. */
export function copyButton(text, label = "Copy") {
  const element = iconButton("copy-to-clipboard", label, { size: "sm", class: "btn-copy" });
  element.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
      element.title = "Copied";
    } catch {
      element.title = "Copy failed";
    }
  });
  return element;
}

export function userLink(user, { withAvatar = false, size = 16 } = {}) {
  const a = el("a", { class: "author-link", href: hrefs.user(user.username), title: `@${user.username}` });
  if (withAvatar) a.append(avatar(user, size));
  a.append(el("span", { class: "author-name", text: user.name }));
  return a;
}

export function stateBadge(kind, value) {
  if (kind === "issue") return value === "closed" ? badge("Closed", "info", { icon: "issue-closed" }) : badge("Open", "success", { icon: "issue-open-m" });
  if (value === "merged") return badge("Merged", "info-merged", { icon: "merge" });
  if (value === "closed") return badge("Closed", "danger", { icon: "merge-request-close" });
  return badge("Open", "success", { icon: "merge-request" });
}
