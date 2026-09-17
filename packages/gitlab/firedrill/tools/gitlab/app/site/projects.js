// Projects, namespaces, repository (tree, blob, editor), commits, branches and labels screens.
import { ToolError, action, alert, avatar, badge, button, call, clear, copyText, describe, el, formatBytes, formatDate, icon, iconButton, labelPill, markdown, newKey, openListbox, openMenu, openModal, pageAll, parseTimestamp, plural, projectAvatar, timeElement, toast, worldNow } from "./ui.js";
import { PER_PAGE, ROLE, canDevelop, copyButton, emptyState, errorPage, filteredSearch, hrefs, loadBranches, navigate, notSimulated, pagination, projectCrumbs, setBreadcrumbs, setTitle, skeletonRows, sortControl, splitRefAndPath, state, stateTabs, withQuery } from "./shell.js";

const stale = (token) => token !== state.navigation;
const visibilityIcon = { public: ["earth", "Public - The project can be accessed without any authentication."], internal: ["shield", "Internal - The project can be accessed by any logged in user except external users."], private: ["lock", "Private - Project access must be granted explicitly to each user."] };

function visibility(project) {
  const [name, title] = visibilityIcon[project.visibility] ?? visibilityIcon.private;
  return el("span", { class: "visibility-icon", title, attrs: { "aria-label": title } }, [icon(name)]);
}

// ---------------------------------------------------------------------------------------------
// Projects dashboard (#/)
// ---------------------------------------------------------------------------------------------

export async function renderProjects(main, route, token) {
  setBreadcrumbs([{ text: "Your work", href: "#/" }, { text: "Projects", href: "#/" }]);
  setTitle(["Projects"]);
  const tab = ["member", "personal", "inactive", "contributed", "starred"].includes(route.query.get("tab")) ? route.query.get("tab") : "member";
  const search = route.query.get("search") ?? "";
  const sort = ["name", "created_at", "last_activity_at"].includes(route.query.get("sort")) ? route.query.get("sort") : "last_activity_at";
  const direction = route.query.get("direction") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(route.query.get("page")) || 1);
  const hrefFor = (params) => hrefs.dashboard("projects", { tab, search, sort: sort === "last_activity_at" ? "" : sort, direction: direction === "desc" ? "" : direction, ...params });
  const container = el("div", { class: "page-padded projects-dashboard" });
  const heading = el("div", { class: "page-heading-row" }, [el("h1", { class: "page-heading", text: "Projects" }), el("div", { class: "page-heading-actions" }, [button("Explore projects", { onClick: () => notSimulated("Explore projects") }), button("New project", { variant: "confirm", onClick: () => notSimulated("New project") })])]);
  const list = el("div", { class: "projects-list-host" }, [skeletonRows(3)]);
  container.append(heading);
  const baseArgs = (name) => (name === "inactive" ? { archived: true, membership: true } : name === "personal" ? { owned: true } : { membership: true, archived: false });
  const tabs = [
    { id: "contributed", label: "Contributed", href: hrefFor({ tab: "contributed", page: "" }) },
    { id: "starred", label: "Starred", href: hrefFor({ tab: "starred", page: "" }) },
    { id: "personal", label: "Personal", href: hrefFor({ tab: "personal", page: "" }) },
    { id: "member", label: "Member", href: hrefFor({ tab: "member", page: "" }) },
    { id: "inactive", label: "Inactive", href: hrefFor({ tab: "inactive", page: "" }) },
  ];
  const toolbar = el("div", { class: "filtered-search-block" }, [
    filteredSearch({ tokens: [], values: {}, search, placeholder: "Filter or search (3 character minimum)", onSubmit: ({ search: text }) => navigate(hrefFor({ search: text, page: "" })) }),
    sortControl({ options: [{ value: "name", label: "Name" }, { value: "created_at", label: "Created date" }, { value: "last_activity_at", label: "Updated date" }], value: sort, direction, onChange: (value, dir) => navigate(hrefFor({ sort: value === "last_activity_at" ? "" : value, direction: dir === "desc" ? "" : dir, page: "" })) }),
  ]);
  const tabBar = stateTabs(tabs, tab);
  container.append(tabBar, toolbar, list);
  clear(main).append(container);
  // tab counters from real totals
  void Promise.all(["personal", "member", "inactive"].map((name) => call("projects.list", { ...baseArgs(name), per_page: 1 }).then((result) => [name, result.page?.total]).catch(() => [name, undefined]))).then((counts) => {
    if (stale(token)) return;
    for (const [name, count] of counts) {
      const anchor = tabBar.querySelectorAll(".gl-tab-nav-item")[tabs.findIndex((item) => item.id === name)];
      if (anchor && count !== undefined) anchor.append(el("span", { class: "gl-badge badge-neutral badge-sm gl-tab-counter-badge", text: String(count) }));
    }
  });
  if (tab === "contributed" || tab === "starred") {
    clear(list).append(emptyState(tab === "starred" ? "You haven't starred any projects yet" : "Contributed projects are not simulated", tab === "starred" ? "Starring projects is not simulated by this Tool, so this list is always empty." : "This Tool does not track contribution events. Use the Member or Personal tab to see the projects you can access.", [el("a", { class: "gl-button btn-default btn-md", href: hrefFor({ tab: "member" }), text: "Show projects you are a member of" })]));
    return;
  }
  if (search && search.length < 3) {
    clear(list).append(alert("Enter at least three characters to search", "info"));
    return;
  }
  const result = await call("projects.list", { ...baseArgs(tab), ...(search ? { search } : {}), order_by: sort, sort: direction, page, per_page: PER_PAGE });
  if (stale(token)) return;
  clear(list);
  if (result.items.length === 0) {
    list.append(search ? emptyState("No results found", "Edit your search and try again.") : emptyState(tab === "inactive" ? "You have no inactive projects" : "You haven't joined any projects yet", tab === "inactive" ? "Projects that are archived appear here." : "Projects that you are a member of appear here."));
    return;
  }
  const ul = el("ul", { class: "projects-list content-list" });
  for (const project of result.items) ul.append(projectRow(project));
  list.append(ul, pagination(result.page, (target) => hrefFor({ page: target })) ?? "");
}

function projectRow(project) {
  const li = el("li", { class: "project-row" });
  const level = project.permissions?.project_access?.access_level;
  li.append(el("a", { class: "project-avatar-link", href: hrefs.project(project.path_with_namespace), attrs: { tabindex: "-1", "aria-hidden": "true" } }, [projectAvatar(project, 48)]));
  const details = el("div", { class: "project-details" });
  const title = el("div", { class: "project-title" }, [
    el("a", { class: "project-full-name", href: hrefs.project(project.path_with_namespace) }, [el("span", { class: "namespace-name", text: `${project.namespace.name} / ` }), el("span", { class: "project-name", text: project.name })]),
    visibility(project),
  ]);
  if (level) title.append(badge(ROLE[level] ?? "Member", "neutral", { size: "sm" }));
  if (project.archived) title.append(badge("Archived", "warning", { size: "sm" }));
  details.append(title);
  if (project.description) details.append(el("div", { class: "project-description" }, [el("p", { text: project.description })]));
  if (project.topics?.length) details.append(el("div", { class: "project-topics" }, project.topics.map((topic) => badge(topic, "neutral", { size: "sm" }))));
  const stats = el("div", { class: "project-stats" }, [
    el("span", { class: "stat", title: "Stars" }, [icon("star-o"), el("span", { text: String(project.star_count) })]),
    el("span", { class: "stat", title: "Forks" }, [icon("fork"), el("span", { text: String(project.forks_count) })]),
    el("a", { class: "stat", title: "Issues", href: hrefs.issues(project.path_with_namespace) }, [icon("issues"), el("span", { text: String(project.open_issues_count) })]),
    el("div", { class: "project-updated" }, [el("span", { text: "Updated " }), timeElement(project.last_activity_at)]),
  ]);
  li.append(details, stats);
  return li;
}

// ---------------------------------------------------------------------------------------------
// Group or user page (#/<namespace>)
// ---------------------------------------------------------------------------------------------

export async function renderNamespace(main, route, token) {
  const path = route.namespace;
  const container = el("div", { class: "page-padded" }, [skeletonRows(3)]);
  clear(main).append(container);
  const projects = await pageAll((page) => call("projects.list", page));
  if (stale(token)) return;
  const owned = projects.filter((project) => project.namespace.full_path.toLowerCase() === path.toLowerCase());
  const group = owned.find((project) => project.namespace.kind === "group")?.namespace;
  clear(container);
  if (group) {
    setBreadcrumbs([{ text: group.name, href: hrefs.namespace(group.full_path) }]);
    setTitle([group.name]);
    container.append(
      el("div", { class: "group-home-panel" }, [avatar({ id: group.id, name: group.name }, 64, { square: true }), el("div", {}, [el("h1", { class: "home-panel-title", text: group.name }), el("div", { class: "home-panel-metadata" }, [el("span", { text: `Group ID: ${group.id}` }), copyButton(String(group.id), "Copy group ID")])])]),
      stateTabs([{ id: "subgroups", label: "Subgroups and projects", href: hrefs.namespace(group.full_path) }, { id: "shared", label: "Shared projects", href: hrefs.namespace(group.full_path) }, { id: "inactive", label: "Inactive", href: hrefs.namespace(group.full_path) }], "subgroups"),
    );
    const ul = el("ul", { class: "projects-list content-list" });
    for (const project of owned.filter((item) => !item.archived)) ul.append(projectRow(project));
    container.append(owned.length ? ul : emptyState("There are no projects in this group you can see", ""));
    return;
  }
  let user;
  try {
    user = await call("users.get", { username: path });
  } catch (error) {
    if (stale(token)) return;
    clear(main).append(errorPage(error));
    setBreadcrumbs([{ text: path, href: hrefs.namespace(path) }]);
    return;
  }
  if (stale(token)) return;
  setBreadcrumbs([{ text: user.name, href: hrefs.user(user.username) }]);
  setTitle([user.name]);
  const header = el("div", { class: "user-profile-header" }, [
    avatar(user, 96),
    el("div", { class: "user-profile-info" }, [
      el("h1", { class: "user-profile-name", text: user.name }),
      el("p", { class: "gl-text-subtle", text: `@${user.username}` }),
      user.bot ? badge("Bot", "muted", { size: "sm" }) : "",
      user.state === "blocked" ? badge("Blocked", "danger", { size: "sm" }) : "",
      user.bio ? el("p", { class: "user-bio", text: user.bio }) : "",
      el("div", { class: "user-profile-meta" }, [
        user.job_title ? el("span", {}, [icon("work"), el("span", { text: user.job_title })]) : "",
        user.organization ? el("span", {}, [icon("building"), el("span", { text: user.organization })]) : "",
        el("span", {}, [icon("calendar"), el("span", { text: `Member since ${formatDate(user.created_at)}` })]),
      ]),
    ]),
  ]);
  container.append(header, stateTabs([{ id: "overview", label: "Overview", href: hrefs.user(user.username) }, { id: "activity", label: "Activity", href: hrefs.user(user.username) }, { id: "personal", label: "Personal projects", href: hrefs.user(user.username) }, { id: "starred", label: "Starred projects", href: hrefs.user(user.username) }], "personal"));
  const personal = projects.filter((project) => project.namespace.kind === "user" && project.namespace.full_path.toLowerCase() === user.username.toLowerCase());
  if (personal.length) {
    const ul = el("ul", { class: "projects-list content-list" });
    for (const project of personal) ul.append(projectRow(project));
    container.append(ul);
  } else container.append(emptyState("This user doesn't have any personal projects", ""));
}

// ---------------------------------------------------------------------------------------------
// Repository shared pieces
// ---------------------------------------------------------------------------------------------

function projectHeader(project) {
  const header = el("header", { class: "project-home-panel" });
  const left = el("div", { class: "home-panel-title-row" }, [projectAvatar(project, 48), el("div", {}, [el("h1", { class: "home-panel-title" }, [el("span", { text: project.name }), visibility(project)]), el("div", { class: "home-panel-metadata" }, [el("span", { class: "gl-text-subtle", text: `Project ID: ${project.id}` }), copyButton(String(project.id), "Copy project ID")])])]);
  const actions = el("div", { class: "project-repo-buttons" }, [
    iconButton("notifications", "Notification setting - Global", { variant: "default", onClick: () => notSimulated("Notification settings") }),
    el("div", { class: "count-badge" }, [button("Star", { icon: "star-o", class: "count-badge-button", onClick: () => notSimulated("Starring projects") }), el("span", { class: "count-badge-count", text: String(project.star_count) })]),
    el("div", { class: "count-badge" }, [button("Fork", { icon: "fork", class: "count-badge-button", onClick: () => notSimulated("Forking") }), el("span", { class: "count-badge-count", text: String(project.forks_count) })]),
  ]);
  header.append(left, actions);
  return header;
}

function refSelector(project, branches, ref, hrefForRef) {
  const trigger = button(ref, { icon: "branch", trailingIcon: "chevron-down", class: "ref-selector" });
  trigger.addEventListener("click", () =>
    openListbox(trigger, {
      title: "Switch branch/tag",
      placeholder: "Search by Git revision",
      options: branches.map((branch) => ({ id: branch.name, label: branch.name, description: branch.default ? "default" : branch.protected ? "protected" : "", selected: branch.name === ref })),
      onSelect: (name) => navigate(hrefForRef(name)),
      width: 320,
    }),
  );
  return trigger;
}

function pathBreadcrumb(project, ref, path, { file = false } = {}) {
  const nav = el("nav", { class: "repo-breadcrumb", attrs: { "aria-label": "Files breadcrumb" } });
  const list = el("ol", { class: "breadcrumb repo-breadcrumb-list" });
  list.append(el("li", {}, [el("a", { href: hrefs.tree(project.path_with_namespace, ref), text: project.path })]));
  const parts = path ? path.split("/") : [];
  parts.forEach((part, index) => {
    const partial = parts.slice(0, index + 1).join("/");
    const last = index === parts.length - 1;
    list.append(el("li", {}, [el("a", { href: last && file ? hrefs.blob(project.path_with_namespace, ref, partial) : hrefs.tree(project.path_with_namespace, ref, partial), text: part, attrs: { "aria-current": last ? "page" : undefined } })]));
  });
  nav.append(list);
  return nav;
}

async function lastCommitFor(project, ref, path) {
  const result = await call("commits.list", { id: project.id, ref_name: ref, ...(path ? { path } : {}), per_page: 1 });
  return result.items[0];
}

function commitAuthorAvatar(commit, size = 32) {
  const known = [...state.people.values()].find((user) => `${user.username}@example.test` === commit.author_email || user.name === commit.author_name);
  return avatar(known ?? { id: commit.author_email, name: commit.author_name }, size);
}

function lastCommitPanel(project, commit, historyHref) {
  const box = el("div", { class: "info-well project-last-commit" });
  if (!commit) {
    box.append(el("span", { class: "gl-text-subtle", text: "No commits yet" }));
    return box;
  }
  const content = el("div", { class: "commit-detail" }, [
    commitAuthorAvatar(commit),
    el("div", { class: "commit-content" }, [
      el("a", { class: "commit-row-message item-title", href: hrefs.commit(project.path_with_namespace, commit.id), text: commit.title }),
      el("div", { class: "committer" }, [el("span", { class: "commit-author-link", text: commit.author_name }), el("span", { text: " authored " }), timeElement(commit.authored_date)]),
    ]),
    el("div", { class: "commit-actions" }, [el("div", { class: "gl-button-group commit-sha-group" }, [el("a", { class: "gl-button btn-default btn-md commit-sha-button", href: hrefs.commit(project.path_with_namespace, commit.id), text: commit.short_id }), copyButton(commit.id, "Copy commit SHA")]), historyHref ? el("a", { class: "gl-button btn-default btn-md", href: historyHref, text: "History" }) : ""]),
  ]);
  box.append(content);
  return box;
}

function fileIcon(name, type) {
  if (type === "tree") return icon("folder-o", "folder-icon");
  if (/\.(md|markdown)$/i.test(name)) return icon("doc-text", "file-icon");
  if (/\.(ts|js|mjs|json|ya?ml|sh|rb|py|go|css|html)$|^\.|rc$/i.test(name)) return icon("doc-code", "file-icon");
  return icon("doc-text", "file-icon");
}

async function repositoryBrowser(main, project, ref, path, token, { withHeader }) {
  const branches = await loadBranches(project);
  if (stale(token)) return;
  const container = el("div", { class: "page-padded project-page" });
  if (withHeader) container.append(projectHeader(project));
  if (project.archived) container.append(alert("This is an archived project. Repository and other project resources are read-only.", "warning"));
  const layout = el("div", { class: withHeader ? "project-overview-layout" : "" });
  const primary = el("div", { class: "project-overview-main" });
  const controls = el("div", { class: "tree-controls-row" });
  const left = el("div", { class: "tree-ref-container" }, [refSelector(project, branches, ref, (name) => hrefs.tree(project.path_with_namespace, name, path)), pathBreadcrumb(project, ref, path)]);
  const addMenu = iconButton("plus", "Add to tree", { variant: "default", onClick: (event) =>
    openMenu(event.currentTarget, [
      { header: "This directory" },
      { label: "New file", disabled: !canDevelop(project), onSelect: () => navigate(hrefs.newFile(project.path_with_namespace, ref, path)) },
      { label: "Upload file", onSelect: () => notSimulated("Upload file") },
      { label: "New directory", onSelect: () => notSimulated("New directory") },
      "divider",
      { header: "This repository" },
      { label: "New branch", disabled: !canDevelop(project), onSelect: () => navigate(hrefs.newBranch(project.path_with_namespace, ref)) },
      { label: "New tag", onSelect: () => notSimulated("Tags") },
    ], { width: 220 }) });
  left.append(addMenu);
  const right = el("div", { class: "tree-controls" }, [
    el("a", { class: "gl-button btn-default btn-md", href: hrefs.commits(project.path_with_namespace, ref, path ? { path } : {}), text: "History" }),
    button("Find file", { onClick: () => notSimulated("Find file") }),
    button("Edit", { trailingIcon: "chevron-down", onClick: (event) => openMenu(event.currentTarget, [{ label: "Web IDE", description: "Quickly and easily edit multiple files.", onSelect: () => notSimulated("Web IDE") }, { label: "Gitpod", onSelect: () => notSimulated("Gitpod") }], { align: "end", width: 260 }) }),
    button("Code", { variant: "confirm", trailingIcon: "chevron-down", onClick: (event) => cloneMenu(event.currentTarget, project) }),
  ]);
  controls.append(left, right);
  primary.append(controls);
  const commitHost = el("div", {}, [skeletonRows(1)]);
  const treeHost = el("div", {}, [skeletonRows(4)]);
  const readmeHost = el("div");
  primary.append(commitHost, treeHost, readmeHost);
  layout.append(primary);
  if (withHeader) layout.append(projectInfoSidebar(project, ref, token));
  container.append(layout);
  clear(main).append(container);

  const [lastCommit, tree] = await Promise.all([lastCommitFor(project, ref, path), pageAll((page) => call("repository.list-tree", { id: project.id, ref, ...(path ? { path } : {}), ...page }))]);
  if (stale(token)) return;
  clear(commitHost).append(lastCommitPanel(project, lastCommit, hrefs.commits(project.path_with_namespace, ref, path ? { path } : {})));
  const table = el("table", { class: "table tree-table" });
  table.append(el("thead", {}, [el("tr", {}, [el("th", { text: "Name" }), el("th", { class: "tree-commit-column", text: "Last commit" }), el("th", { class: "tree-time-ago", text: "Last update" })])]));
  const body = el("tbody");
  if (path) {
    const parent = path.split("/").slice(0, -1).join("/");
    body.append(el("tr", { class: "tree-item" }, [el("td", { attrs: { colspan: "3" } }, [el("a", { class: "tree-item-link", href: hrefs.tree(project.path_with_namespace, ref, parent), text: ".." })])]));
  }
  const sorted = [...tree].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "tree" ? -1 : 1));
  const cells = [];
  for (const entry of sorted) {
    const href = entry.type === "tree" ? hrefs.tree(project.path_with_namespace, ref, entry.path) : hrefs.blob(project.path_with_namespace, ref, entry.path);
    const commitCell = el("td", { class: "tree-commit-column" }, [el("span", { class: "skeleton-line w-60" })]);
    const timeCell = el("td", { class: "tree-time-ago" }, [el("span", { class: "skeleton-line w-30" })]);
    body.append(el("tr", { class: "tree-item" }, [el("td", { class: "tree-item-file-name" }, [el("a", { class: "tree-item-link", href }, [fileIcon(entry.name, entry.type), el("span", { text: entry.name })])]), commitCell, timeCell]));
    cells.push({ entry, commitCell, timeCell });
  }
  table.append(body);
  clear(treeHost).append(el("div", { class: "tree-content-holder" }, [table]));
  if (sorted.length === 0) clear(treeHost).append(emptyState("This directory is empty", ""));
  void Promise.all(
    cells.map(async ({ entry, commitCell, timeCell }) => {
      const commit = await lastCommitFor(project, ref, entry.path).catch(() => undefined);
      if (stale(token)) return;
      clear(commitCell).append(commit ? el("a", { class: "str-truncated-100 tree-commit-link", href: hrefs.commit(project.path_with_namespace, commit.id), text: commit.title }) : "");
      clear(timeCell).append(commit ? timeElement(commit.committed_date) : "");
    }),
  );
  const readme = sorted.find((entry) => entry.type === "blob" && /^readme(\.md|\.markdown|\.txt)?$/i.test(entry.name));
  if (readme) {
    const file = await call("repository.get-file", { id: project.id, file_path: readme.path, ref }).catch(() => undefined);
    if (stale(token) || !file) return;
    readmeHost.append(
      el("article", { class: "file-holder readme-holder" }, [
        el("div", { class: "file-title-flex-parent" }, [el("div", { class: "file-header-content" }, [icon("doc-text"), el("a", { class: "file-title-name", href: hrefs.blob(project.path_with_namespace, ref, readme.path), text: readme.name })])]),
        el("div", { class: "blob-viewer file-content md" }, [...markdown(file.text).childNodes]),
      ]),
    );
  }
}

function cloneMenu(anchor, project) {
  const panel = openMenu(anchor, [], { align: "end", width: 340 });
  const list = panel.querySelector(".gl-dropdown-list");
  const row = (title, value) => el("li", { class: "clone-row" }, [el("label", { class: "clone-label", text: title }), el("div", { class: "gl-input-group" }, [el("input", { class: "gl-form-input", attrs: { type: "text", readonly: true, value, "aria-label": title } }), iconButton("copy-to-clipboard", "Copy URL", { variant: "default", onClick: () => copyText(value, "URL copied") })])]);
  list.append(el("li", { class: "gl-dropdown-section-header", text: "Clone with SSH" }), row("SSH", project.ssh_url_to_repo), el("li", { class: "gl-dropdown-section-header", text: "Clone with HTTPS" }), row("HTTPS", project.http_url_to_repo), el("li", { class: "gl-dropdown-divider" }), el("li", { class: "gl-dropdown-section-header", text: "These URLs belong to the synthetic instance; there is no Git server behind them." }));
}

function projectInfoSidebar(project, ref, token) {
  const aside = el("aside", { class: "project-page-sidebar" });
  const block = el("div", { class: "project-page-sidebar-block" }, [el("h2", { class: "sidebar-heading", text: "Project information" })]);
  if (project.description) block.append(el("p", { class: "project-description-text", text: project.description }));
  if (project.topics?.length) block.append(el("div", { class: "project-topics" }, project.topics.map((topic) => badge(topic, "neutral", { size: "sm" }))));
  const links = el("ul", { class: "project-stats-list" });
  const commitsItem = el("li", {}, [el("a", { class: "stat-link", href: hrefs.commits(project.path_with_namespace, ref) }, [icon("commit"), el("strong", { text: "…" }), el("span", { text: " Commits" })])]);
  const branchesItem = el("li", {}, [el("a", { class: "stat-link", href: hrefs.branches(project.path_with_namespace) }, [icon("branch"), el("strong", { text: "…" }), el("span", { text: " Branches" })])]);
  links.append(commitsItem, branchesItem, el("li", {}, [el("a", { class: "stat-link", href: hrefs.labels(project.path_with_namespace) }, [icon("label"), el("span", { text: "Labels" })])]));
  if (project.readme_url) links.append(el("li", {}, [el("a", { class: "stat-link", href: hrefs.blob(project.path_with_namespace, ref, "README.md") }, [icon("doc-text"), el("span", { text: "README" })])]));
  links.append(el("li", {}, [el("button", { class: "stat-link btn-link-dashed", attrs: { type: "button" } }, [icon("plus"), el("span", { text: "Add LICENSE" })])]));
  links.lastChild.firstChild.addEventListener("click", () => notSimulated("Adding a licence"));
  block.append(links, el("div", { class: "project-created" }, [el("h3", { class: "sidebar-subheading", text: "Created on" }), el("span", { text: formatDate(project.created_at) })]));
  aside.append(block);
  void Promise.all([pageAll((page) => call("commits.list", { id: project.id, ref_name: ref, ...page })).then((list) => list.length).catch(() => undefined), loadBranches(project).then((list) => list.length).catch(() => undefined)]).then(([commits, branches]) => {
    if (stale(token)) return;
    commitsItem.querySelector("strong").textContent = commits === undefined ? "?" : String(commits);
    branchesItem.querySelector("strong").textContent = branches === undefined ? "?" : String(branches);
    commitsItem.querySelector("strong + span").textContent = commits === 1 ? " Commit" : " Commits";
    branchesItem.querySelector("strong + span").textContent = branches === 1 ? " Branch" : " Branches";
  });
  return aside;
}

export async function renderOverview(main, route, project, token) {
  setBreadcrumbs(projectCrumbs(project));
  setTitle([project.name_with_namespace]);
  if (project.empty_repo || !project.default_branch) {
    clear(main).append(el("div", { class: "page-padded" }, [projectHeader(project), emptyState("The repository for this project is empty", "You can get started by cloning the repository or start adding files to it with one of the following options.")]));
    return;
  }
  await repositoryBrowser(main, project, project.default_branch, "", token, { withHeader: true });
}

export async function renderTree(main, route, project, token) {
  const branches = await loadBranches(project);
  if (stale(token)) return;
  const { ref, path } = splitRefAndPath(route.rest, branches);
  const actualRef = ref || project.default_branch || "main";
  setBreadcrumbs(projectCrumbs(project, [{ text: "Repository", href: hrefs.tree(project.path_with_namespace, actualRef, path) }]));
  setTitle([path || "Files", actualRef, project.name_with_namespace]);
  await repositoryBrowser(main, project, actualRef, path, token, { withHeader: false });
}

// ---------------------------------------------------------------------------------------------
// Blob view and single-file editor
// ---------------------------------------------------------------------------------------------

function codeTable(text) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const wrap = el("div", { class: "file-content code highlight" });
  const numbers = el("div", { class: "line-numbers", attrs: { "aria-hidden": "true" } });
  const code = el("pre", { class: "code-lines" });
  lines.forEach((line, index) => {
    numbers.append(el("a", { class: "file-line-num", href: `#L${index + 1}`, text: String(index + 1), attrs: { tabindex: "-1" } }));
    code.append(el("span", { class: "line", text: line || " " }), "\n");
  });
  wrap.append(numbers, el("div", { class: "blob-content" }, [code]));
  return wrap;
}

export async function renderBlob(main, route, project, token) {
  const branches = await loadBranches(project);
  if (stale(token)) return;
  const { ref, path } = splitRefAndPath(route.rest, branches);
  setBreadcrumbs(projectCrumbs(project, [{ text: "Repository", href: hrefs.tree(project.path_with_namespace, ref) }]));
  setTitle([path, ref, project.name_with_namespace]);
  const container = el("div", { class: "page-padded project-page" }, [skeletonRows(3)]);
  clear(main).append(container);
  const [file, commit] = await Promise.all([call("repository.get-file", { id: project.id, file_path: path, ref }), lastCommitFor(project, ref, path).catch(() => undefined)]);
  if (stale(token)) return;
  clear(container);
  if (project.archived) container.append(alert("This is an archived project. Repository and other project resources are read-only.", "warning"));
  const controls = el("div", { class: "tree-controls-row" }, [
    el("div", { class: "tree-ref-container" }, [refSelector(project, branches, ref, (name) => hrefs.blob(project.path_with_namespace, name, path)), pathBreadcrumb(project, ref, path, { file: true })]),
    el("div", { class: "tree-controls" }, [
      el("a", { class: "gl-button btn-default btn-md", href: hrefs.commits(project.path_with_namespace, ref, { path }), text: "History" }),
      button("Find file", { onClick: () => notSimulated("Find file") }),
      button("Blame", { onClick: () => notSimulated("Blame") }),
      iconButton("ellipsis_v", "More actions", { variant: "default", onClick: (event) => openMenu(event.currentTarget, [{ label: "Permalink", description: "Copy a link to this file at this commit", onSelect: () => copyText(`${project.web_url}/-/blob/${file.commit_id}/${path}`, "Permalink copied") }], { align: "end", width: 260 }) }),
    ]),
  ]);
  container.append(controls, lastCommitPanel(project, commit, hrefs.commits(project.path_with_namespace, ref, { path })));
  const holder = el("div", { class: "file-holder" });
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  let rendered = isMarkdown;
  const content = el("div");
  const draw = () => {
    clear(content).append(rendered ? el("div", { class: "blob-viewer file-content md" }, [...markdown(file.text).childNodes]) : codeTable(file.text));
  };
  const header = el("div", { class: "file-title-flex-parent js-file-title" });
  const title = el("div", { class: "file-header-content" }, [fileIcon(file.file_name, "blob"), el("strong", { class: "file-title-name", text: file.file_name }), copyButton(path, "Copy file path"), el("small", { class: "file-size", text: formatBytes(file.size) })]);
  const actions = el("div", { class: "file-actions" });
  if (isMarkdown) {
    const group = el("div", { class: "gl-button-group" });
    const source = iconButton("code", "Display source", { variant: "default" });
    const pretty = iconButton("doc-text", "Display rendered file", { variant: "default" });
    const sync = () => {
      source.classList.toggle("selected", !rendered);
      pretty.classList.toggle("selected", rendered);
    };
    source.addEventListener("click", () => {
      rendered = false;
      sync();
      draw();
    });
    pretty.addEventListener("click", () => {
      rendered = true;
      sync();
      draw();
    });
    sync();
    group.append(source, pretty);
    actions.append(group);
  }
  const writable = canDevelop(project);
  const edit = button("Edit", { variant: "confirm", trailingIcon: "chevron-down", disabled: project.archived, onClick: (event) => openMenu(event.currentTarget, [{ label: "Edit single file", description: "Edit this file only.", disabled: !writable, onSelect: () => navigate(hrefs.edit(project.path_with_namespace, ref, path)) }, { label: "Open in Web IDE", description: "Quickly and easily edit multiple files in your project.", onSelect: () => notSimulated("Web IDE") }], { align: "end", width: 280 }) });
  actions.append(
    edit,
    button("Replace", { disabled: project.archived, onClick: () => notSimulated("Replacing a file by upload") }),
    button("Delete", { disabled: project.archived || !writable, onClick: () => deleteFile(project, ref, path, file) }),
    el("div", { class: "gl-button-group" }, [
      iconButton("copy-to-clipboard", "Copy file contents", { variant: "default", onClick: () => copyText(file.text, "File contents copied") }),
      iconButton("doc-code", "Open raw", { variant: "default", onClick: () => openRaw(file) }),
      iconButton("download", "Download", { variant: "default", onClick: () => notSimulated("Downloading files") }),
    ]),
  );
  header.append(title, actions);
  holder.append(header, content);
  draw();
  container.append(holder);
}

function openRaw(file) {
  void openModal(file.file_path, (body) => body.append(el("pre", { class: "raw-file", text: file.text })), { size: "lg" });
}

/** Commit options shared by edit, new file and delete: current branch, or a new branch with an optional merge request. */
function commitOptions(body, project, ref, branches, defaultMessage) {
  const branch = branches.find((item) => item.name === ref);
  const canPushHere = branch ? branch.can_push : canDevelop(project);
  const message = el("textarea", { class: "gl-form-textarea", attrs: { id: "commit-message", rows: "3", "aria-label": "Commit message" } });
  message.value = defaultMessage;
  body.append(el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Commit message", attrs: { for: "commit-message" } }), message]));
  const current = el("input", { attrs: { type: "radio", name: "branch-choice", id: "commit-current", value: "current" } });
  const other = el("input", { attrs: { type: "radio", name: "branch-choice", id: "commit-new", value: "new" } });
  const newName = el("input", { class: "gl-form-input", attrs: { type: "text", id: "commit-branch", "aria-label": "Branch name", placeholder: "example-branch-name" } });
  const suffix = Math.abs([...`${ref}${defaultMessage}`].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) | 0, 7)) % 100000;
  newName.value = `${state.user?.username ?? "user"}-${ref.replace(/[^\w.-]+/g, "-")}-patch-${suffix}`;
  const mr = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "commit-mr" } });
  mr.checked = true;
  const group = el("fieldset", { class: "gl-form-group" }, [el("legend", { class: "gl-form-label", text: "Branch" })]);
  if (canPushHere) group.append(el("div", { class: "gl-form-radio" }, [current, el("label", { attrs: { for: "commit-current" } }, [el("span", { text: "Commit to the current " }), el("code", { text: ref }), el("span", { text: " branch" })])]));
  else group.append(alert(`You can't commit to ${ref} directly because it is a protected branch or you don't have push access. Create a new branch instead.`, "info"));
  group.append(el("div", { class: "gl-form-radio" }, [other, el("label", { attrs: { for: "commit-new" }, text: "Commit to a new branch" })]));
  const newBlock = el("div", { class: "commit-new-branch" }, [newName, el("div", { class: "gl-form-checkbox" }, [mr, el("label", { attrs: { for: "commit-mr" }, text: "Create a merge request for this change" })])]);
  group.append(newBlock);
  body.append(group);
  const sync = () => {
    newBlock.hidden = !other.checked;
  };
  if (canPushHere) current.checked = true;
  else other.checked = true;
  current.addEventListener("change", sync);
  other.addEventListener("change", sync);
  sync();
  return () => ({ message: message.value.trim(), branch: other.checked ? newName.value.trim() : ref, startBranch: other.checked ? ref : undefined, createMr: other.checked && mr.checked });
}

function deleteFile(project, ref, path, file) {
  void loadBranches(project).then((branches) =>
    openModal(`Delete ${file.file_name}`, (body, close, footer) => {
      const read = commitOptions(body, project, ref, branches, `Delete ${file.file_name}`);
      const errorHost = el("div");
      body.prepend(errorHost);
      const ok = button("Commit changes", { variant: "danger", onClick: () =>
        action(async () => {
          const options = read();
          await call("commits.create", { id: project.id, branch: options.branch, ...(options.startBranch ? { start_branch: options.startBranch } : {}), commit_message: options.message || `Delete ${file.file_name}`, actions: [{ action: "delete", file_path: path, last_commit_id: file.last_commit_id }] }, newKey());
          close(true);
          toast(`The file has been successfully deleted.`);
          navigate(options.createMr ? hrefs.newMr(project.path_with_namespace, { source_branch: options.branch, target_branch: ref }) : hrefs.tree(project.path_with_namespace, options.branch, path.split("/").slice(0, -1).join("/")));
        }, { onError: (error) => clear(errorHost).append(alert(conflictText(error), "danger")) }) });
      footer.append(button("Cancel", { onClick: () => close() }), ok);
    }),
  );
}

function conflictText(error) {
  if (error instanceof ToolError && error.is("CONFLICT")) return `Someone edited the file the same time you did. Please check out the file and make sure your changes will not unintentionally remove theirs. (${error.message})`;
  return describe(error);
}

export async function renderEditFile(main, route, project, token, { mode }) {
  const branches = await loadBranches(project);
  if (stale(token)) return;
  const { ref, path } = splitRefAndPath(route.rest, branches);
  const creating = mode === "new";
  setBreadcrumbs(projectCrumbs(project, [{ text: "Repository", href: hrefs.tree(project.path_with_namespace, ref) }, { text: creating ? "New file" : "Edit", href: location.hash }]));
  setTitle([creating ? "New file" : `Edit ${path}`, project.name_with_namespace]);
  const container = el("div", { class: "page-padded project-page file-editor" }, [skeletonRows(3)]);
  clear(main).append(container);
  const file = creating ? undefined : await call("repository.get-file", { id: project.id, file_path: path, ref });
  if (stale(token)) return;
  clear(container);
  if (!canDevelop(project)) container.append(alert("You don't have permission to edit files in this project. Developers and above can commit changes.", "warning"));
  const heading = el("div", { class: "page-heading-row" }, [el("h1", { class: "page-heading", text: creating ? "New file" : "Edit file" })]);
  const directory = creating ? path : path.split("/").slice(0, -1).join("/");
  const nameInput = el("input", { class: "gl-form-input file-name-input", attrs: { type: "text", "aria-label": "File name", placeholder: "Filename" } });
  nameInput.value = creating ? "" : path.split("/").pop();
  const pathRow = el("div", { class: "file-editor-path" }, [el("span", { class: "editor-ref" }, [icon("branch", "", 14), el("span", { text: ref })]), el("span", { class: "editor-path-prefix", text: `${project.path} / ${directory ? `${directory.split("/").join(" / ")} / ` : ""}` }), nameInput]);
  const textarea = el("textarea", { class: "file-editor-textarea", attrs: { spellcheck: "false", "aria-label": "File contents", wrap: "off" } });
  textarea.value = file?.text ?? "";
  const editorTabs = el("div", { class: "file-editor-tabs" });
  const writeTab = el("button", { class: "md-header-tab active", text: creating ? "Write" : "Edit", attrs: { type: "button" } });
  const previewTab = el("button", { class: "md-header-tab", text: "Preview changes", attrs: { type: "button" } });
  const wrapToggle = el("label", { class: "soft-wrap-toggle" }, [el("input", { attrs: { type: "checkbox" } }), el("span", { text: "Soft wrap" })]);
  wrapToggle.firstChild.addEventListener("change", (event) => textarea.setAttribute("wrap", event.target.checked ? "soft" : "off"));
  editorTabs.append(writeTab, previewTab, wrapToggle);
  const preview = el("div", { class: "file-editor-preview" });
  preview.hidden = true;
  writeTab.addEventListener("click", () => {
    writeTab.classList.add("active");
    previewTab.classList.remove("active");
    textarea.hidden = false;
    preview.hidden = true;
  });
  previewTab.addEventListener("click", () => {
    previewTab.classList.add("active");
    writeTab.classList.remove("active");
    textarea.hidden = true;
    preview.hidden = false;
    clear(preview).append(/\.(md|markdown)$/i.test(nameInput.value) ? el("div", { class: "md" }, [...markdown(textarea.value).childNodes]) : simpleLineDiff(file?.text ?? "", textarea.value));
  });
  const markDirty = () => {
    state.editing = textarea.value !== (file?.text ?? "") || (creating && nameInput.value.length > 0);
  };
  textarea.addEventListener("input", markDirty);
  nameInput.addEventListener("input", markDirty);
  const errorHost = el("div");
  const commitButton = button("Commit changes", { variant: "confirm", disabled: !canDevelop(project), onClick: () => {
    const name = nameInput.value.trim();
    if (!name) {
      clear(errorHost).append(alert("Enter a file name.", "danger"));
      nameInput.focus();
      return;
    }
    const filePath = [directory, name].filter(Boolean).join("/");
    const renamed = !creating && filePath !== path;
    void openModal("Commit changes", (body, close, footer) => {
      const modalError = el("div");
      body.append(modalError);
      const read = commitOptions(body, project, ref, branches, creating ? `Add new file` : `Update ${name}`);
      footer.append(
        button("Cancel", { onClick: () => close() }),
        button("Commit changes", { variant: "confirm", onClick: () =>
          action(async () => {
            const options = read();
            const actions = creating
              ? [{ action: "create", file_path: filePath, content: textarea.value }]
              : renamed
                ? [{ action: "move", previous_path: path, file_path: filePath, content: textarea.value, last_commit_id: file.last_commit_id }]
                : [{ action: "update", file_path: filePath, content: textarea.value, last_commit_id: file.last_commit_id }];
            await call("commits.create", { id: project.id, branch: options.branch, ...(options.startBranch ? { start_branch: options.startBranch } : {}), commit_message: options.message || (creating ? "Add new file" : `Update ${name}`), actions }, newKey());
            state.editing = false;
            close(true);
            toast("Your changes have been committed successfully.");
            navigate(options.createMr ? hrefs.newMr(project.path_with_namespace, { source_branch: options.branch, target_branch: ref }) : hrefs.blob(project.path_with_namespace, options.branch, filePath));
          }, { onError: (error) => clear(modalError).append(alert(conflictText(error), "danger")) }) }),
      );
    });
  } });
  heading.append(el("div", { class: "page-heading-actions" }, [el("a", { class: "gl-button btn-default btn-md", href: creating ? hrefs.tree(project.path_with_namespace, ref, path) : hrefs.blob(project.path_with_namespace, ref, path), text: "Cancel" }), commitButton]));
  container.append(heading, errorHost, el("div", { class: "file-holder file-editor-holder" }, [el("div", { class: "file-title-flex-parent" }, [pathRow]), editorTabs, textarea, preview]));
}

function simpleLineDiff(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  if (before === after) return el("p", { class: "gl-text-subtle preview-empty", text: "No changes." });
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const lines = [`@@ -${start + 1},${endA - start + 1} +${start + 1},${endB - start + 1} @@`, ...a.slice(start, endA + 1).map((line) => `-${line}`), ...b.slice(start, endB + 1).map((line) => `+${line}`)];
  return diffTable(lines.join("\n"));
}

// ---------------------------------------------------------------------------------------------
// Diffs (shared with merge requests)
// ---------------------------------------------------------------------------------------------

export function diffStats(diff) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

export function diffTable(diff) {
  const table = el("table", { class: "code diff-wrap-lines text-file" });
  const body = el("tbody");
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(diff ?? "").replace(/\n$/, "").split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      body.append(el("tr", { class: "line_holder match" }, [el("td", { class: "diff-line-num old_line", text: "..." }), el("td", { class: "diff-line-num new_line", text: "..." }), el("td", { class: "line_content match", text: line })]));
      continue;
    }
    if (line.startsWith("\\")) continue;
    const kind = line.startsWith("+") ? "new" : line.startsWith("-") ? "old" : "";
    const oldCell = el("td", { class: `diff-line-num old_line ${kind}`, text: kind === "new" ? "" : String(oldLine) });
    const newCell = el("td", { class: `diff-line-num new_line ${kind}`, text: kind === "old" ? "" : String(newLine) });
    body.append(el("tr", { class: "line_holder" }, [oldCell, newCell, el("td", { class: `line_content ${kind}`, attrs: { "data-sign": kind === "new" ? "+" : kind === "old" ? "-" : " " } }, [el("span", { text: line.slice(1) || " " })])]));
    if (kind !== "new") oldLine += 1;
    if (kind !== "old") newLine += 1;
  }
  table.append(body);
  return table;
}

export function diffFile(file, { project, sha } = {}) {
  const { additions, deletions } = diffStats(file.diff);
  const holder = el("div", { class: "diff-file file-holder", attrs: { id: `diff-${file.new_path}` } });
  const toggle = iconButton("chevron-down", "Hide file contents", { size: "sm", class: "diff-toggle-caret" });
  const header = el("div", { class: "js-file-title file-title-flex-parent diff-file-header" });
  const name = file.renamed_file ? `${file.old_path} → ${file.new_path}` : file.deleted_file ? file.old_path : file.new_path;
  const title = el("div", { class: "file-header-content" }, [toggle, fileIcon(name, "blob"), el("strong", { class: "file-title-name", text: name }), copyButton(file.new_path, "Copy file path")]);
  if (file.new_file) title.append(badge("new", "success", { size: "sm" }));
  if (file.deleted_file) title.append(badge("deleted", "danger", { size: "sm" }));
  if (file.b_mode !== file.a_mode && !file.new_file && !file.deleted_file) title.append(el("small", { class: "gl-text-subtle", text: `${file.a_mode} → ${file.b_mode}` }));
  const counts = el("div", { class: "file-actions" }, [el("span", { class: "diff-stats" }, [el("span", { class: "gl-text-success", text: `+${additions}` }), el("span", { class: "gl-text-danger", text: ` −${deletions}` })])]);
  if (project && sha && !file.deleted_file) counts.append(el("a", { class: "gl-button btn-default btn-sm", href: hrefs.blob(project.path_with_namespace, sha, file.new_path), text: "View file @ " }, []));
  if (project && sha && !file.deleted_file) counts.lastChild.append(el("code", { text: sha.slice(0, 8) }));
  header.append(title, counts);
  const content = el("div", { class: "diff-content diff-wrap-lines" }, [file.diff ? diffTable(file.diff) : el("div", { class: "nothing-here-block", text: file.too_large ? "This diff is too large to display." : "No changes." })]);
  toggle.addEventListener("click", () => {
    content.hidden = !content.hidden;
    toggle.replaceChildren(icon(content.hidden ? "chevron-right" : "chevron-down"));
    toggle.title = content.hidden ? "Show file contents" : "Hide file contents";
  });
  holder.append(header, content);
  return holder;
}

// ---------------------------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------------------------

export function commitList(project, commits) {
  const wrap = el("div", { class: "commits-list" });
  let day;
  let group;
  for (const commit of commits) {
    const label = formatDate(commit.committed_date);
    if (label !== day) {
      day = label;
      const count = commits.filter((item) => formatDate(item.committed_date) === label).length;
      wrap.append(el("div", { class: "commit-header" }, [el("span", { class: "day", text: label }), el("span", { class: "commits-count", text: plural(count, "commit") })]));
      group = el("ul", { class: "content-list commit-list" });
      wrap.append(group);
    }
    const li = el("li", { class: "commit" }, [
      commitAuthorAvatar(commit),
      el("div", { class: "commit-detail" }, [
        el("div", { class: "commit-content" }, [
          el("a", { class: "commit-row-message item-title", href: hrefs.commit(project.path_with_namespace, commit.id), text: commit.title }),
          commit.message.trim() !== commit.title ? iconButton("ellipsis_h", "Toggle commit description", { size: "sm", class: "text-expander", onClick: (event) => {
            const description = event.currentTarget.closest(".commit-content").querySelector(".commit-row-description");
            description.hidden = !description.hidden;
          } }) : "",
          el("div", { class: "committer" }, [el("span", { class: "commit-author-link", text: commit.author_name }), el("span", { text: " authored " }), timeElement(commit.authored_date)]),
          (() => {
            const pre = el("pre", { class: "commit-row-description", text: commit.message.split("\n").slice(1).join("\n").trim() });
            pre.hidden = true;
            return pre;
          })(),
        ]),
        el("div", { class: "commit-actions" }, [
          el("div", { class: "gl-button-group commit-sha-group" }, [el("a", { class: "gl-button btn-default btn-md commit-sha-button", href: hrefs.commit(project.path_with_namespace, commit.id), text: commit.short_id }), copyButton(commit.id, "Copy commit SHA")]),
          el("a", { class: "gl-button btn-default btn-md btn-icon", href: hrefs.tree(project.path_with_namespace, commit.id), title: "Browse Files", attrs: { "aria-label": "Browse Files" } }, [icon("folder-open")]),
        ]),
      ]),
    ]);
    group.append(li);
  }
  return wrap;
}

export async function renderCommits(main, route, project, token) {
  const branches = await loadBranches(project);
  if (stale(token)) return;
  const ref = route.rest.length ? route.rest.join("/") : project.default_branch ?? "main";
  const path = route.query.get("path") ?? "";
  const author = route.query.get("author") ?? "";
  const page = Math.max(1, Number(route.query.get("page")) || 1);
  setBreadcrumbs(projectCrumbs(project, [{ text: "Commits", href: hrefs.commits(project.path_with_namespace, ref) }]));
  setTitle(["Commits", ref, project.name_with_namespace]);
  const container = el("div", { class: "page-padded project-page" });
  const hrefFor = (params) => hrefs.commits(project.path_with_namespace, ref, { path, author, page: "", ...params });
  const authorButton = button(author ? `Author: ${author}` : "Author", { trailingIcon: "chevron-down" });
  const controls = el("div", { class: "tree-controls-row commits-controls" }, [
    el("div", { class: "tree-ref-container" }, [refSelector(project, branches, ref, (name) => hrefs.commits(project.path_with_namespace, name, { path, author })), path ? pathBreadcrumb(project, ref, path, { file: true }) : ""]),
    el("div", { class: "tree-controls" }, [authorButton, el("input", { class: "gl-form-input commits-search", attrs: { type: "search", placeholder: "Search by message", disabled: true, title: "Searching commit messages is not simulated by this Tool", "aria-label": "Search by message (not simulated)" } })]),
  ]);
  container.append(el("h1", { class: "page-heading", text: "Commits" }), controls);
  const list = el("div", {}, [skeletonRows(5)]);
  container.append(list);
  clear(main).append(container);
  const result = await call("commits.list", { id: project.id, ref_name: ref, ...(path ? { path } : {}), ...(author ? { author } : {}), page, per_page: PER_PAGE });
  if (stale(token)) return;
  const authors = [...new Map(result.items.map((commit) => [commit.author_name, commit])).values()];
  authorButton.addEventListener("click", () => openListbox(authorButton, { title: "Author", placeholder: "Search authors", options: [{ id: "", label: "Any author", selected: !author }, ...authors.map((commit) => ({ id: commit.author_name, label: commit.author_name, description: commit.author_email, selected: author === commit.author_name }))], onSelect: (value) => navigate(hrefFor({ author: value })), footer: el("span", { class: "gl-text-subtle gl-text-sm", text: "Authors of the commits on this page." }) }));
  clear(list);
  if (result.items.length === 0) {
    list.append(emptyState("No commits found", author || path ? "No commits match these filters." : "This branch has no commits."));
    return;
  }
  list.append(commitList(project, result.items));
  list.append(pagination(result.page, (target) => hrefFor({ page: target })) ?? "");
}

export async function renderCommit(main, route, project, token) {
  const sha = route.rest[0] ?? "";
  const commit = await call("commits.get", { id: project.id, commit_sha: sha, include: ["diff"], page: 1, per_page: 100 });
  if (stale(token)) return;
  const diffPages = [...(commit.diffs ?? [])];
  for (let next = commit.diffs_page?.next_page ?? null; next !== null && next <= 50; ) {
    const more = await call("commits.get", { id: project.id, commit_sha: commit.id, include: ["diff"], page: next, per_page: 100 });
    if (stale(token)) return;
    diffPages.push(...(more.diffs ?? []));
    next = more.diffs_page?.next_page ?? null;
  }
  commit.diffs = diffPages;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Commits", href: hrefs.commits(project.path_with_namespace, project.default_branch ?? "main") }, { text: commit.short_id, href: hrefs.commit(project.path_with_namespace, commit.id) }]));
  setTitle([commit.title, "Commits", project.name_with_namespace]);
  const container = el("div", { class: "page-padded project-page commit-page" });
  const header = el("div", { class: "page-content-header" }, [
    el("div", { class: "header-main-content" }, [
      el("strong", { text: "Commit " }),
      el("span", { class: "commit-sha", text: commit.short_id }),
      copyButton(commit.id, "Copy commit SHA"),
      el("span", { text: " authored " }),
      timeElement(commit.authored_date),
      el("span", { text: " by " }),
      commitAuthorAvatar(commit, 16),
      el("strong", { class: "commit-author-name", text: ` ${commit.author_name}` }),
    ]),
    el("div", { class: "header-action-buttons" }, [
      el("a", { class: "gl-button btn-default btn-md", href: hrefs.tree(project.path_with_namespace, commit.id), text: "Browse files" }),
      button("Options", { trailingIcon: "chevron-down", onClick: (event) => openMenu(event.currentTarget, [{ header: "Download" }, { label: "Plain Diff", onSelect: () => notSimulated("Plain diff download") }, { label: "Email Patches", onSelect: () => notSimulated("Email patches") }, "divider", { label: "Cherry-pick", onSelect: () => notSimulated("Cherry-pick") }, { label: "Revert", onSelect: () => notSimulated("Revert") }], { align: "end", width: 220 }) }),
    ]),
  ]);
  const message = commit.message.split("\n");
  const info = el("div", { class: "commit-box" }, [el("h3", { class: "commit-title", text: commit.title })]);
  if (message.slice(1).join("\n").trim()) info.append(el("pre", { class: "commit-description", text: message.slice(1).join("\n").trim() }));
  const well = el("div", { class: "info-well well-segment" }, [
    el("div", { class: "well-segment branch-info" }, [
      el("span", { class: "commit-info", text: plural(commit.parent_ids.length, "parent") + " " }),
      ...commit.parent_ids.flatMap((parent, index) => [index ? el("span", { text: " + " }) : "", el("a", { class: "commit-sha", href: hrefs.commit(project.path_with_namespace, parent), text: parent.slice(0, 8) })]),
    ]),
    el("div", { class: "well-segment pipeline-info" }, [icon("dotted-circle"), el("span", { class: "gl-text-subtle", text: " No pipeline for this commit (CI/CD is not simulated)" })]),
  ]);
  const diffs = commit.diffs ?? [];
  const totals = diffs.reduce((sum, file) => {
    const stats = diffStats(file.diff);
    return { additions: sum.additions + stats.additions, deletions: sum.deletions + stats.deletions };
  }, { additions: 0, deletions: 0 });
  const summary = el("div", { class: "files-changed-inner" }, [el("span", { text: "Showing " }), el("strong", { text: plural(diffs.length, "changed file") }), el("span", { text: " with " }), el("strong", { class: "gl-text-success", text: plural(commit.stats?.additions ?? totals.additions, "addition") }), el("span", { text: " and " }), el("strong", { class: "gl-text-danger", text: plural(commit.stats?.deletions ?? totals.deletions, "deletion") })]);
  container.append(header, info, well, el("div", { class: "files-changed" }, [summary]));
  for (const file of diffs) container.append(diffFile(file, { project, sha: commit.id }));
  container.append(el("div", { class: "commit-comments" }, [el("p", { class: "gl-text-subtle", text: "Comments on commits are not simulated by this Tool." })]));
  clear(main).append(container);
}

// ---------------------------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------------------------

const STALE_MS = 90 * 24 * 60 * 60 * 1000;

export async function renderBranches(main, route, project, token) {
  const tab = ["overview", "active", "stale", "all"].includes(route.rest[0]) ? route.rest[0] : "overview";
  const search = route.query.get("search") ?? "";
  const sort = ["name", "updated_desc", "updated_asc"].includes(route.query.get("sort")) ? route.query.get("sort") : "updated_desc";
  setBreadcrumbs(projectCrumbs(project, [{ text: "Branches", href: hrefs.branches(project.path_with_namespace) }]));
  setTitle(["Branches", project.name_with_namespace]);
  const container = el("div", { class: "page-padded project-page" });
  const hrefFor = (params) => hrefs.branches(project.path_with_namespace, params.tab ?? (tab === "overview" ? "" : tab), { search, sort: sort === "updated_desc" ? "" : sort, ...params, tab: undefined });
  const searchForm = el("form", { class: "branches-search" });
  const searchInput = el("input", { class: "gl-form-input", attrs: { type: "search", placeholder: "Filter by branch name", "aria-label": "Filter by branch name" } });
  searchInput.value = search;
  searchForm.append(el("div", { class: "gl-search-box" }, [icon("search", "gl-search-box-icon"), searchInput]));
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(hrefFor({ search: searchInput.value.trim() }));
  });
  const trailing = [searchForm];
  if (tab === "all") trailing.push(sortControlSimple(sort, (value) => navigate(hrefFor({ sort: value === "updated_desc" ? "" : value }))));
  trailing.push(button("New branch", { variant: "confirm", disabled: !canDevelop(project), onClick: () => navigate(hrefs.newBranch(project.path_with_namespace, project.default_branch)) }));
  container.append(stateTabs([{ id: "overview", label: "Overview", href: hrefFor({ tab: "" }) }, { id: "active", label: "Active", href: hrefFor({ tab: "active" }) }, { id: "stale", label: "Stale", href: hrefFor({ tab: "stale" }) }, { id: "all", label: "All", href: hrefFor({ tab: "all" }) }], tab, trailing));
  const host = el("div", {}, [skeletonRows(5)]);
  container.append(host);
  clear(main).append(container);
  const branches = await pageAll((page) => call("branches.list", { id: project.id, ...(search ? { search } : {}), ...page }));
  if (stale(token)) return;
  const now = worldNow() ?? Math.max(...branches.map((branch) => parseTimestamp(branch.commit.committed_date)));
  const isStale = (branch) => now - parseTimestamp(branch.commit.committed_date) > STALE_MS;
  const byUpdated = (a, b) => parseTimestamp(b.commit.committed_date) - parseTimestamp(a.commit.committed_date);
  clear(host);
  const section = (title, list, moreHref) => {
    const box = el("div", { class: "card branches-card" }, [el("div", { class: "card-header" }, [el("h3", { class: "card-title", text: title })])]);
    if (list.length === 0) box.append(el("div", { class: "nothing-here-block", text: search ? "No branches to show" : title === "Stale branches" ? "No stale branches to show" : "No active branches to show" }));
    else {
      const ul = el("ul", { class: "content-list all-branches" });
      for (const branch of list) ul.append(branchRow(project, branch));
      box.append(ul);
    }
    if (moreHref) box.append(el("div", { class: "card-footer" }, [el("a", { class: "gl-link", href: moreHref, text: `Show more ${title.toLowerCase()}` })]));
    return box;
  };
  if (tab === "overview") {
    const active = branches.filter((branch) => !isStale(branch)).sort(byUpdated);
    const staleList = branches.filter(isStale).sort(byUpdated);
    host.append(section("Active branches", active.slice(0, 5), active.length > 5 ? hrefFor({ tab: "active" }) : undefined), section("Stale branches", staleList.slice(0, 5), staleList.length > 5 ? hrefFor({ tab: "stale" }) : undefined));
    return;
  }
  let list = tab === "active" ? branches.filter((branch) => !isStale(branch)) : tab === "stale" ? branches.filter(isStale) : branches;
  list = [...list].sort(sort === "name" ? (a, b) => a.name.localeCompare(b.name) : sort === "updated_asc" ? (a, b) => -byUpdated(a, b) : byUpdated);
  host.append(section(tab === "active" ? "Active branches" : tab === "stale" ? "Stale branches" : "All branches", list));
}

function sortControlSimple(value, onChange) {
  const labels = { name: "Name", updated_desc: "Last updated", updated_asc: "Oldest updated" };
  const trigger = button(labels[value], { trailingIcon: "chevron-down" });
  trigger.addEventListener("click", () => openMenu(trigger, Object.entries(labels).map(([id, label]) => ({ label, checked: id === value, onSelect: () => onChange(id) })), { align: "end", width: 200 }));
  return trigger;
}

function branchRow(project, branch) {
  const path = project.path_with_namespace;
  const li = el("li", { class: "branch-item" });
  const info = el("div", { class: "branch-info" });
  const title = el("div", { class: "branch-title" }, [icon("branch", "branch-icon"), el("a", { class: "item-title ref-name", href: hrefs.tree(path, branch.name), text: branch.name }), copyButton(branch.name, "Copy branch name")]);
  if (branch.default) title.append(badge("default", "neutral", { size: "sm" }));
  if (branch.protected) title.append(badge("protected", "success", { size: "sm" }));
  if (branch.merged) title.append(badge("merged", "info", { size: "sm" }));
  const commit = el("div", { class: "block-truncated" }, [el("a", { class: "commit-sha", href: hrefs.commit(path, branch.commit.id), text: branch.commit.short_id }), el("span", { class: "gl-text-subtle", text: " · " }), el("a", { class: "commit-row-message", href: hrefs.commit(path, branch.commit.id), text: branch.commit.title }), el("span", { class: "gl-text-subtle", text: " · " }), timeElement(branch.commit.committed_date)]);
  info.append(title, commit);
  const controls = el("div", { class: "branch-controls" });
  if (!branch.default && project.merge_requests_enabled) controls.append(el("a", { class: "gl-button btn-default btn-md", href: hrefs.newMr(path, { source_branch: branch.name, target_branch: project.default_branch }), text: "New" }), el("span", { class: "sr-only", text: "merge request" }));
  if (!branch.default && project.merge_requests_enabled) controls.firstChild.textContent = "Merge request";
  controls.append(button("Compare", { onClick: () => notSimulated("Compare revisions") }), iconButton("ellipsis_v", "More actions", { variant: "default", onClick: (event) => openMenu(event.currentTarget, [{ label: "Copy branch name", onSelect: () => copyText(branch.name, "Branch name copied") }, { label: "Delete branch", danger: true, disabled: branch.default || branch.protected, onSelect: () => notSimulated("Deleting branches") }], { align: "end", width: 200 }) }));
  li.append(info, controls);
  return li;
}

export async function renderNewBranch(main, route, project, token) {
  const branches = await loadBranches(project);
  if (stale(token)) return;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Branches", href: hrefs.branches(project.path_with_namespace) }, { text: "New", href: location.hash }]));
  setTitle(["New branch", project.name_with_namespace]);
  let from = route.query.get("ref") && branches.some((branch) => branch.name === route.query.get("ref")) ? route.query.get("ref") : project.default_branch;
  const container = el("div", { class: "page-padded project-page narrow-form" });
  const errorHost = el("div");
  const name = el("input", { class: "gl-form-input", attrs: { type: "text", id: "branch_name", required: true, autocomplete: "off" } });
  const fromButton = button(from, { trailingIcon: "chevron-down", class: "ref-selector wide" });
  fromButton.addEventListener("click", () => openListbox(fromButton, { title: "Select Git revision", placeholder: "Search by Git revision", options: branches.map((branch) => ({ id: branch.name, label: branch.name, selected: branch.name === from })), onSelect: (value) => {
    from = value;
    fromButton.querySelector(".gl-button-text").textContent = value;
  } }));
  const form = el("form", { class: "new-branch-form" }, [
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Branch name", attrs: { for: "branch_name" } }), name]),
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Create from" }), fromButton, el("p", { class: "gl-form-text", text: "Existing branch name, tag, or commit SHA" })]),
  ]);
  const submit = button("Create branch", { variant: "confirm", type: "submit", disabled: !canDevelop(project) });
  form.append(el("div", { class: "form-actions" }, [submit, el("a", { class: "gl-button btn-default btn-md", href: hrefs.branches(project.path_with_namespace), text: "Cancel" })]));
  name.addEventListener("input", () => (state.editing = name.value.length > 0));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const branch = name.value.trim();
    if (!branch) return;
    void action(async () => {
      clear(errorHost);
      await call("branches.create", { id: project.id, branch, ref: from }, newKey());
      state.editing = false;
      toast(`Branch ${branch} was created`);
      navigate(hrefs.tree(project.path_with_namespace, branch));
    }, { onError: (error) => clear(errorHost).append(alert(describe(error), "danger")) });
  });
  if (!canDevelop(project)) container.append(alert("You need at least the Developer role to create branches in this project.", "warning"));
  container.append(el("h1", { class: "page-heading", text: "New branch" }), errorHost, form);
  clear(main).append(container);
  name.focus();
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export async function renderLabels(main, route, project, token) {
  const search = route.query.get("search") ?? "";
  const page = Math.max(1, Number(route.query.get("page")) || 1);
  setBreadcrumbs(projectCrumbs(project, [{ text: "Labels", href: hrefs.labels(project.path_with_namespace) }]));
  setTitle(["Labels", project.name_with_namespace]);
  const container = el("div", { class: "page-padded project-page labels-page" });
  const hrefFor = (params) => withQuery(hrefs.labels(project.path_with_namespace), { search, ...params });
  const form = el("form", { class: "labels-search" });
  const input = el("input", { class: "gl-form-input", attrs: { type: "search", placeholder: "Filter", "aria-label": "Filter labels" } });
  input.value = search;
  form.append(el("div", { class: "gl-search-box" }, [icon("search", "gl-search-box-icon"), input]));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(hrefFor({ search: input.value.trim(), page: "" }));
  });
  container.append(el("div", { class: "page-heading-row" }, [el("h1", { class: "page-heading", text: "Labels" }), el("div", { class: "page-heading-actions" }, [form, button("Subscribe", { onClick: () => notSimulated("Label subscriptions") }), button("New label", { variant: "confirm", onClick: () => notSimulated("Creating labels from the label page (labels are created when applied)") })])]));
  container.append(el("p", { class: "gl-text-subtle labels-intro", text: "Labels can be applied to issues and merge requests." }));
  const host = el("div", {}, [skeletonRows(4)]);
  container.append(host);
  clear(main).append(container);
  const result = await call("labels.list", { id: project.id, with_counts: true, ...(search ? { search } : {}), page, per_page: PER_PAGE });
  if (stale(token)) return;
  clear(host);
  if (result.items.length === 0) {
    host.append(emptyState(search ? "No labels with such name or description" : "Use labels to divide issues and merge requests into different categories", search ? "" : "Labels are created when you apply a new one to an issue."));
    return;
  }
  const prioritized = result.items.filter((label) => label.priority !== null);
  const other = result.items.filter((label) => label.priority === null);
  const list = (title, items) => {
    const box = el("div", { class: "labels-container" }, [el("h5", { class: "labels-heading", text: title })]);
    const ul = el("ul", { class: "manage-labels-list content-list" });
    for (const label of items) {
      const path = project.path_with_namespace;
      ul.append(
        el("li", { class: "label-list-item" }, [
          el("div", { class: "label-name" }, [labelPill(label)]),
          el("div", { class: "label-description" }, [el("span", { class: label.description ? "" : "gl-text-subtle", text: label.description ?? "" })]),
          el("div", { class: "label-links" }, [
            el("a", { class: "gl-link", href: hrefs.issues(path, { label_name: label.name }), text: `${label.open_issues_count ?? 0} Issues` }),
            el("span", { class: "gl-text-subtle", text: " · " }),
            el("a", { class: "gl-link", href: hrefs.mrs(path, { label_name: label.name }), text: `${label.open_merge_requests_count ?? 0} Merge requests` }),
          ]),
          el("div", { class: "label-actions" }, [iconButton("star-o", label.priority !== null ? "Remove priority" : "Prioritize label", { onClick: () => notSimulated("Label priority") }), iconButton("ellipsis_v", "Label actions", { onClick: (event) => openMenu(event.currentTarget, [{ label: "Edit", onSelect: () => notSimulated("Editing labels") }, { label: "Promote to group label", onSelect: () => notSimulated("Group labels") }, { label: "Delete", danger: true, onSelect: () => notSimulated("Deleting labels") }], { align: "end", width: 200 }) })]),
        ]),
      );
    }
    box.append(ul);
    return box;
  };
  if (prioritized.length) host.append(list("Prioritized labels", prioritized));
  host.append(list(prioritized.length ? "Other labels" : "Labels", other));
  host.append(pagination(result.page, (target) => hrefFor({ page: target })) ?? "");
}
