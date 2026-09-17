// Code tab screens: tree, blob, editor, commits, commit, branches, compare / new pull request.
import { notSimulated } from "./chrome.js";
import { $, ToolError, action, avatar, button, call, pageAll, clear, confirmDialog, dayHeading, describe, el, flash, formatBytes, icon, iconButton, key, link, markdown, openDialog, openMenu, openSelectPanel, plural, timeElement, validationDetail } from "./ui.js";
import { archivedBanner, blankslate, canPush, container, errorBlock, hrefs, loadBranches, loadRepo, loadingBlock, navigate, pager, repoHead, setCrumbs, setRepoNav, setTitle, splitRefAndPath, state, userLink, withQuery } from "./shared.js";

const LANGUAGE_COLORS = { TypeScript: "#3178c6", JavaScript: "#f1e05a", Shell: "#89e051", Python: "#3572A5", Go: "#00ADD8", Rust: "#dea584", Markdown: "#083fa1" };

function repoCrumbs(repo, extra = []) {
  setCrumbs([{ text: repo.owner.login, href: hrefs.user(repo.owner.login) }, { text: repo.name, href: hrefs.repo(repo.full_name), current: extra.length === 0 }, ...extra]);
}

function shortSha(sha) {
  return sha.slice(0, 7);
}

function commitTitle(message) {
  return message.split("\n")[0];
}
function commitDescription(message) {
  const lines = message.split("\n");
  return lines.slice(1).join("\n").trim();
}

/** Branch selector button: opens a filterable list of branches and navigates via `onSelect(name)`. */
function branchSelector(branches, current, onSelect, { label = "Switch branches" } = {}) {
  const trigger = button(current, { icon: "git-branch", trailingIcon: "triangle-down", class: "btn-branch", title: label });
  trigger.setAttribute("aria-haspopup", "true");
  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", () => {
    openSelectPanel(trigger, {
      title: "Switch branches",
      placeholder: "Find a branch…",
      multiple: false,
      options: branches.map((branch) => ({ id: branch.name, label: branch.name, description: branch.name === state.repo?.default_branch ? "default" : undefined, selected: branch.name === current })),
      onSelect,
      emptyText: "Nothing to show",
    });
  });
  return trigger;
}

function latestCommitRow(commit, full, total) {
  const row = el("div", { class: "latest-commit" });
  const author = commit.author ?? { login: commit.commit.author.name };
  row.append(avatar(author, 20));
  row.append(el("a", { class: "commit-author", text: author.login, href: hrefs.user(author.login) }));
  row.append(el("a", { class: "commit-message", text: commitTitle(commit.commit.message), href: hrefs.commit(full, commit.sha), title: commit.commit.message }));
  const meta = el("div", { class: "commit-meta" });
  meta.append(el("a", { class: "commit-sha", text: shortSha(commit.sha), href: hrefs.commit(full, commit.sha) }));
  meta.append(el("span", { class: "commit-sep", text: "·" }), timeElement(commit.commit.author.date, "commit-time"));
  const history = el("a", { class: "history-link", href: hrefs.commits(full, commit.ref ?? state.repo.default_branch) });
  history.append(icon("history"), el("strong", { text: String(total) }), el("span", { text: plural(total, "Commit").split(" ")[1] }));
  meta.append(history);
  row.append(meta);
  return row;
}

/** Contributors = distinct commit authors on the default branch (read through repos.list-commits). */
function contributorsSection(repo) {
  const section = el("div", { class: "about-section" });
  const heading = el("h3", { text: "Contributors" });
  const faces = el("div", { class: "contributors" }, [el("span", { class: "skeleton skeleton-inline skeleton-50" })]);
  section.append(heading, faces);
  const [owner, name] = repo.full_name.split("/");
  pageAll((page) => call("repos.list-commits", { owner, repo: name, sha: repo.default_branch, ...page }), "commits")
    .then((result) => {
      const people = new Map();
      for (const commit of result.commits) if (commit.author?.login && !people.has(commit.author.login)) people.set(commit.author.login, commit.author);
      heading.append(" ", el("span", { class: "Counter", text: String(people.size) }));
      clear(faces);
      for (const user of people.values()) faces.append(el("a", { href: hrefs.user(user.login), title: user.login, attrs: { "aria-label": user.login } }, [avatar(user, 32)]));
      if (people.size === 0) faces.append(el("span", { class: "text-muted", text: "No contributors" }));
    })
    .catch(() => clear(faces).append(el("span", { class: "text-muted", text: "Contributors could not be loaded." })));
  return section;
}

function aboutSidebar(repo, readmePath) {
  const aside = el("div", { class: "about-sidebar" });
  aside.append(el("h2", { text: "About" }));
  aside.append(el("p", { text: repo.description || "No description, website, or topics provided." }));
  if (repo.homepage) aside.append(el("p", {}, [icon("link-external"), " ", link(repo.homepage, repo.homepage)]));
  if (repo.topics.length > 0) {
    const topics = el("div", { class: "topics" });
    for (const topic of repo.topics) topics.append(el("a", { class: "topic-tag", text: topic, href: hrefs.search(`topic:${topic}`) }));
    aside.append(topics);
  }
  const list = el("ul", { class: "about-list" });
  if (readmePath) list.append(el("li", {}, [icon("book"), link("Readme", hrefs.blob(repo.full_name, repo.default_branch, readmePath))]));
  if (repo.license) list.append(el("li", {}, [icon("law"), el("span", { text: `${repo.license.name} license` })]));
  list.append(el("li", {}, [icon("pulse"), link("Activity", hrefs.commits(repo.full_name, repo.default_branch))]));
  list.append(el("li", {}, [icon("eye"), el("span", {}, [el("strong", { text: String(repo.subscribers_count ?? repo.watchers_count) }), " watching"])]));
  list.append(el("li", {}, [icon("repo-forked"), el("span", {}, [el("strong", { text: String(repo.forks_count) }), " forks"])]));
  aside.append(list);
  let languages;
  if (repo.language) {
    const section = el("div", { class: "about-section" });
    section.append(el("h3", { text: "Languages" }));
    const dot = el("span", { class: "language-dot" });
    dot.style.background = LANGUAGE_COLORS[repo.language] ?? "#8b949e";
    const bar = el("div", { class: "language-bar", attrs: { role: "img", "aria-label": `${repo.language} 100.0%` } });
    const fill = el("span");
    fill.style.background = dot.style.background;
    bar.append(fill);
    section.append(bar, el("div", { class: "about-list" }, [el("div", {}, [dot, " ", el("strong", { text: repo.language }), el("span", { class: "text-muted", text: " 100.0%" })])]));
    languages = section;
  }
  const outOfScope = (heading, feature, text) => {
    const section = el("div", { class: "about-section" });
    const title = el("button", { class: "about-heading-link", title: `${feature} (not simulated)`, attrs: { type: "button" } }, [el("h3", { text: heading })]);
    title.addEventListener("click", () => notSimulated(feature));
    section.append(title, el("p", { class: "text-muted about-note", text }));
    return section;
  };
  aside.append(outOfScope("Releases", "Releases", "Releases are not simulated by this Tool."));
  aside.append(outOfScope("Packages", "GitHub Packages", "Packages are not simulated by this Tool."));
  aside.append(contributorsSection(repo));
  if (languages) aside.append(languages);
  return aside;
}

// ---------------------------------------------------------------------------------------------
// Tree (`#/{owner}/{repo}` and `#/{owner}/{repo}/tree/{ref}/{path}`)
// ---------------------------------------------------------------------------------------------

export async function renderCode({ owner, repo: repoName, rest, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const branches = await loadBranches(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const split = rest.length > 0 ? splitRefAndPath(rest, branches) : { ref: repo.default_branch, path: "" };
  const { ref, path } = split;
  repoCrumbs(repo);
  setRepoNav(repo, "code");
  setTitle(path ? `${full}/${path} at ${ref}` : `${full}`);

  const wrap = container();
  wrap.append(repoHead(repo));
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);
  const layout = el("div", { class: "Layout" });
  const mainCol = el("div", { class: "Layout-main" });
  const side = el("div", { class: "Layout-sidebar" });
  layout.append(mainCol, side);
  wrap.append(layout);
  main.append(wrap);

  // File navigation row
  const nav = el("div", { class: "file-navigation" });
  nav.append(branchSelector(branches, ref, (name) => navigate(hrefs.tree(full, name, path))));
  nav.append(el("a", { class: "file-navigation-count", href: hrefs.branches(full) }, [icon("git-branch"), el("strong", { text: String(branches.length) }), el("span", { text: branches.length === 1 ? "Branch" : "Branches" })]));
  const tags = el("button", { class: "file-navigation-count file-navigation-tags", title: "Tags (not simulated)", attrs: { type: "button" } }, [icon("tag"), el("span", { text: "Tags" })]);
  tags.addEventListener("click", () => notSimulated("Tags"));
  nav.append(tags);
  nav.append(el("span", { class: "file-navigation-spacer" }));
  const goToFile = el("input", { class: "form-control go-to-file", attrs: { type: "text", placeholder: "Go to file", "aria-label": "Go to file" } });
  nav.append(goToFile);
  if (canPush(repo)) {
    const addFile = button("Add file", { trailingIcon: "triangle-down" });
    addFile.addEventListener("click", () => openMenu(addFile, [{ label: "Create new file", icon: "plus", onSelect: () => navigate(`#/${full}/new/${ref}${path ? `/${path}` : ""}`) }], { align: "end" }));
    nav.append(addFile);
  }
  const code = button("Code", { variant: "primary", icon: "code", trailingIcon: "triangle-down" });
  code.addEventListener("click", () => openMenu(code, [{ header: "Clone" }, { label: repo.clone_url, description: "Synthetic repository: this URL is an identifier only and cannot be cloned.", icon: "copy", disabled: true }], { align: "end", width: 360 }));
  nav.append(code);
  mainCol.append(nav);

  if (path) {
    const crumbs = el("div", { class: "file-header-path" });
    crumbs.append(link(repo.name, hrefs.tree(full, ref)));
    const segments = path.split("/");
    segments.forEach((segment, index) => {
      crumbs.append(el("span", { class: "separator", text: "/" }));
      const sub = segments.slice(0, index + 1).join("/");
      if (index === segments.length - 1) crumbs.append(el("span", { class: "final-path", text: segment }));
      else crumbs.append(link(segment, hrefs.tree(full, ref, sub)));
    });
    mainCol.append(crumbs);
  }

  const box = el("div", { class: "Box" });
  const header = el("div", { class: "Box-header Box-header--condensed" }, [el("span", { class: "skeleton skeleton-60" })]);
  box.append(header);
  const table = el("table", { class: "file-table", attrs: { "aria-label": "Files" } });
  const tbody = el("tbody");
  table.append(tbody);
  box.append(table);
  mainCol.append(box);
  const readmeHost = el("div");
  mainCol.append(readmeHost);
  side.append(aboutSidebar(repo, undefined));

  let content;
  let latest;
  try {
    [content, latest] = await Promise.all([call("repos.get-content", { owner, repo: repoName, path, ref }), call("repos.list-commits", { owner, repo: repoName, sha: ref, path: path || undefined, perPage: 1 })]);
  } catch (error) {
    if (!fresh()) return;
    clear(header).append(el("span", { class: "text-muted", text: describe(error) }));
    clear(tbody).append(el("tr", {}, [el("td", {}, [errorBlock(error)])]));
    return;
  }
  if (!fresh()) return;
  if (content.type === "file") {
    navigate(hrefs.blob(full, ref, path));
    return;
  }
  clear(header);
  header.classList.remove("Box-header--condensed");
  header.style.padding = "0";
  if (latest.commits.length > 0) header.append(latestCommitRow({ ...latest.commits[0], ref }, full, latest.total_count));
  else header.append(el("span", { class: "text-muted latest-commit", text: "No commits yet" }));

  const entries = content.entries;
  const renderRows = (term = "") => {
    clear(tbody);
    if (path) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      tbody.append(el("tr", {}, [el("td", { class: "file-name", attrs: { colspan: 3 } }, [el("span", { class: "file-name-inner" }, [icon("file-directory-fill", "invisible"), el("a", { class: "file-parent", text: "..", href: hrefs.tree(full, ref, parent) })])])]));
    }
    const visible = entries.filter((entry) => !term || entry.name.toLowerCase().includes(term));
    if (visible.length === 0) tbody.append(el("tr", {}, [el("td", { class: "text-muted", attrs: { colspan: 3 } }, [el("div", { class: "diff-empty", text: term ? "No files matched." : "This directory is empty." })])]));
    for (const entry of visible) {
      const tr = el("tr", { attrs: { "data-path": entry.path } });
      const name = el("td", { class: "file-name" });
      const inner = el("span", { class: "file-name-inner" });
      inner.append(icon(entry.type === "dir" ? "file-directory-fill" : "file"));
      inner.append(el("a", { text: entry.name, href: entry.type === "dir" ? hrefs.tree(full, ref, entry.path) : hrefs.blob(full, ref, entry.path), title: entry.path }));
      name.append(inner);
      tr.append(name, el("td", { class: "file-commit" }, [el("span", { class: "skeleton skeleton-inline skeleton-50" })]), el("td", { class: "file-time" }));
      tbody.append(tr);
    }
  };
  renderRows();
  goToFile.addEventListener("input", () => renderRows(goToFile.value.trim().toLowerCase()));

  // Last commit per entry (every entry; trees hold at most 200 files).
  const lookups = entries.map(async (entry) => {
    try {
      const result = await call("repos.list-commits", { owner, repo: repoName, sha: ref, path: entry.path, perPage: 1 });
      return { entry, commit: result.commits[0] };
    } catch {
      return { entry, commit: undefined };
    }
  });
  const readme = entries.find((entry) => entry.type === "file" && /^readme(\.md|\.txt)?$/i.test(entry.name));
  if (readme) {
    clear(side).append(aboutSidebar(repo, readme.path));
    call("repos.get-content", { owner, repo: repoName, path: readme.path, ref })
      .then((file) => {
        if (!fresh()) return;
        const boxReadme = el("div", { class: "Box readme-box" });
        boxReadme.append(el("div", { class: "Box-header" }, [icon("book"), el("span", { text: readme.name })]));
        boxReadme.append(el("div", { class: "Box-body" }, [markdown(file.content)]));
        readmeHost.append(boxReadme);
      })
      .catch(() => {});
  }
  for (const lookup of lookups) {
    const { entry, commit } = await lookup;
    if (!fresh()) return;
    const tr = tbody.querySelector(`tr[data-path="${CSS.escape(entry.path)}"]`);
    if (!tr) continue;
    const commitCell = tr.querySelector(".file-commit");
    const timeCell = tr.querySelector(".file-time");
    clear(commitCell);
    if (commit) {
      commitCell.append(el("a", { text: commitTitle(commit.commit.message), href: hrefs.commit(full, commit.sha), title: commit.commit.message }));
      timeCell.append(timeElement(commit.commit.author.date));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Blob (`#/{owner}/{repo}/blob/{ref}/{path}`)
// ---------------------------------------------------------------------------------------------

function filePathHeader(repo, ref, path, branches, section) {
  const crumbs = el("div", { class: "file-header-path" });
  crumbs.append(branchSelector(branches, ref, (name) => navigate(section === "blob" ? hrefs.blob(repo.full_name, name, path) : hrefs.tree(repo.full_name, name, path))));
  crumbs.append(link(repo.name, hrefs.tree(repo.full_name, ref)));
  const segments = path.split("/");
  segments.forEach((segment, index) => {
    crumbs.append(el("span", { class: "separator", text: "/" }));
    const sub = segments.slice(0, index + 1).join("/");
    if (index === segments.length - 1) crumbs.append(el("span", { class: "final-path", text: segment }));
    else crumbs.append(link(segment, hrefs.tree(repo.full_name, ref, sub)));
  });
  return crumbs;
}

export async function renderBlob({ owner, repo: repoName, rest, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const branches = await loadBranches(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const { ref, path } = splitRefAndPath(rest, branches);
  repoCrumbs(repo, [{ text: path, href: hrefs.blob(full, ref, path), current: true }]);
  setRepoNav(repo, "code");
  setTitle(`${full}/${path} at ${ref}`);
  const wrap = container();
  wrap.append(repoHead(repo));
  main.append(wrap);
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);
  wrap.append(filePathHeader(repo, ref, path, branches, "blob"));
  const box = el("div", { class: "Box" });
  box.append(loadingBlock());
  wrap.append(box);
  let file;
  try {
    file = await call("repos.get-content", { owner, repo: repoName, path, ref });
  } catch (error) {
    if (!fresh()) return;
    clear(box).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  if (file.type !== "file") {
    navigate(hrefs.tree(full, ref, path));
    return;
  }
  clear(box);
  const lines = file.content.length === 0 ? [] : file.content.replace(/\n$/, "").split("\n");
  const loc = lines.filter((line) => line.trim().length > 0).length;
  const header = el("div", { class: "blob-header" });
  header.append(el("span", { class: "blob-header-info", text: `${plural(lines.length, "line")} (${loc} loc) · ${formatBytes(file.size)}` }));
  const actions = el("div", { class: "blob-header-actions" });
  const rawToggle = button("Raw", { size: "sm" });
  const copy = button("Copy", { size: "sm", icon: "copy", onClick: () => action(async () => {
    await navigator.clipboard.writeText(file.content);
    flash("Copied to clipboard.", "success");
  }, { exclusive: false, onError: () => flash("Clipboard access is blocked in this browser.", "error") }) });
  actions.append(rawToggle, copy);
  actions.append(button("History", { size: "sm", icon: "history", onClick: () => navigate(withQuery(hrefs.commits(full, ref), { path })) }));
  if (canPush(repo) && branches.some((branch) => branch.name === ref)) actions.append(iconButton("pencil", "Edit this file", { class: "btn-sm", onClick: () => navigate(hrefs.edit(full, ref, path)) }));
  else if (!repo.archived && branches.some((branch) => branch.name === ref)) actions.append(iconButton("pencil", "You must have write access to edit this file", { class: "btn-sm" }));
  header.append(actions);
  box.append(header);
  const scroller = el("div", { class: "blob-wrap" });
  const table = el("table", { class: "blob-table", attrs: { "aria-label": path } });
  const tbody = el("tbody");
  lines.forEach((line, index) => {
    const number = el("td", { class: "blob-num", text: String(index + 1), attrs: { id: `L${index + 1}` } });
    tbody.append(el("tr", {}, [number, el("td", { class: "blob-code", text: line })]));
  });
  if (lines.length === 0) tbody.append(el("tr", {}, [el("td", { class: "diff-empty", text: "This file is empty.", attrs: { colspan: 2 } })]));
  table.append(tbody);
  scroller.append(table);
  const raw = el("pre", { class: "blob-raw", text: file.content });
  raw.hidden = true;
  box.append(scroller, raw);
  rawToggle.addEventListener("click", () => {
    const showRaw = raw.hidden;
    raw.hidden = !showRaw;
    scroller.hidden = showRaw;
    rawToggle.querySelector(".btn-label").textContent = showRaw ? "Code" : "Raw";
  });
}

// ---------------------------------------------------------------------------------------------
// Editor (`#/{owner}/{repo}/edit/{ref}/{path}` and `#/{owner}/{repo}/new/{ref}/{dir}`)
// ---------------------------------------------------------------------------------------------

export async function renderEdit({ owner, repo: repoName, rest, fresh, main, create = false }) {
  const repo = await loadRepo(owner, repoName);
  const branches = await loadBranches(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const { ref, path } = splitRefAndPath(rest, branches);
  const directory = create ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  repoCrumbs(repo, [{ text: create ? "New file" : `Editing ${path}`, href: location.hash, current: true }]);
  setRepoNav(repo, "code");
  setTitle(create ? `New file · ${full}` : `Editing ${path} at ${ref} · ${full}`);
  const wrap = container();
  wrap.append(repoHead(repo));
  main.append(wrap);
  if (!canPush(repo)) {
    wrap.append(blankslate("lock", repo.archived ? "This repository is archived" : "You need write access", repo.archived ? "Archived repositories are read-only." : "Editing files requires push access to this repository.", [button("Back", { onClick: () => history.back() })]));
    return;
  }
  let file = { content: "", sha: undefined };
  if (!create) {
    try {
      file = await call("repos.get-content", { owner, repo: repoName, path, ref });
    } catch (error) {
      if (!fresh()) return;
      wrap.append(errorBlock(error));
      return;
    }
    if (!fresh()) return;
  }
  const form = el("form", { class: "new-item-form" });
  const toolbar = el("div", { class: "editor-toolbar" });
  toolbar.append(link(repo.name, hrefs.tree(full, ref)), el("span", { class: "separator text-muted", text: "/" }));
  if (directory) toolbar.append(el("span", { class: "text-mono", text: `${directory}/` }));
  const nameInput = el("input", { class: "form-control", attrs: { type: "text", placeholder: "Name your file…", "aria-label": "File name", required: "" } });
  nameInput.value = create ? "" : path.split("/").pop();
  nameInput.readOnly = !create;
  toolbar.append(nameInput, el("span", { class: "text-muted", text: `in ${ref}` }));
  form.append(toolbar);
  const textarea = el("textarea", { class: "form-control editor-textarea", attrs: { "aria-label": "File contents", spellcheck: "false" } });
  textarea.value = file.content;
  form.append(textarea);
  const actions = el("div", { class: "editor-actions" });
  const cancel = button("Cancel changes", { variant: "danger", onClick: async () => {
    if (!state.editing || (await confirmDialog("Discard changes?", "Your edits to this file will be lost.", "Discard", { danger: true }))) navigate(create ? hrefs.tree(full, ref, directory) : hrefs.blob(full, ref, path));
  } });
  const commit = button("Commit changes…", { variant: "primary" });
  actions.append(cancel, commit);
  form.append(actions);
  wrap.append(form);
  textarea.addEventListener("input", () => (state.editing = true));
  nameInput.addEventListener("input", () => (state.editing = true));

  commit.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      flash("Name your file first.", "error");
      return;
    }
    const target = directory ? `${directory}/${name}` : name;
    const outcome = await openDialog("Commit changes", (body, close) => {
      const message = el("input", { class: "form-control", attrs: { type: "text", "aria-label": "Commit message", placeholder: "Commit message" } });
      message.value = create ? `Create ${name}` : `Update ${name}`;
      message.style.width = "100%";
      const extended = el("textarea", { class: "form-control", attrs: { placeholder: "Add an optional extended description…", "aria-label": "Extended description" } });
      extended.style.width = "100%";
      const direct = el("input", { attrs: { type: "radio", name: "commit-choice", value: "direct", checked: "" } });
      const branchOption = el("input", { attrs: { type: "radio", name: "commit-choice", value: "branch" } });
      const newBranch = el("input", { class: "form-control input-monospace", attrs: { type: "text", "aria-label": "New branch name" } });
      newBranch.value = `${state.user?.login ?? "user"}-patch-1`;
      newBranch.style.width = "100%";
      newBranch.disabled = true;
      branchOption.addEventListener("change", () => (newBranch.disabled = false));
      direct.addEventListener("change", () => (newBranch.disabled = true));
      const errorHost = el("div", { class: "form-note color-fg-danger" });
      body.append(
        el("div", { class: "form-group" }, [el("label", { class: "form-label", text: "Commit message" }), message]),
        el("div", { class: "form-group" }, [extended]),
        el("label", { class: "form-radio" }, [direct, el("span", {}, [icon("git-commit"), " Commit directly to the ", el("span", { class: "branch-name", text: ref }), " branch"])]),
        el("label", { class: "form-radio" }, [branchOption, el("span", {}, [icon("git-pull-request"), " Create a ", el("strong", { text: "new branch" }), " for this commit and start a pull request"])]),
        el("div", { class: "form-group" }, [newBranch]),
        errorHost,
      );
      const submit = button("Commit changes", { variant: "primary" });
      body.append(el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close(undefined) }), submit]));
      submit.addEventListener("click", () =>
        action(
          async () => {
            const text = message.value.trim();
            if (!text) {
              errorHost.textContent = "A commit message is required.";
              return;
            }
            const fullMessage = extended.value.trim() ? `${text}\n\n${extended.value.trim()}` : text;
            let branch = ref;
            if (branchOption.checked) {
              branch = newBranch.value.trim();
              if (!branch) {
                errorHost.textContent = "Name the new branch.";
                return;
              }
              await call("repos.create-branch", { owner, repo: repoName, branch, from_branch: ref }, key());
            }
            const result = await call("repos.create-or-update-file", { owner, repo: repoName, path: target, message: fullMessage, content: textarea.value, branch, sha: file.sha }, key());
            state.editing = false;
            close({ branch, sha: result.commit.sha });
          },
          {
            onError: (error) => {
              if (error instanceof ToolError && error.is("CONFLICT")) errorHost.textContent = `The file has changed since you started editing (${error.message}). Reload the file and try again.`;
              else errorHost.textContent = describe(error) + (validationDetail(error) ? ` — ${validationDetail(error)}` : "");
            },
          },
        ),
      );
    });
    if (!outcome) return;
    if (outcome.branch !== ref) {
      flash(`Committed to ${outcome.branch}. Open a pull request to merge it into ${ref}.`, "success");
      navigate(hrefs.compare(full, ref, outcome.branch));
    } else {
      flash(`Committed ${shortSha(outcome.sha)} to ${ref}.`, "success");
      navigate(hrefs.blob(full, ref, target));
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Commits (`#/{owner}/{repo}/commits/{ref}?path=&page=`)
// ---------------------------------------------------------------------------------------------

export async function renderCommits({ owner, repo: repoName, rest, query, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const branches = await loadBranches(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const ref = rest.length > 0 ? splitRefAndPath(rest, branches).ref : repo.default_branch;
  const path = query.get("path") ?? "";
  const page = Math.max(1, Number(query.get("page") ?? 1));
  repoCrumbs(repo, [{ text: "Commits", href: hrefs.commits(full, ref), current: true }]);
  setRepoNav(repo, "code");
  setTitle(`Commits · ${full}`);
  const wrap = container();
  wrap.append(repoHead(repo));
  main.append(wrap);
  const nav = el("div", { class: "file-navigation" });
  nav.append(branchSelector(branches, ref, (name) => navigate(withQuery(hrefs.commits(full, name), { path }))));
  if (path) nav.append(el("span", { class: "text-muted" }, ["History for ", el("span", { class: "text-mono", text: path })]));
  wrap.append(nav);
  const host = el("div", {}, [loadingBlock()]);
  wrap.append(host);
  let result;
  try {
    result = await call("repos.list-commits", { owner, repo: repoName, sha: ref, path: path || undefined, perPage: 30, page });
  } catch (error) {
    if (!fresh()) return;
    clear(host).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  clear(host);
  if (result.commits.length === 0) {
    host.append(blankslate("git-commit", "No commits history", path ? `No commits touch ${path} on ${ref}.` : `${ref} has no commits.`));
    return;
  }
  const timeline = el("div", { class: "commits-timeline" });
  let currentDay;
  let dayBox;
  for (const commit of result.commits) {
    const day = dayHeading(commit.commit.author.date);
    if (day !== currentDay) {
      currentDay = day;
      const section = el("div", { class: "commits-day" });
      section.append(el("h3", { class: "commits-day-title" }, [icon("git-commit"), el("span", { text: `Commits on ${day}` })]));
      dayBox = el("div", { class: "Box" });
      section.append(dayBox);
      timeline.append(section);
    }
    const row = el("div", { class: "commit-row Box-row" });
    const body = el("div", { class: "commit-row-main" });
    body.append(el("a", { class: "commit-row-title", text: commitTitle(commit.commit.message), href: hrefs.commit(full, commit.sha), title: commit.commit.message }));
    const meta = el("div", { class: "commit-row-meta" });
    const author = commit.author ?? { login: commit.commit.author.name };
    meta.append(avatar(author, 16), el("a", { class: "commit-author", text: author.login, href: hrefs.user(author.login) }), " committed ", timeElement(commit.commit.author.date));
    body.append(meta);
    row.append(body);
    const actions = el("div", { class: "commit-row-actions" });
    actions.append(el("a", { class: "commit-sha", text: shortSha(commit.sha), href: hrefs.commit(full, commit.sha), title: commit.sha }));
    actions.append(iconButton("code", "Browse the repository at this point in the history", { class: "btn-sm", onClick: () => navigate(hrefs.tree(full, commit.sha)) }));
    row.append(actions);
    dayBox.append(row);
  }
  host.append(timeline);
  const footer = pager({ page, perPage: 30, total: result.total_count, totalPages: result.total_pages, labels: ["Newer", "Older"], onPage: (next) => navigate(withQuery(hrefs.commits(full, ref), { path, page: next })) });
  if (footer) host.append(footer);
}

// ---------------------------------------------------------------------------------------------
// Commit page (`#/{owner}/{repo}/commit/{sha}`)
// ---------------------------------------------------------------------------------------------

function parsePatch(patch) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (line.startsWith("+")) rows.push({ kind: "add", newLine: newLine++, text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", oldLine: oldLine++, text: line.slice(1) });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", text: line });
    else rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.startsWith(" ") ? line.slice(1) : line });
  }
  return rows;
}

export function fileDiff(file, full, ref) {
  const box = el("div", { class: "Box file-diff" });
  const header = el("div", { class: "file-diff-header" });
  header.append(icon("file", "text-muted"));
  header.append(el("a", { class: "file-diff-name", text: file.filename, href: hrefs.blob(full, ref, file.filename) }));
  if (file.status !== "modified") header.append(el("span", { class: `Label ${file.status === "removed" ? "" : ""}`, text: file.status }));
  header.append(el("span", { class: "file-diff-stat" }, [el("span", { class: "color-fg-success text-bold", text: `+${file.additions}` }), " ", el("span", { class: "color-fg-danger text-bold", text: `−${file.deletions}` })]));
  box.append(header);
  if (!file.patch) {
    box.append(el("div", { class: "diff-empty", text: file.status === "removed" ? "This file was deleted." : "No visible changes (binary or empty diff)." }));
    return box;
  }
  const table = el("table", { class: "diff-table", attrs: { "aria-label": `Diff of ${file.filename}` } });
  const tbody = el("tbody");
  for (const row of parsePatch(file.patch)) {
    const tr = el("tr", { class: row.kind });
    if (row.kind === "hunk" || row.kind === "meta") {
      tr.append(el("td", { class: "diff-num", attrs: { colspan: 2 } }), el("td", { class: "diff-marker" }), el("td", { class: "diff-code", text: row.text }));
    } else {
      tr.append(el("td", { class: "diff-num", text: row.oldLine === undefined ? "" : String(row.oldLine) }), el("td", { class: "diff-num", text: row.newLine === undefined ? "" : String(row.newLine) }), el("td", { class: "diff-marker", text: row.kind === "add" ? "+" : row.kind === "del" ? "-" : " " }), el("td", { class: "diff-code", text: row.text }));
    }
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(el("div", { class: "blob-wrap" }, [table]));
  return box;
}

export function diffStats(files, additions, deletions) {
  const stats = el("div", { class: "diff-stats" });
  stats.append(el("span", {}, ["Showing ", el("strong", { text: plural(files, "changed file") }), " with ", el("span", { class: "add", text: `${additions} additions` }), " and ", el("span", { class: "del", text: `${deletions} deletions` }), "."]));
  return stats;
}

export async function renderCommit({ owner, repo: repoName, rest, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const sha = rest[0] ?? "";
  repoCrumbs(repo, [{ text: shortSha(sha), href: hrefs.commit(full, sha), current: true }]);
  setRepoNav(repo, "code");
  setTitle(`Commit ${shortSha(sha)} · ${full}`);
  const wrap = container();
  wrap.append(repoHead(repo));
  const host = el("div", {}, [loadingBlock()]);
  wrap.append(host);
  main.append(wrap);
  let commit;
  try {
    // Files are paged by count and bytes; fetch every page so no file of a large commit is hidden.
    commit = await call("repos.get-commit", { owner, repo: repoName, sha, detail: "full_patch", perPage: 100, page: 1 });
    for (let page = 2; page <= (commit.total_pages ?? 1); page += 1) {
      const next = await call("repos.get-commit", { owner, repo: repoName, sha, detail: "full_patch", perPage: 100, page });
      commit = { ...commit, files: [...(commit.files ?? []), ...(next.files ?? [])] };
    }
  } catch (error) {
    if (!fresh()) return;
    clear(host).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  clear(host);
  const header = el("div", { class: "commit-header" });
  header.append(el("h1", { class: "commit-title", text: commitTitle(commit.commit.message) }));
  const description = commitDescription(commit.commit.message);
  if (description) header.append(el("pre", { class: "commit-desc", text: description }));
  const meta = el("div", { class: "commit-meta-row" });
  const author = commit.author ?? { login: commit.commit.author.name };
  meta.append(avatar(author, 20), el("a", { class: "commit-author", text: author.login, href: hrefs.user(author.login) }), " committed ", timeElement(commit.commit.author.date));
  const refs = el("div", { class: "commit-refs" });
  refs.append(el("span", { class: "text-muted", text: commit.parents.length === 0 ? "0 parents" : `${commit.parents.length === 1 ? "1 parent" : `${commit.parents.length} parents`}` }));
  for (const parent of commit.parents) refs.append(el("a", { class: "commit-sha", text: shortSha(parent.sha), href: hrefs.commit(full, parent.sha) }));
  refs.append(el("span", { class: "text-muted", text: "commit" }), el("span", { class: "commit-sha", text: commit.sha }));
  meta.append(refs);
  header.append(meta);
  host.append(header);
  host.append(el("div", { class: "file-navigation" }, [button("Browse files", { size: "sm", icon: "code", onClick: () => navigate(hrefs.tree(full, commit.sha)) })]));
  host.append(diffStats(commit.files.length, commit.stats.additions, commit.stats.deletions));
  if (commit.files.length === 0) host.append(blankslate("diff", "No changes", "This commit introduces no file changes."));
  for (const file of commit.files) host.append(fileDiff(file, full, commit.sha));
}

// ---------------------------------------------------------------------------------------------
// Branches (`#/{owner}/{repo}/branches`)
// ---------------------------------------------------------------------------------------------

async function newBranchDialog(owner, repoName, branches, defaultSource) {
  return openDialog("Create a branch", (body, close) => {
    const name = el("input", { class: "form-control input-monospace", attrs: { type: "text", placeholder: "New branch name", "aria-label": "New branch name", autocomplete: "off" } });
    name.style.width = "100%";
    const source = el("select", { class: "form-control", attrs: { "aria-label": "Source" } });
    for (const branch of branches) {
      const option = el("option", { text: branch.name, attrs: { value: branch.name } });
      if (branch.name === defaultSource) option.selected = true;
      source.append(option);
    }
    source.style.width = "100%";
    const errorHost = el("div", { class: "form-note color-fg-danger" });
    body.append(el("div", { class: "form-group" }, [el("label", { class: "form-label", text: "New branch name" }), name]), el("div", { class: "form-group" }, [el("label", { class: "form-label", text: "Source" }), source]), errorHost);
    const create = button("Create new branch", { variant: "primary" });
    body.append(el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close(undefined) }), create]));
    const submit = () =>
      action(
        async () => {
          const value = name.value.trim();
          if (!value) {
            errorHost.textContent = "Enter a branch name.";
            return;
          }
          const result = await call("repos.create-branch", { owner, repo: repoName, branch: value, from_branch: source.value }, key());
          close(result);
        },
        { onError: (error) => (errorHost.textContent = error instanceof ToolError && error.status === "invalid" ? "Validation failed: the branch name is not valid." : error instanceof ToolError && error.is("VALIDATION_FAILED") ? `${error.message}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}` : describe(error)) },
      );
    create.addEventListener("click", submit);
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });
  });
}

export async function renderBranches({ owner, repo: repoName, query, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const branches = await loadBranches(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  repoCrumbs(repo, [{ text: "Branches", href: hrefs.branches(full), current: true }]);
  setRepoNav(repo, "code");
  setTitle(`Branches · ${full}`);
  const wrap = container();
  wrap.append(repoHead(repo));
  const header = el("div", { class: "page-header" });
  header.append(el("h1", { text: "Branches" }));
  // Not wrapped in action(): the dialog's own submit runs an exclusive action, so the outer wait must not hold the busy flag.
  const openNew = async () => {
    const created = await newBranchDialog(owner, repoName, branches, repo.default_branch);
    if (created) {
      flash(`Branch ${created.ref.replace("refs/heads/", "")} created.`, "success");
      state.branches = undefined;
      navigate(hrefs.branches(full));
    }
  };
  if (canPush(repo)) header.append(button("New branch", { variant: "primary", onClick: openNew }));
  wrap.append(header);
  main.append(wrap);
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);

  const details = await Promise.all(branches.map((branch) => call("repos.get-branch", { owner, repo: repoName, branch: branch.name }).catch(() => undefined)));
  if (!fresh()) return;
  const table = (title, rows) => {
    const box = el("div", { class: "Box mb-3" });
    box.append(el("div", { class: "Box-header" }, [el("h2", { class: "Box-title", text: title })]));
    const tbl = el("table", { class: "branches-table" });
    tbl.append(el("thead", {}, [el("tr", {}, [el("th", { text: "Branch" }), el("th", { text: "Updated" }), el("th", { text: "" })])]));
    const tbody = el("tbody");
    if (rows.length === 0) tbody.append(el("tr", {}, [el("td", { class: "text-muted", text: "No other branches.", attrs: { colspan: 3 } })]));
    for (const { branch, detail } of rows) {
      const tr = el("tr");
      const cell = el("td");
      const inner = el("div", { class: "branch-cell" });
      inner.append(el("a", { class: "branch-name", text: branch.name, href: hrefs.tree(full, branch.name) }));
      if (branch.name === repo.default_branch) inner.append(el("span", { class: "Label", text: "Default" }));
      if (branch.protected) inner.append(icon("lock", "text-muted"));
      cell.append(inner);
      tr.append(cell);
      const updated = el("td");
      if (detail) {
        const author = detail.commit.author ?? { login: detail.commit.commit.author.name };
        updated.append(el("div", { class: "branch-updated" }, [avatar(author, 20), timeElement(detail.commit.commit.author.date), " by ", el("a", { text: author.login, href: hrefs.user(author.login) })]));
      } else updated.append(el("span", { class: "text-muted", text: "—" }));
      tr.append(updated);
      const actions = el("td", { class: "text-right" });
      if (branch.name !== repo.default_branch && canPush(repo)) actions.append(button("New pull request", { size: "sm", onClick: () => navigate(hrefs.compare(full, repo.default_branch, branch.name)) }));
      tr.append(actions);
      tbody.append(tr);
    }
    tbl.append(tbody);
    box.append(tbl);
    return box;
  };
  const rows = branches.map((branch, index) => ({ branch, detail: details[index] }));
  wrap.append(table("Default", rows.filter(({ branch }) => branch.name === repo.default_branch)));
  wrap.append(table("Active branches", rows.filter(({ branch }) => branch.name !== repo.default_branch).sort((left, right) => (right.detail?.commit.commit.author.date ?? "").localeCompare(left.detail?.commit.commit.author.date ?? ""))));
  if (query.get("new") === "1" && canPush(repo)) {
    history.replaceState(null, "", hrefs.branches(full));
    void openNew();
  }
}

// ---------------------------------------------------------------------------------------------
// Compare / new pull request (`#/{owner}/{repo}/compare[/{base}...{head}]`)
// ---------------------------------------------------------------------------------------------

async function compareBranches(owner, repoName, base, head) {
  const [baseCommits, headCommits] = await Promise.all([pageAll((page) => call("repos.list-commits", { owner, repo: repoName, sha: base, ...page }), "commits"), pageAll((page) => call("repos.list-commits", { owner, repo: repoName, sha: head, ...page }), "commits")]);
  const baseShas = new Set(baseCommits.commits.map((commit) => commit.sha));
  const headShas = new Set(headCommits.commits.map((commit) => commit.sha));
  const ahead = headCommits.commits.filter((commit) => !baseShas.has(commit.sha));
  const behind = baseCommits.commits.filter((commit) => !headShas.has(commit.sha));
  const filesOf = async (commits) => {
    const set = new Set();
    for (const commit of commits) {
      const full = await call("repos.get-commit", { owner, repo: repoName, sha: commit.sha, detail: "stats" });
      for (const file of full.files ?? []) set.add(file.filename);
    }
    return set;
  };
  const [aheadFiles, behindFiles] = await Promise.all([filesOf(ahead), filesOf(behind)]);
  const conflicts = [...aheadFiles].filter((file) => behindFiles.has(file));
  return { ahead, behind, conflicts, files: aheadFiles.size };
}

export async function renderCompare({ owner, repo: repoName, rest, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const branches = await loadBranches(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const spec = rest.join("/");
  const [baseRaw, headRaw] = spec.includes("...") ? spec.split("...") : [repo.default_branch, ""];
  const base = branches.some((branch) => branch.name === baseRaw) ? baseRaw : repo.default_branch;
  const head = branches.some((branch) => branch.name === headRaw) ? headRaw : "";
  repoCrumbs(repo, [{ text: "Compare", href: hrefs.compare(full), current: true }]);
  setRepoNav(repo, "pulls");
  setTitle(`Comparing changes · ${full}`);
  const wrap = container();
  wrap.append(repoHead(repo));
  main.append(wrap);
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);
  wrap.append(el("div", { class: "page-header" }, [el("div", {}, [el("h1", { text: "Comparing changes" }), el("p", { class: "text-muted", text: "Choose two branches to see what's changed or to start a new pull request." })])]));
  const range = el("div", { class: "range-editor" });
  range.append(el("span", { class: "text-muted", text: "base:" }), branchSelector(branches, base, (name) => navigate(hrefs.compare(full, name, head)), { label: "Choose a base branch" }));
  range.append(icon("arrow-left"));
  range.append(el("span", { class: "text-muted", text: "compare:" }), branchSelector(branches, head || "choose a branch", (name) => navigate(hrefs.compare(full, base, name)), { label: "Choose a head branch" }));
  const status = el("span", { class: "range-status" });
  range.append(status);
  wrap.append(range);
  if (!head) {
    wrap.append(blankslate("git-pull-request", "Choose a head branch", "Pick the branch with your changes to compare it against the base branch."));
    return;
  }
  if (head === base) {
    wrap.append(blankslate("git-pull-request", "There isn't anything to compare", `${base} and ${head} are the same branch.`));
    return;
  }
  status.append(el("span", { class: "spinner spinner-sm" }), el("span", { text: "Checking mergeability…" }));
  const summary = el("div", { class: "compare-summary" });
  wrap.append(summary);
  const formHost = el("div");
  wrap.append(formHost);
  let comparison;
  try {
    comparison = await compareBranches(owner, repoName, base, head);
  } catch (error) {
    if (!fresh()) return;
    clear(status).append(icon("alert"), el("span", { text: describe(error) }));
    return;
  }
  if (!fresh()) return;
  clear(status);
  if (comparison.ahead.length === 0) {
    status.append(icon("info"), el("span", { text: "There isn't anything to compare." }));
    summary.append(el("span", {}, [el("strong", { text: base }), ` is up to date with all commits from `, el("strong", { text: head }), "."]));
    return;
  }
  if (comparison.conflicts.length > 0) {
    status.classList.add("conflict");
    status.append(icon("x"), el("span", {}, [el("strong", { text: "Can't automatically merge." }), " Don't worry, you can still create the pull request."]));
  } else {
    status.classList.add("ok");
    status.append(icon("check"), el("span", {}, [el("strong", { text: "Able to merge." }), " These branches can be automatically merged."]));
  }
  summary.append(el("span", {}, [icon("git-commit"), " ", el("strong", { text: String(comparison.ahead.length) }), ` commit${comparison.ahead.length === 1 ? "" : "s"}`]));
  summary.append(el("span", {}, [icon("file"), " ", el("strong", { text: String(comparison.files) }), ` file${comparison.files === 1 ? "" : "s"} changed`]));
  summary.append(el("span", { class: "text-small", text: "(preview computed from the branch histories; the pull request records the definitive numbers)" }));

  if (!canPush(repo)) {
    formHost.append(blankslate("lock", "Write access required", "Creating a pull request needs push access to this repository."));
    return;
  }
  const form = el("form", { class: "new-item-form" });
  const title = el("input", { class: "form-control new-title", attrs: { type: "text", placeholder: "Title", "aria-label": "Title", required: "" } });
  title.value = comparison.ahead.length === 1 ? commitTitle(comparison.ahead[0].commit.message) : "";
  const body = el("textarea", { class: "form-control new-body", attrs: { placeholder: "Leave a comment", "aria-label": "Description" } });
  const errorHost = el("div", { class: "form-note color-fg-danger" });
  form.append(title, body, errorHost);
  const actions = el("div", { class: "form-actions" });
  const create = button("Create pull request", { variant: "primary", type: "submit" });
  const caret = button("", { variant: "primary", trailingIcon: "triangle-down", class: "btn-caret", ariaLabel: "More create options" });
  caret.addEventListener("click", () => openMenu(caret, [{ label: "Create pull request", description: "Open a pull request that is ready for review.", onSelect: () => submit(false) }, { label: "Create draft pull request", description: "Cannot be merged until marked ready for review.", onSelect: () => submit(true) }], { align: "end", width: 320 }));
  actions.append(el("div", { class: "btn-group" }, [create, caret]));
  form.append(actions);
  formHost.append(form);
  title.addEventListener("input", () => (state.editing = true));
  body.addEventListener("input", () => (state.editing = true));
  const submit = (draft) =>
    action(
      async () => {
        if (!title.value.trim()) {
          errorHost.textContent = "Title can't be blank.";
          title.focus();
          return;
        }
        const pull = await call("pulls.create", { owner, repo: repoName, title: title.value.trim(), body: body.value, head, base, draft }, key());
        state.editing = false;
        flash(`Pull request #${pull.number} created.`, "success");
        navigate(hrefs.pull(full, pull.number));
      },
      { onError: (error) => (errorHost.textContent = `${describe(error)}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}`) },
    );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(false);
  });
}

export { commitTitle, compareBranches, shortSha };
