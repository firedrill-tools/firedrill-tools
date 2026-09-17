// GitLab Tool browser app: boot, hash router, super-sidebar chrome, search modal and keyboard shortcuts.
// Every control calls this Tool's operations through /_firedrill/client.js; screens re-read records after
// writes and whenever the world revision moves. Nothing here reaches a real GitLab instance.
import { hydrateIcons } from "./icons.js";
import { $, ToolError, avatar, call, clear, closeMenus, describe, el, getContext, icon, isPending, openMenu, openModal, projectAvatar, setWorldNow, watchWorld } from "./ui.js";
import { errorPage, hrefs, loadCounters, loadProject, loadingBlock, navigate, notSimulated, parseRoute, renderCounters, renderSidebar, setBreadcrumbs, setTitle, state } from "./shell.js";
import { renderBlob, renderBranches, renderCommit, renderCommits, renderEditFile, renderLabels, renderNamespace, renderNewBranch, renderOverview, renderProjects, renderTree } from "./projects.js";
import { renderDashboardIssues, renderIssue, renderIssues, renderNewIssue } from "./issues.js";
import { renderDashboardMrs, renderMr, renderMrs, renderNewMr } from "./mrs.js";

const main = () => $("#content-body");

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

async function renderRoute() {
  closeMenus();
  state.editing = false;
  const token = (state.navigation += 1);
  const route = parseRoute();
  const host = main();
  // Refresh the revision first so per-revision caches (branches, labels, project) see writes made a moment ago.
  state.context = (await getContext().catch(() => undefined)) ?? state.context;
  if (token !== state.navigation) return;
  if (!state.user) {
    clear(host).append(state.authError ? errorPage(state.authError, { what: "instance" }) : loadingBlock());
    setBreadcrumbs([{ text: "GitLab", href: "#/" }]);
    renderSidebar({ kind: "dashboard", page: "" });
    return;
  }
  try {
    if (route.kind === "dashboard") {
      state.project = undefined;
      renderSidebar(route);
      if (route.page === "projects") await renderProjects(host, route, token);
      else if (route.page === "issues") await renderDashboardIssues(host, route, token);
      else if (route.page === "merge_requests") await renderDashboardMrs(host, route, token);
      else renderUnsupported(host, route.page);
      return;
    }
    if (route.kind === "namespace") {
      state.project = undefined;
      renderSidebar({ kind: "dashboard", page: "" });
      await renderNamespace(host, route, token);
      return;
    }
    if (state.project?.path_with_namespace.toLowerCase() !== route.projectPath.toLowerCase()) clear(host).append(loadingBlock());
    const project = await loadProject(route.projectPath);
    if (token !== state.navigation) return;
    renderSidebar(route);
    const [first, second] = route.rest;
    switch (route.page) {
      case "overview":
        return await renderOverview(host, route, project, token);
      case "tree":
        return await renderTree(host, route, project, token);
      case "blob":
        return await renderBlob(host, route, project, token);
      case "edit":
        return await renderEditFile(host, route, project, token, { mode: "edit" });
      case "new":
        return await renderEditFile(host, route, project, token, { mode: "new" });
      case "commits":
        return await renderCommits(host, route, project, token);
      case "commit":
        return await renderCommit(host, route, project, token);
      case "branches":
        return first === "new" ? await renderNewBranch(host, route, project, token) : await renderBranches(host, route, project, token);
      case "labels":
        return await renderLabels(host, route, project, token);
      case "issues":
        if (first === undefined) return await renderIssues(host, route, project, token);
        if (first === "new") return await renderNewIssue(host, route, project, token);
        if (/^\d+$/.test(first)) return await renderIssue(host, route, project, Number(first), token);
        break;
      case "merge_requests":
        if (first === undefined) return await renderMrs(host, route, project, token);
        if (first === "new") return await renderNewMr(host, route, project, token);
        if (/^\d+$/.test(first)) return await renderMr(host, route, project, Number(first), second ?? "overview", token);
        break;
      default:
        break;
    }
    renderUnsupported(host, route.page);
  } catch (error) {
    if (token !== state.navigation) return;
    console.error(error);
    renderSidebar(route.kind === "project" && state.project ? route : { kind: "dashboard", page: "" });
    clear(host).append(errorPage(error));
    if (!(error instanceof ToolError)) setBreadcrumbs([{ text: "GitLab", href: "#/" }]);
  }
}

function renderUnsupported(host, page) {
  setTitle(["Not simulated"]);
  clear(host).append(
    el("div", { class: "error-page" }, [
      el("h1", { class: "error-code", text: "404" }),
      el("h2", { class: "error-title", text: "Page not found" }),
      el("p", { text: `The “${page}” page is not simulated by this Tool.` }),
      el("div", { class: "error-actions" }, [el("a", { class: "gl-button btn-confirm btn-md", href: "#/", text: "Go to homepage" })]),
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------------------------

function renderUser() {
  const target = $("#user-avatar");
  const user = state.user;
  const replacement = user ? avatar(user, 24) : el("span", { class: "gl-avatar gl-avatar-s24 gl-avatar-circle", text: "?" });
  replacement.id = "user-avatar";
  target.replaceWith(replacement);
}

function currentProject() {
  const route = parseRoute();
  return route.kind === "project" && state.project?.path_with_namespace.toLowerCase() === route.projectPath.toLowerCase() ? state.project : undefined;
}

function wireChrome() {
  $("#create-new").addEventListener("click", (event) => {
    const project = currentProject();
    const level = project?.permissions?.project_access?.access_level ?? 0;
    const items = [];
    if (project) {
      items.push(
        { header: "In this project" },
        { label: "New issue", disabled: project.archived || !project.issues_enabled, onSelect: () => navigate(hrefs.newIssue(project.path_with_namespace)) },
        { label: "New merge request", disabled: project.archived || level < 30, onSelect: () => navigate(hrefs.newMr(project.path_with_namespace)) },
        { label: "New snippet", onSelect: () => notSimulated("Snippets") },
        { label: "Invite members", onSelect: () => notSimulated("Invite members") },
        "divider",
      );
    }
    items.push({ header: "In GitLab" }, { label: "New project/repository", onSelect: () => notSimulated("New project") }, { label: "New group", onSelect: () => notSimulated("New group") }, { label: "New snippet", onSelect: () => notSimulated("Snippets") });
    openMenu(event.currentTarget, items, { width: 240 });
  });
  $("#user-menu").addEventListener("click", (event) => {
    const user = state.user;
    openMenu(
      event.currentTarget,
      [
        { header: user ? `${user.name} @${user.username}` : `Actor ${state.context?.actorId ?? ""}` },
        { label: "Set status", icon: "smiley", onSelect: () => notSimulated("User status") },
        "divider",
        { label: "Edit profile", onSelect: () => notSimulated("Edit profile") },
        { label: "Preferences", onSelect: () => notSimulated("Preferences") },
        { label: `Firedrill actor: ${state.context?.actorId ?? "unknown"}`, description: "The identity is chosen when Firedrill serves the app", disabled: true },
        "divider",
        { label: "Sign out", onSelect: () => notSimulated("Sign out") },
      ],
      { width: 260 },
    );
  });
  $("#duo-chat").addEventListener("click", () => notSimulated("GitLab Duo Chat"));
  $("#counter-issues").addEventListener("click", () => navigate(hrefs.dashboard("issues", { assignee: state.user?.username })));
  $("#counter-mrs").addEventListener("click", (event) => {
    const counts = state.counts;
    openMenu(
      event.currentTarget,
      [
        { header: "Merge requests" },
        { label: "Assigned", count: counts?.assignedMrs ?? "", onSelect: () => navigate(hrefs.dashboard("merge_requests", { assignee: state.user?.username })) },
        { label: "Review requests", count: counts?.reviews ?? "", onSelect: () => navigate(hrefs.dashboard("merge_requests", { reviewer: state.user?.username })) },
      ],
      { width: 220 },
    );
  });
  $("#counter-todos").addEventListener("click", () => notSimulated("To-Do List"));
  $("#search-button").addEventListener("click", openSearch);
  $("#help-button").addEventListener("click", (event) => {
    openMenu(
      event.currentTarget,
      [
        { label: "Help", onSelect: () => notSimulated("Help") },
        { label: "Support", onSelect: () => notSimulated("Support") },
        { label: "GitLab documentation", onSelect: () => notSimulated("GitLab documentation") },
        { label: "Compare GitLab plans", onSelect: () => notSimulated("Compare GitLab plans") },
        { label: "GitLab community forum", onSelect: () => notSimulated("Community forum") },
        "divider",
        { label: "Contribute to GitLab", onSelect: () => notSimulated("Contribute to GitLab") },
        { label: "Provide feedback", onSelect: () => notSimulated("Feedback") },
        "divider",
        { label: "Keyboard shortcuts", description: "?", onSelect: showShortcuts },
        { label: "What's new", onSelect: () => notSimulated("What's new") },
      ],
      { width: 260 },
    );
  });
  const collapse = (collapsed) => {
    document.body.classList.toggle("page-with-super-sidebar-collapsed", collapsed);
    $("#sidebar-overlay").hidden = collapsed || window.innerWidth >= 1200;
    try {
      localStorage.setItem("gitlab-tool:sidebar-collapsed", collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  };
  $("#sidebar-collapse").addEventListener("click", () => collapse(true));
  $("#sidebar-expand").addEventListener("click", () => collapse(false));
  $("#sidebar-overlay").addEventListener("click", () => collapse(true));
  let initial = window.innerWidth < 1200;
  try {
    const stored = localStorage.getItem("gitlab-tool:sidebar-collapsed");
    if (stored !== null && window.innerWidth >= 1200) initial = stored === "1";
  } catch {
    /* ignore */
  }
  collapse(initial);
  // Like GitLab, the sidebar turns into an overlay below 1200 px: collapse when the window crosses the breakpoint.
  const narrow = window.matchMedia("(max-width: 1199px)");
  narrow.addEventListener("change", (event) => collapse(event.matches));

  let chord = false;
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
    if (typing || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
    if (event.key === "/" || event.key === "s") {
      event.preventDefault();
      openSearch();
      return;
    }
    if (event.key === "?") {
      event.preventDefault();
      showShortcuts();
      return;
    }
    if (event.key === "g") {
      chord = true;
      setTimeout(() => (chord = false), 1500);
      return;
    }
    if (chord) {
      chord = false;
      const project = currentProject();
      if (event.key === "p" && !project) return navigate("#/");
      if (!project) return;
      const path = project.path_with_namespace;
      if (event.key === "i") navigate(hrefs.issues(path));
      else if (event.key === "m") navigate(hrefs.mrs(path));
      else if (event.key === "p") navigate(hrefs.project(path));
      else if (event.key === "f") navigate(hrefs.tree(path, project.default_branch ?? "main"));
      else if (event.key === "c") navigate(hrefs.commits(path, project.default_branch ?? "main"));
      else if (event.key === "l") navigate(hrefs.labels(path));
    }
  });
}

function showShortcuts() {
  closeMenus();
  void openModal(
    "Keyboard shortcuts",
    (body, close, footer) => {
      const rows = [
        ["/ or s", "Search or go to…"],
        ["?", "Show keyboard shortcuts"],
        ["g then p", "Go to the project overview (or Your work)"],
        ["g then f", "Go to repository files"],
        ["g then c", "Go to commits"],
        ["g then i", "Go to issues"],
        ["g then m", "Go to merge requests"],
        ["g then l", "Go to labels"],
        ["Esc", "Close a dropdown or dialog"],
      ];
      const table = el("table", { class: "shortcut-table" });
      for (const [keys, text] of rows) table.append(el("tr", {}, [el("td", {}, keys.split(" ").map((part) => (["then", "or"].includes(part) ? el("span", { class: "gl-text-subtle", text: ` ${part} ` }) : el("kbd", { text: part })))), el("td", { text })]));
      body.append(table);
      footer.append(el("button", { class: "gl-button btn-default btn-md", text: "Close", attrs: { type: "button" } }));
      footer.lastChild.addEventListener("click", () => close());
    },
    { size: "md" },
  );
}

// ---------------------------------------------------------------------------------------------
// Search or go to… (command palette over real projects, issues and merge requests)
// ---------------------------------------------------------------------------------------------

function openSearch() {
  closeMenus();
  const project = currentProject();
  void openModal(
    "Search or go to…",
    (body, close) => {
      const dialog = $("#form-modal");
      dialog.classList.add("search-modal");
      const box = el("div", { class: "gl-search-box command-palette-input" }, [icon("search", "gl-search-box-icon")]);
      const input = el("input", { class: "gl-search-box-input", attrs: { type: "search", placeholder: "Search GitLab", "aria-label": "Search GitLab", autocomplete: "off" } });
      box.append(input);
      const results = el("div", { class: "command-palette-results", attrs: { role: "listbox" } });
      const hint = el("div", { class: "command-palette-footer" }, [el("span", { text: "Type " }), el("kbd", { text: "#" }), el("span", { text: " to search issues in this project, " }), el("kbd", { text: "!" }), el("span", { text: " for merge requests." })]);
      body.append(box, results, hint);
      let ticket = 0;
      const group = (title, entries) => {
        if (entries.length === 0) return;
        results.append(el("div", { class: "command-palette-group", text: title }));
        for (const entry of entries) {
          const a = el("a", { class: "command-palette-item", href: entry.href, attrs: { role: "option" } });
          a.append(entry.leading ?? icon(entry.icon ?? "arrow-right"), el("span", { class: "command-palette-item-text" }, [el("span", { class: "command-palette-item-title", text: entry.title }), entry.subtitle ? el("span", { class: "command-palette-item-subtitle", text: entry.subtitle }) : ""]));
          a.addEventListener("click", () => close());
          results.append(a);
        }
      };
      const update = async () => {
        const mine = (ticket += 1);
        const raw = input.value.trim();
        clear(results);
        if (!raw) {
          if (project) {
            const path = project.path_with_namespace;
            group("Places", [
              { title: "Issues", subtitle: project.name_with_namespace, icon: "issues", href: hrefs.issues(path) },
              { title: "Merge requests", subtitle: project.name_with_namespace, icon: "merge-request", href: hrefs.mrs(path) },
              { title: "Repository", subtitle: project.name_with_namespace, icon: "doc-text", href: hrefs.tree(path, project.default_branch ?? "main") },
              { title: "Branches", subtitle: project.name_with_namespace, icon: "branch", href: hrefs.branches(path) },
              { title: "Commits", subtitle: project.name_with_namespace, icon: "commit", href: hrefs.commits(path, project.default_branch ?? "main") },
              { title: "Labels", subtitle: project.name_with_namespace, icon: "label", href: hrefs.labels(path) },
            ]);
          }
          group("Your work", [
            { title: "Projects", icon: "project", href: "#/" },
            { title: "Issues assigned to you", icon: "issues", href: hrefs.dashboard("issues", { assignee: state.user?.username }) },
            { title: "Merge requests assigned to you", icon: "merge-request", href: hrefs.dashboard("merge_requests", { assignee: state.user?.username }) },
          ]);
          return;
        }
        results.append(loadingBlock("Searching"));
        try {
          const lookups = [];
          const scope = raw[0];
          const term = scope === "#" || scope === "!" ? raw.slice(1).trim() : raw;
          if (scope !== "#" && scope !== "!") lookups.push(call("projects.list", { search: term.slice(0, 255), per_page: 5 }).then((result) => ({ kind: "projects", items: result.items })));
          if (project && scope !== "!") lookups.push(call("issues.list", { id: project.id, state: "all", ...(/^\d+$/.test(term) ? { iids: [Number(term)] } : term ? { search: term.slice(0, 255) } : {}), per_page: 5 }).then((result) => ({ kind: "issues", items: result.items })));
          if (project && scope !== "#") {
            // A number is a direct !iid lookup (merge-requests.list has no iids filter; one page would miss older requests).
            const iid = /^\d{1,9}$/.test(term) ? Number(term) : 0;
            if (iid >= 1) lookups.push(call("merge-requests.get", { id: project.id, merge_request_iid: iid }).then((mr) => ({ kind: "mrs", items: [mr] }), (error) => (error instanceof ToolError && error.is("NOT_FOUND") ? { kind: "mrs", items: [] } : Promise.reject(error))));
            else if (!/^\d+$/.test(term)) lookups.push(call("merge-requests.list", { id: project.id, state: "all", ...(term ? { search: term.slice(0, 255) } : {}), per_page: 5 }).then((result) => ({ kind: "mrs", items: result.items })));
          }
          const found = await Promise.all(lookups);
          if (mine !== ticket) return;
          clear(results);
          for (const { kind, items } of found) {
            if (kind === "projects") group("Projects", items.map((item) => ({ title: item.name, subtitle: item.name_with_namespace, leading: projectAvatar(item, 16), href: hrefs.project(item.path_with_namespace) })));
            if (kind === "issues") group("Issues", items.map((item) => ({ title: item.title, subtitle: `#${item.iid} · ${item.state === "closed" ? "Closed" : "Open"}`, icon: item.state === "closed" ? "issue-closed" : "issues", href: hrefs.issue(project.path_with_namespace, item.iid) })));
            if (kind === "mrs") group("Merge requests", items.map((item) => ({ title: item.title, subtitle: `!${item.iid} · ${item.state}`, icon: "merge-request", href: hrefs.mr(project.path_with_namespace, item.iid) })));
          }
          if (!results.childNodes.length) results.append(el("div", { class: "command-palette-empty", text: "No results found" }));
        } catch (error) {
          if (mine !== ticket) return;
          clear(results).append(el("div", { class: "command-palette-empty", text: describe(error) }));
        }
      };
      let timer;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => void update(), 200);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          const first = results.querySelector(".command-palette-item");
          if (first) {
            event.preventDefault();
            location.hash = first.getAttribute("href");
            close();
          }
        }
      });
      void update();
      dialog.addEventListener("close", () => dialog.classList.remove("search-modal"), { once: true });
    },
    { size: "md" },
  );
  $("#form-modal-footer").hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function loadUser() {
  try {
    const user = await call("users.get", { me: true });
    state.user = user;
    state.authError = undefined;
    setWorldNow(user.server_time);
  } catch (error) {
    state.user = undefined;
    state.authError = error;
  }
  renderUser();
}

async function refreshCounters() {
  try {
    await loadCounters();
    renderCounters();
    const route = parseRoute();
    if (!state.editing && document.querySelector(".super-sidebar-nav .nav-item-count") !== null) renderSidebar(route.kind === "project" && state.project ? route : route.kind === "dashboard" ? route : { kind: "dashboard", page: "" });
  } catch {
    /* counters are decorative; failures are shown on the pages themselves */
  }
}

async function start() {
  hydrateIcons();
  wireChrome();
  state.context = await getContext().catch(() => undefined);
  window.addEventListener("hashchange", () => void renderRoute());
  await watchWorld(
    async () => {
      await loadUser();
      await renderRoute();
      void refreshCounters();
    },
    () => !state.editing && !isPending() && !document.querySelector("dialog[open]") && !document.querySelector(".gl-dropdown-panel"),
    (context) => {
      state.context = context;
    },
  );
}

void start();
