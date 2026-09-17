// GitHub Tool browser app: hash router, global header, dashboard. Every control calls the Tool's own
// operations through /_firedrill/client.js; records are re-read after each write and whenever the world
// revision moves. Nothing on this page is authoritative and nothing reaches github.com.
import { hydrateIcons } from "./icons.js";
import { notSimulated, wireStaticChrome } from "./chrome.js";
import { $, ToolError, avatar, button, call, clear, closeMenus, describe, el, flash, icon, isPending, labelChip, link, openMenu, pageAll, setWorldNow, timeElement, watchWorld } from "./ui.js";
import { blankslate, container, errorBlock, hrefs, issueRow, loadingBlock, navigate, parseHash, setCrumbs, setRepoNav, setTitle, state } from "./shared.js";
import { renderBlob, renderBranches, renderCode, renderCommit, renderCommits, renderCompare, renderEdit } from "./code.js";
import { renderIssue, renderIssues, renderLabels, renderNewIssue, renderSearch } from "./issues.js";
import { renderPull, renderPulls } from "./pulls.js";

// ---------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------

function renderUserChip() {
  const host = $("#user-avatar");
  const login = state.user?.login ?? state.context?.actorId ?? "?";
  host.textContent = login.charAt(0).toUpperCase();
  host.style.background = avatar(login).style.background;
  host.title = login;
  $("#user-menu").setAttribute("aria-label", `Open user navigation menu (${login})`);
}

function currentRepoFromRoute() {
  const { parts } = parseHash();
  if (parts.length >= 2 && !["search"].includes(parts[0])) return { owner: parts[0], repo: parts[1] };
  return undefined;
}

function wireHeader() {
  $("#global-search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const q = $("#global-search").value.trim();
    if (q) navigate(hrefs.search(q));
  });
  $("#create-menu").addEventListener("click", (event) => {
    const repo = currentRepoFromRoute();
    const full = repo ? `${repo.owner}/${repo.repo}` : undefined;
    const inRepo = full !== undefined && state.repo?.full_name.toLowerCase() === full.toLowerCase();
    const writable = inRepo && state.repo.permissions?.push && !state.repo.archived;
    openMenu(
      event.currentTarget,
      [
        { header: inRepo ? `In ${state.repo.full_name}` : "Open a repository first" },
        { label: "New issue", icon: "issue-opened", disabled: !inRepo || state.repo?.archived, onSelect: () => navigate(hrefs.newIssue(state.repo.full_name)) },
        { label: "New pull request", icon: "git-pull-request", disabled: !writable, onSelect: () => navigate(hrefs.compare(state.repo.full_name)) },
        { label: "New branch", icon: "git-branch", disabled: !writable, onSelect: () => navigate(`${hrefs.branches(state.repo.full_name)}?new=1`) },
        "divider",
        { label: "New repository", icon: "repo", disabled: true, description: "Not part of this Tool" },
      ],
      { align: "end", width: 260 },
    );
  });
  $("#user-menu").addEventListener("click", (event) => {
    const login = state.user?.login;
    openMenu(
      event.currentTarget,
      [
        { header: login ? `Signed in as ${login}` : `Actor ${state.context?.actorId ?? ""}` },
        { label: "Your profile", icon: "person", disabled: !login, onSelect: () => navigate(hrefs.user(login)) },
        { label: "Your repositories", icon: "repo", onSelect: () => navigate("#/") },
        { label: "Your issues", icon: "issue-opened", onSelect: () => navigate("#/issues") },
        { label: "Your pull requests", icon: "git-pull-request", onSelect: () => navigate("#/pulls") },
        "divider",
        { label: `Actor: ${state.context?.actorId ?? "?"}`, description: "Identity is chosen in Firedrill, not here", disabled: true },
      ],
      { align: "end", width: 280 },
    );
  });
  $("#header-notifications").addEventListener("click", (event) => {
    void event;
    notSimulated("Notifications");
  });
  $("#global-menu").addEventListener("click", (event) => {
    const repos = state.repos?.repositories ?? [];
    openMenu(
      event.currentTarget,
      [
        { label: "Home", icon: "mark-github", onSelect: () => navigate("#/") },
        { label: "Issues", icon: "issue-opened", onSelect: () => navigate("#/issues") },
        { label: "Pull requests", icon: "git-pull-request", onSelect: () => navigate("#/pulls") },
        "divider",
        { header: "Repositories" },
        ...repos.slice(0, 8).map((repo) => ({ label: repo.full_name, icon: repo.private ? "repo-locked" : "repo", onSelect: () => navigate(hrefs.repo(repo.full_name)) })),
      ],
      { width: 300 },
    );
  });
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (typing) return;
    if (event.key === "/") {
      event.preventDefault();
      $("#global-search").focus();
      return;
    }
    if (event.key === "g") {
      pendingChord = true;
      setTimeout(() => (pendingChord = false), 1500);
      return;
    }
    if (pendingChord) {
      pendingChord = false;
      const full = state.repo?.full_name;
      if (!full) return;
      if (event.key === "c") navigate(hrefs.repo(full));
      if (event.key === "i") navigate(hrefs.issues(full));
      if (event.key === "p") navigate(hrefs.pulls(full));
      if (event.key === "b") navigate(hrefs.branches(full));
    }
  });
}
let pendingChord = false;

// ---------------------------------------------------------------------------------------------
// Dashboard (`#/`)
// ---------------------------------------------------------------------------------------------

async function renderDashboard(main) {
  setCrumbs([{ text: "Dashboard", href: "#/", current: true }]);
  setRepoNav(undefined);
  setTitle("");
  const page = el("div", { class: "dashboard" });
  const sidebar = el("aside", { class: "dashboard-sidebar", attrs: { "aria-label": "Top repositories" } });
  const head = el("div", { class: "dashboard-sidebar-head" }, [el("h2", { text: "Top repositories" }), button("New", { variant: "primary", size: "sm", icon: "repo", disabled: true, title: "Repository creation is not part of this Tool" })]);
  const filter = el("input", { class: "form-control", attrs: { type: "text", placeholder: "Find a repository…", "aria-label": "Find a repository" } });
  const list = el("ul", { class: "repo-list" });
  sidebar.append(head, filter, list);
  const feed = el("section", { class: "dashboard-feed", attrs: { "aria-label": "Home" } });
  feed.append(el("h1", { text: "Home" }));
  const feedBody = el("div", {}, [loadingBlock()]);
  feed.append(feedBody);
  page.append(sidebar, feed);
  main.append(page);

  const renderRepos = () => {
    clear(list);
    const term = filter.value.trim().toLowerCase();
    const repos = (state.repos?.repositories ?? []).filter((repo) => !term || repo.full_name.toLowerCase().includes(term));
    if (repos.length === 0) list.append(el("li", { class: "text-muted", text: term ? "No repositories matched." : "You don't have any repositories yet." }));
    for (const repo of repos) {
      const li = el("li");
      li.append(avatar(repo.owner, 16));
      const a = el("a", { href: hrefs.repo(repo.full_name), title: repo.full_name });
      a.append(el("span", { text: `${repo.owner.login}/` }), el("span", { class: "repo-list-name", text: repo.name }));
      li.append(a);
      if (repo.private) li.append(icon("lock", "text-muted"));
      list.append(li);
    }
  };
  filter.addEventListener("input", renderRepos);

  try {
    state.repos = await pageAll((page) => call("repos.list-for-authenticated-user", { sort: "pushed", ...page }), "repositories");
    renderRepos();
  } catch (error) {
    clear(list).append(el("li", { class: "text-muted", text: describe(error) }));
  }
  try {
    const recent = await call("issues.search", { query: "is:open", sort: "updated", order: "desc", perPage: 15 });
    clear(feedBody);
    if (recent.items.length === 0) {
      feedBody.append(blankslate("pulse", "Nothing to show yet", "Open issues and pull requests in your repositories appear here as they change."));
      return;
    }
    for (const item of recent.items) {
      const full = item.repository_url.split("/repos/")[1];
      const kind = item.pull_request ? "pr" : "issue";
      const entry = el("article", { class: "feed-item" });
      entry.append(avatar(item.user, 32));
      const body = el("div", { class: "feed-item-body" });
      const headline = el("div", { class: "feed-item-head" });
      headline.append(link(item.user.login, hrefs.user(item.user.login)), ` ${item.created_at === item.updated_at ? "opened" : "updated"} ${kind === "pr" ? "a pull request" : "an issue"} in `, link(full, hrefs.repo(full)), " · ", timeElement(item.updated_at));
      body.append(headline);
      const card = el("div", { class: "feed-item-card" });
      card.append(kind === "pr" ? icon(item.draft ? "git-pull-request-draft" : "git-pull-request") : icon("issue-opened"));
      card.append(el("a", { text: `${item.title} #${item.number}`, href: kind === "pr" ? hrefs.pull(full, item.number) : hrefs.issue(full, item.number) }));
      if (item.labels.length > 0) {
        const labels = el("span", { class: "feed-labels" });
        for (const label of item.labels.slice(0, 3)) labels.append(labelChip(label));
        card.append(labels);
      }
      body.append(card);
      entry.append(body);
      feedBody.append(entry);
    }
  } catch (error) {
    clear(feedBody).append(errorBlock(error));
  }
}

// ---------------------------------------------------------------------------------------------
// User profile (`#/{login}`): identity card + their open issues and pull requests (issues.search author:)
// ---------------------------------------------------------------------------------------------

async function renderUserPage(main, login) {
  setCrumbs([{ text: login, href: hrefs.user(login), current: true }]);
  setRepoNav(undefined);
  setTitle(login);
  const wrap = container("container-lg");
  const card = el("div", { class: "page-header" });
  const identity = el("div", { class: "repohead-title" });
  identity.append(avatar(login, 40), el("span", { class: "repo-name", text: login }));
  if (state.user?.login === login && state.user.name) identity.append(el("span", { class: "text-muted", text: state.user.name }));
  card.append(identity);
  wrap.append(card);
  const box = el("div", { class: "Box" });
  box.append(el("div", { class: "Box-header" }, [el("h2", { class: "Box-title", text: "Open issues and pull requests" })]));
  const body = el("div", {}, [loadingBlock()]);
  box.append(body);
  wrap.append(box);
  main.append(wrap);
  try {
    const result = await call("issues.search", { query: `is:open author:${login}`, sort: "updated", order: "desc", perPage: 30 });
    clear(body);
    if (result.items.length === 0) body.append(blankslate("issue-opened", "Nothing open", `${login} has no open issues or pull requests you can see.`));
    for (const item of result.items) {
      const full = item.repository_url.split("/repos/")[1];
      body.append(issueRow(item, full, item.pull_request ? "pr" : "issue", { showRepo: true }));
    }
  } catch (error) {
    clear(body).append(errorBlock(error));
  }
}

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

async function render() {
  closeMenus();
  for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
  const navigation = ++state.navigation;
  state.editing = false;
  const main = $("#main");
  clear(main);
  $("#initial-loading")?.remove();
  const { parts, query } = parseHash();
  const fresh = () => state.navigation === navigation;
  if (parts[0] !== "search") $("#global-search").value = "";
  window.scrollTo(0, 0);
  try {
    if (state.authError) {
      renderSignedOut(main, state.authError);
      return;
    }
    if (parts.length === 0) return await renderDashboard(main);
    if (parts[0] === "search") return await renderSearch(main, query, fresh);
    if (parts[0] === "issues" && parts.length === 1) return await renderSearch(main, new URLSearchParams({ q: "is:open is:issue author:@me", scope: "issues" }), fresh);
    if (parts[0] === "pulls" && parts.length === 1) return await renderSearch(main, new URLSearchParams({ q: "is:open is:pr author:@me", scope: "pulls" }), fresh);
    if (parts.length === 1) return await renderUserPage(main, parts[0]);
    const [owner, repo, section, ...rest] = parts;
    const args = { owner, repo, rest, query, fresh, main };
    switch (section) {
      case undefined:
        return await renderCode(args);
      case "tree":
        return await renderCode(args);
      case "blob":
        return await renderBlob(args);
      case "edit":
        return await renderEdit(args);
      case "new":
        return await renderEdit({ ...args, create: true });
      case "commits":
        return await renderCommits(args);
      case "commit":
        return await renderCommit(args);
      case "branches":
        return await renderBranches(args);
      case "issues":
        if (rest[0] === "new") return await renderNewIssue(args);
        if (rest[0] !== undefined) return await renderIssue({ ...args, number: Number(rest[0]) });
        return await renderIssues(args);
      case "labels":
        return await renderLabels(args);
      case "pulls":
        return await renderPulls(args);
      case "pull":
        return await renderPull({ ...args, number: Number(rest[0]), tab: rest[1] ?? "conversation" });
      case "compare":
        return await renderCompare(args);
      default:
        setRepoNav(undefined);
        main.append(container(), errorBlock(new ToolError("tool_error", "tool.NOT_FOUND", "Not Found")));
        return undefined;
    }
  } catch (error) {
    if (!fresh()) return undefined;
    if (error instanceof ToolError && error.is("UNAUTHORIZED")) {
      state.authError = error;
      clear(main);
      renderSignedOut(main, error);
      return undefined;
    }
    clear(main);
    setRepoNav(undefined);
    const wrap = container();
    wrap.append(errorBlock(error, { retry: () => render() }));
    main.append(wrap);
    return undefined;
  }
}

function renderSignedOut(main, error) {
  setCrumbs([]);
  setRepoNav(undefined);
  setTitle("Bad credentials");
  const block = el("div", { class: "signed-out" });
  block.append(el("img", { attrs: { src: "./assets/github-wordmark.svg", alt: "GitHub", width: 160, height: 44 } }));
  const banner = el("div", { class: "flash flash-error", attrs: { role: "alert" } });
  banner.append(icon("alert", "flash-icon"), el("span", { class: "flash-text", text: error.denied ? "Your actor has no grant for users.get-authenticated, so this app cannot identify you." : "Bad credentials: the actor's login attribute matches no user in this synthetic instance." }));
  block.append(banner);
  block.append(el("p", { class: "text-muted", text: `Actor ${state.context?.actorId ?? "?"}. Pick another actor in Firedrill and reopen the app.` }));
  main.append(block);
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function loadIdentity() {
  try {
    state.user = await call("users.get-authenticated", {});
    setWorldNow(state.user.server_time);
    state.authError = undefined;
  } catch (error) {
    state.user = undefined;
    if (error instanceof ToolError && (error.is("UNAUTHORIZED") || error.denied)) state.authError = error;
    else flash(describe(error), "error");
  }
  renderUserChip();
}

async function boot() {
  hydrateIcons();
  wireHeader();
  wireStaticChrome();
  window.addEventListener("hashchange", () => void render());
  let booted = false;
  await watchWorld(
    async (first) => {
      if (first) {
        await loadIdentity();
        booted = true;
      }
      // Re-read identity on every world change: it carries the world's virtual time used for relative dates.
      if (!first) await loadIdentity();
      state.repo = undefined;
      state.branches = undefined;
      state.labels = undefined;
      await render();
    },
    () => !state.editing && !isPending(),
    (context) => {
      state.context = context;
      if (!booted) renderUserChip();
    },
  );
}

void boot();
