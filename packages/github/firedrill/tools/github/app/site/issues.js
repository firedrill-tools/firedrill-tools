// Issues screens (list, new, detail, labels) and the global search page; also the discussion building blocks
// (comment boxes, comment form, sidebar pickers) shared with pull requests.
import { chromeSidebarItems, markdownEditor, markdownToolbar } from "./compose.js";
import { notSimulated, notSimulatedSidebarItem } from "./chrome.js";
import { $, ToolError, action, avatar, button, call, pageAll, clear, confirmDialog, describe, el, flash, icon, iconButton, key, labelChip, link, markdown, openMenu, openSelectPanel, plural, timeElement, validationDetail } from "./ui.js";
import { archivedBanner, blankslate, canTriage, container, errorBlock, filterMenuButton, hrefs, isPull, issueRow, listHeader, loadLabels, loadRepo, loadingBlock, navigate, pager, setCrumbs, setNavCount, setRepoNav, setTitle, state, userLink, withQuery, PER_PAGE } from "./shared.js";

const SORTS = [
  { id: "created-desc", label: "Newest", sort: "created", direction: "desc" },
  { id: "created-asc", label: "Oldest", sort: "created", direction: "asc" },
  { id: "comments-desc", label: "Most commented", sort: "comments", direction: "desc" },
  { id: "comments-asc", label: "Least commented", sort: "comments", direction: "asc" },
  { id: "updated-desc", label: "Recently updated", sort: "updated", direction: "desc" },
  { id: "updated-asc", label: "Least recently updated", sort: "updated", direction: "asc" },
];

function repoCrumbs(repo, extra = []) {
  setCrumbs([{ text: repo.owner.login, href: hrefs.user(repo.owner.login) }, { text: repo.name, href: hrefs.repo(repo.full_name) }, ...extra]);
}

function tokenize(query) {
  const tokens = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of String(query).matchAll(pattern)) tokens.push(match[1] !== undefined ? match[1] : match[2]);
  return tokens;
}

/**
 * Parse an issues-tab query. Returns { kind, state, labels, assignee, author, sort, direction, listable, rest }.
 * `listable` is true when every token maps onto an `issues.list` filter; otherwise `issues.search` is used.
 */
export function parseListQuery(query, defaultKind) {
  const filter = { kind: defaultKind, state: "open", labels: [], assignee: undefined, author: undefined, sort: "created", direction: "desc", listable: true, tokens: [], sortId: "created-desc" };
  for (const token of tokenize(query)) {
    filter.tokens.push(token);
    const colon = token.indexOf(":");
    const name = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? token.slice(colon + 1) : token;
    if (name === "is" && (value === "issue" || value === "pr")) filter.kind = value;
    else if ((name === "is" || name === "state") && ["open", "closed"].includes(value)) filter.state = value;
    else if (name === "is" && value === "all") filter.state = "all";
    else if (name === "label") filter.labels.push(value);
    else if (name === "assignee") filter.assignee = value === "@me" ? (state.user?.login ?? value) : value;
    else if (name === "author") filter.author = value === "@me" ? (state.user?.login ?? value) : value;
    else if (name === "no" && value === "assignee") filter.assignee = "none";
    else if (name === "sort") {
      const sort = SORTS.find((entry) => entry.id === value.toLowerCase());
      if (sort) {
        filter.sort = sort.sort;
        filter.direction = sort.direction;
        filter.sortId = sort.id;
      }
    } else filter.listable = false;
  }
  return filter;
}

function rewriteQuery(query, name, value) {
  const tokens = tokenize(query).filter((token) => !token.toLowerCase().startsWith(`${name}:`));
  if (value !== undefined && value !== null && value !== "") tokens.push(`${name}:${/\s/.test(value) ? `"${value}"` : value}`);
  return tokens.join(" ");
}
function toggleQueryToken(query, name, value) {
  const token = `${name}:${/\s/.test(value) ? `"${value}"` : value}`;
  const tokens = tokenize(query);
  const index = tokens.findIndex((entry) => entry.toLowerCase() === token.toLowerCase());
  if (index >= 0) tokens.splice(index, 1);
  else tokens.push(token);
  return tokens.join(" ");
}
function setStateToken(query, stateValue) {
  const tokens = tokenize(query).filter((token) => !/^(is|state):(open|closed|all)$/i.test(token));
  tokens.push(`is:${stateValue}`);
  return tokens.join(" ");
}

/** Fetch one page for the issues / pull requests tab through issues.list, pulls.list or issues.search. */
async function fetchList(owner, repoName, filter, page, kind) {
  const searchTokens = filter.tokens.filter((token) => !token.toLowerCase().startsWith("sort:"));
  const query = searchTokens.join(" ");
  const count = async (stateValue) => {
    if (filter.listable && kind === "issue") return (await call("issues.list", { owner, repo: repoName, state: stateValue, labels: filter.labels.length ? filter.labels : undefined, assignee: filter.assignee, creator: filter.author, perPage: 1 })).total_count;
    if (filter.listable && kind === "pr" && filter.labels.length === 0 && !filter.assignee && !filter.author) return (await call("pulls.list", { owner, repo: repoName, state: stateValue, perPage: 1 })).total_count;
    const q = `${setStateToken(query, stateValue)}${query.includes(`is:${kind}`) ? "" : ` is:${kind}`}`;
    return (await call("issues.search", { query: q, owner, repo: repoName, perPage: 1 })).total_count;
  };
  let items;
  let total;
  let pages;
  if (filter.listable && kind === "issue") {
    const result = await call("issues.list", { owner, repo: repoName, state: filter.state, labels: filter.labels.length ? filter.labels : undefined, assignee: filter.assignee, creator: filter.author, sort: filter.sort, direction: filter.direction, perPage: PER_PAGE, page });
    items = result.issues;
    total = result.total_count;
    pages = result.total_pages;
  } else if (filter.listable && kind === "pr" && filter.labels.length === 0 && !filter.assignee && !filter.author && filter.sort !== "comments") {
    const result = await call("pulls.list", { owner, repo: repoName, state: filter.state, sort: filter.sort, direction: filter.direction, perPage: PER_PAGE, page });
    items = result.pull_requests;
    total = result.total_count;
    pages = result.total_pages;
  } else {
    const q = `${filter.state === "all" ? tokenize(query).filter((t) => !/^(is|state):all$/i.test(t)).join(" ") : query}${query.includes(`is:${kind}`) ? "" : ` is:${kind}`}`;
    const result = await call("issues.search", { query: q, owner, repo: repoName, sort: filter.sort === "created" && filter.direction === "desc" && filter.sortId === "created-desc" ? "created" : filter.sort, order: filter.direction, perPage: PER_PAGE, page });
    items = result.items;
    total = result.total_count;
    pages = result.total_pages;
  }
  const [open, closed] = await Promise.all([count("open"), count("closed")]);
  return { items, total, pages, open, closed };
}

/** People to offer in assignee / author pickers: the current user plus everyone visible in the loaded items. */
function knownPeople(items) {
  const people = new Map();
  if (state.user) people.set(state.user.login, state.user);
  for (const item of items) {
    people.set(item.user.login, item.user);
    for (const assignee of item.assignees ?? []) people.set(assignee.login, assignee);
  }
  return [...people.values()];
}

// ---------------------------------------------------------------------------------------------
// Issues / pull requests tab
// ---------------------------------------------------------------------------------------------

export async function renderListTab({ owner, repo: repoName, query, fresh, main, kind }) {
  const repo = await loadRepo(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const isIssues = kind === "issue";
  const defaultQuery = isIssues ? "is:issue is:open" : "is:pr is:open";
  const q = query.get("q") ?? defaultQuery;
  const page = Math.max(1, Number(query.get("page") ?? 1));
  const filter = parseListQuery(q, kind);
  repoCrumbs(repo, [{ text: isIssues ? "Issues" : "Pull requests", href: isIssues ? hrefs.issues(full) : hrefs.pulls(full), current: true }]);
  setRepoNav(repo, isIssues ? "issues" : "pulls");
  setTitle(`${isIssues ? "Issues" : "Pull requests"} · ${full}`);
  const go = (nextQuery, nextPage = 1) => navigate(isIssues ? hrefs.issues(full, { q: nextQuery === defaultQuery ? undefined : nextQuery, page: nextPage > 1 ? nextPage : undefined }) : hrefs.pulls(full, { q: nextQuery === defaultQuery ? undefined : nextQuery, page: nextPage > 1 ? nextPage : undefined }));

  const wrap = container();
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);
  const header = el("div", { class: "list-header" });
  const search = el("form", { class: "list-search", attrs: { role: "search" } });
  const input = el("input", { attrs: { type: "text", "aria-label": isIssues ? "Search all issues" : "Search all pull requests", placeholder: isIssues ? "Search all issues" : "Search all pull requests", autocomplete: "off" } });
  input.value = q;
  search.append(icon("search"), input);
  search.addEventListener("submit", (event) => {
    event.preventDefault();
    go(input.value.trim() || defaultQuery);
  });
  header.append(search);
  header.append(el("div", { class: "btn-group list-header-links" }, [button("Labels", { icon: "tag", onClick: () => navigate(hrefs.labels(full)) }), button("Milestones", { icon: "milestone", title: "Milestones (not simulated)", onClick: () => notSimulated("Milestones") })]));
  if (isIssues) header.append(button("New issue", { variant: "primary", disabled: repo.archived, title: repo.archived ? "This repository is archived" : undefined, onClick: () => navigate(hrefs.newIssue(full)) }));
  else header.append(button("New pull request", { variant: "primary", disabled: !repo.permissions?.push || repo.archived, title: repo.archived ? "This repository is archived" : !repo.permissions?.push ? "Write access required" : undefined, onClick: () => navigate(hrefs.compare(full)) }));
  wrap.append(header);
  const box = el("div", { class: "Box" });
  const headerHost = el("div");
  const rows = el("div", { attrs: { role: "list" } }, [loadingBlock()]);
  box.append(headerHost, rows);
  wrap.append(box);
  main.append(wrap);

  let result;
  try {
    result = await fetchList(owner, repoName, filter, page, kind);
  } catch (error) {
    if (!fresh()) return;
    clear(rows);
    if (error instanceof ToolError && (error.status === "invalid" || error.is("VALIDATION_FAILED"))) {
      flash(`This query is not supported here: ${error.message}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}`, "error", { sticky: true });
      rows.append(blankslate("search", "Unsupported search", "Supported qualifiers: is:, state:, label:, assignee:, author:, no:, in:, created:, updated:, closed:, comments:, sort: and plain words.", [button("Clear search", { onClick: () => go(defaultQuery) })]));
    } else rows.append(errorBlock(error, { retry: () => navigate(location.hash) }));
    return;
  }
  if (!fresh()) return;
  const labels = await loadLabels(owner, repoName).catch(() => []);
  if (!fresh()) return;
  const people = knownPeople(result.items);
  const filters = [
    filterMenuButton("Author", (anchor) =>
      openSelectPanel(anchor, {
        title: "Filter by author",
        placeholder: "Filter users",
        multiple: false,
        options: people.map((user) => ({ id: user.login, label: user.login, avatar: avatar(user, 20), selected: filter.author === user.login })),
        onSelect: (login) => go(rewriteQuery(q, "author", filter.author === login ? "" : login)),
      }),
    ),
    filterMenuButton("Labels", (anchor) =>
      openSelectPanel(anchor, {
        title: "Filter by label",
        placeholder: "Filter labels",
        options: labels.map((label) => ({ id: label.name, label: label.name, description: label.description ?? "", swatch: `#${label.color}`, selected: filter.labels.some((name) => name.toLowerCase() === label.name.toLowerCase()) })),
        onApply: (selected) => {
          let next = q;
          for (const label of labels) {
            const has = filter.labels.some((name) => name.toLowerCase() === label.name.toLowerCase());
            const wants = selected.includes(label.name);
            if (has !== wants) next = toggleQueryToken(next, "label", label.name);
          }
          if (next !== q) go(next);
        },
      }),
    ),
    filterMenuButton("Projects", () => notSimulated("Projects")),
    filterMenuButton("Milestones", () => notSimulated("Milestones")),
    ...(isIssues ? [filterMenuButton("Types", () => notSimulated("Issue types"))] : [filterMenuButton("Reviews", () => notSimulated("Filtering by review status"))]),
    filterMenuButton("Assignee", (anchor) =>
      openSelectPanel(anchor, {
        title: "Filter by who's assigned",
        placeholder: "Filter users",
        multiple: false,
        options: [{ id: "none", label: "Assigned to nobody", selected: filter.assignee === "none" }, ...people.map((user) => ({ id: user.login, label: user.login, avatar: avatar(user, 20), selected: filter.assignee === user.login }))],
        onSelect: (login) => go(login === "none" ? rewriteQuery(rewriteQuery(q, "assignee", ""), "no", filter.assignee === "none" ? "" : "assignee") : rewriteQuery(rewriteQuery(q, "no", ""), "assignee", filter.assignee === login ? "" : login)),
      }),
    ),
    filterMenuButton("Sort", (anchor) => openMenu(anchor, [{ header: "Sort by" }, ...SORTS.map((sort) => ({ label: sort.label, checked: filter.sortId === sort.id, onSelect: () => go(rewriteQuery(q, "sort", sort.id)) }))], { align: "end" })),
  ];
  clear(headerHost).append(listHeader({ open: result.open, closed: result.closed, current: filter.state, onState: (next) => go(setStateToken(q, next)), filters }));
  setNavCount(isIssues ? "issues" : "pulls", result.open);
  clear(rows);
  if (result.items.length === 0) {
    const cleared = q === defaultQuery;
    rows.append(blankslate(isIssues ? "issue-opened" : "git-pull-request", cleared ? (isIssues ? "Welcome to issues!" : "Welcome to pull requests!") : "No results matched your search.", cleared ? (isIssues ? "Issues are used to track todos, bugs, feature requests, and more. As issues are created, they'll appear here in a searchable and filterable list." : "Pull requests help you collaborate on code with other people. As pull requests are created, they'll appear here in a searchable and filterable list.") : "You could try an alternative filter or clear your search.", cleared ? [] : [button("Clear current search query, filters, and sorts", { onClick: () => go(defaultQuery) })]));
    return;
  }
  const reviewIcons = new Map();
  if (!isIssues) {
    await Promise.all(
      result.items.slice(0, PER_PAGE).map(async (item) => {
        try {
          const reviews = await pageAll((page) => call("pulls.read", { owner, repo: repoName, pullNumber: item.number, method: "get_reviews", ...page }), "reviews");
          const latest = new Map();
          for (const review of reviews.reviews) if (review.state !== "COMMENTED") latest.set(review.user.login, review.state);
          const states = [...latest.values()];
          if (states.includes("CHANGES_REQUESTED")) reviewIcons.set(item.number, el("span", { class: "review-status changes", title: "Changes requested" }, [icon("x-circle-fill")]));
          else if (states.includes("APPROVED")) reviewIcons.set(item.number, el("span", { class: "review-status approved", title: "Approved" }, [icon("check-circle-fill")]));
          else if (reviews.total_count > 0) reviewIcons.set(item.number, el("span", { class: "review-status", title: "Review comments" }, [icon("comment")]));
        } catch {
          /* review status is decorative */
        }
      }),
    );
    if (!fresh()) return;
  }
  for (const item of result.items) rows.append(issueRow(item, full, kind === "pr" || isPull(item) ? "pr" : "issue", { reviews: reviewIcons.get(item.number) }));
  const footer = pager({ page, perPage: PER_PAGE, total: result.total, totalPages: result.pages, onPage: (next) => go(q, next) });
  if (footer) rows.append(footer);
}

export const renderIssues = (args) => renderListTab({ ...args, kind: "issue" });

// ---------------------------------------------------------------------------------------------
// Discussion building blocks
// ---------------------------------------------------------------------------------------------

function associationBadge(association) {
  const text = { OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor" }[association];
  return text ? el("span", { class: "Label Label--secondary", text }) : null;
}

/** GitHub timeline comment box. `actions` are kebab-menu items; `onEdit(body)` enables in-place editing. */
export function commentBox({ user, association, createdAt, body, verb = "commented", onEdit, extraHeader, className = "" }) {
  const item = el("div", { class: "timeline-item" });
  item.append(el("div", { class: "timeline-avatar" }, [avatar(user, 40)]));
  const box = el("div", { class: `timeline-comment ${className}`.trim() });
  const header = el("div", { class: "timeline-comment-header" });
  header.append(userLink(user), ` ${verb} `, timeElement(createdAt));
  const actions = el("div", { class: "header-actions" });
  const badge = associationBadge(association);
  if (badge) actions.append(badge);
  if (extraHeader) actions.append(extraHeader);
  if (onEdit) {
    const kebab = iconButton("kebab-horizontal", "Show options", { class: "btn-sm" });
    kebab.addEventListener("click", () => openMenu(kebab, [{ label: "Edit", icon: "pencil", onSelect: () => startEdit() }, { label: "Copy text", icon: "copy", onSelect: () => navigator.clipboard?.writeText(body).catch(() => flash("Clipboard access is blocked.", "error")) }], { align: "end" }));
    actions.append(kebab);
  }
  header.append(actions);
  box.append(header);
  const content = el("div", { class: "comment-body" }, [markdown(body)]);
  box.append(content);
  item.append(box);
  const startEdit = () => {
    state.editing = true;
    clear(content);
    const textarea = el("textarea", { class: "form-control", attrs: { "aria-label": "Edit text" } });
    textarea.value = body;
    textarea.style.width = "100%";
    const errorHost = el("div", { class: "form-note color-fg-danger" });
    const footer = el("div", { class: "dialog-actions" });
    footer.append(
      button("Cancel", { onClick: () => {
        state.editing = false;
        clear(content).append(markdown(body));
      } }),
      button("Update comment", { variant: "primary", onClick: () => action(async () => {
        await onEdit(textarea.value);
        state.editing = false;
      }, { onError: (error) => (errorHost.textContent = describe(error)) }) }),
    );
    content.append(textarea, errorHost, footer);
    textarea.focus();
  };
  return item;
}

/** Timeline event row: "<user> <text> <time>" with a round badge icon. */
export function timelineEvent({ user, text, iconName, tone = "", when, className = "" }) {
  const row = el("div", { class: `timeline-event ${className}`.trim() });
  row.append(el("span", { class: `timeline-event-badge ${tone}`.trim() }, [icon(iconName)]));
  if (user) row.append(avatar(user, 20), userLink(user));
  row.append(el("span", { text: ` ${text} ` }));
  if (when) row.append(timeElement(when));
  return row;
}

/**
 * Comment form with Write / Preview tabs. `primary` = { label, onSubmit(text) }, `secondary` = element(s) placed
 * before the primary button (close / reopen controls), `locked` replaces the form with GitHub's lock notice.
 */
export function commentForm({ primary, secondary = [], placeholder = "Add your comment here...", locked = false, lockReason }) {
  if (locked) {
    return el("div", { class: "locked-notice" }, [icon("lock"), el("div", {}, [el("strong", { text: "This conversation has been locked and limited to collaborators." }), lockReason ? el("div", { class: "text-muted", text: lockReason }) : null])]);
  }
  const form = el("div", { class: "comment-form" });
  const tabs = el("div", { class: "comment-form-tabs", attrs: { role: "tablist" } });
  const write = el("button", { class: "comment-form-tab", text: "Write", attrs: { type: "button", role: "tab", "aria-selected": "true" } });
  const preview = el("button", { class: "comment-form-tab", text: "Preview", attrs: { type: "button", role: "tab", "aria-selected": "false" } });
  tabs.append(write, preview);
  form.append(tabs);
  const body = el("div", { class: "comment-form-body" });
  const textarea = el("textarea", { class: "form-control", attrs: { placeholder, "aria-label": "Comment body" } });
  const toolbar = markdownToolbar(textarea);
  tabs.append(toolbar);
  const previewHost = el("div", { class: "comment-form-preview" });
  previewHost.hidden = true;
  body.append(textarea, previewHost);
  form.append(body);
  write.addEventListener("click", () => {
    write.setAttribute("aria-selected", "true");
    preview.setAttribute("aria-selected", "false");
    previewHost.hidden = true;
    textarea.hidden = false;
    toolbar.hidden = false;
  });
  preview.addEventListener("click", () => {
    preview.setAttribute("aria-selected", "true");
    write.setAttribute("aria-selected", "false");
    clear(previewHost).append(textarea.value.trim() ? markdown(textarea.value) : el("p", { class: "text-muted", text: "Nothing to preview" }));
    textarea.hidden = true;
    toolbar.hidden = true;
    previewHost.hidden = false;
  });
  textarea.addEventListener("input", () => {
    state.editing = textarea.value.length > 0;
    form.dispatchEvent(new CustomEvent("comment-input", { detail: textarea.value }));
  });
  const footer = el("div", { class: "comment-form-footer" });
  footer.append(el("span", { class: "markdown-hint", text: "Markdown is supported (headings, lists, code, emphasis)." }));
  for (const control of secondary) footer.append(control);
  const submit = button(primary.label, { variant: "primary", disabled: true });
  footer.append(submit);
  form.append(footer);
  textarea.addEventListener("input", () => (submit.disabled = textarea.value.trim().length === 0));
  submit.addEventListener("click", () =>
    action(async () => {
      await primary.onSubmit(textarea.value);
      textarea.value = "";
      state.editing = false;
      submit.disabled = true;
    }),
  );
  textarea.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !submit.disabled) submit.click();
  });
  form.textarea = textarea;
  return form;
}

export function sidebarSection(title, { onGear, gearLabel = `Edit ${title}` } = {}, children = []) {
  const section = el("div", { class: "discussion-sidebar-item" });
  const heading = el("div", { class: "discussion-sidebar-heading" });
  heading.append(el("span", { text: title }));
  if (onGear) heading.append(iconButton("gear", gearLabel, { class: "btn-sm", onClick: (event) => onGear(event.currentTarget) }));
  section.append(heading);
  for (const child of children) if (child) section.append(child);
  return section;
}

/** Assignees sidebar block for an issue or pull request view. `onSet(logins)` writes the full set. */
export function assigneesSection(item, repo, people, onSet) {
  const assignees = item.assignees ?? [];
  const list = el("div", { class: "sidebar-people" });
  if (assignees.length === 0) {
    const none = el("span", { class: "sidebar-none", text: "No one" });
    if (canTriage(repo) && state.user && !repo.archived) {
      const self = el("button", { class: "sidebar-self-assign", text: "assign yourself", attrs: { type: "button" } });
      self.addEventListener("click", () => action(() => onSet([state.user.login])));
      none.append("—", self);
    }
    list.append(none);
  }
  for (const assignee of assignees) list.append(el("a", { class: "sidebar-person", href: hrefs.user(assignee.login) }, [avatar(assignee, 20), el("span", { text: assignee.login })]));
  return sidebarSection("Assignees", {
    onGear: canTriage(repo)
      ? (anchor) =>
          openSelectPanel(anchor, {
            title: "Assign up to 10 people to this item",
            placeholder: "Type or choose a user",
            options: people.map((user) => ({ id: user.login, label: user.login, avatar: avatar(user, 20), selected: assignees.some((assignee) => assignee.login === user.login) })),
            onApply: (selected) => {
              const current = assignees.map((assignee) => assignee.login).sort().join(",");
              if (current !== [...selected].sort().join(",")) void action(() => onSet(selected));
            },
            footer: el("span", { text: "Collaborators of this repository can be assigned." }),
          })
      : undefined,
  }, [list]);
}

/** Labels sidebar block. `onSet(names)` writes the full label set. */
export function labelsSection(item, repo, labels, onSet) {
  const current = item.labels ?? [];
  const chips = el("div", { class: "sidebar-labels" });
  if (current.length === 0) chips.append(el("span", { class: "text-muted", text: "None yet" }));
  for (const label of current) chips.append(labelChip(label));
  return sidebarSection("Labels", {
    onGear: canTriage(repo)
      ? (anchor) =>
          openSelectPanel(anchor, {
            title: "Apply labels to this item",
            placeholder: "Filter labels",
            options: labels.map((label) => ({ id: label.name, label: label.name, description: label.description ?? "", swatch: `#${label.color}`, selected: current.some((entry) => entry.name.toLowerCase() === label.name.toLowerCase()) })),
            onApply: (selected) => {
              const before = current.map((label) => label.name.toLowerCase()).sort().join(",");
              if (before !== selected.map((name) => name.toLowerCase()).sort().join(",")) void action(() => onSet(selected));
            },
            emptyText: "No labels match",
          })
      : undefined,
  }, [chips]);
}

export function participantsSection(users) {
  const list = el("div", { class: "participants" });
  for (const user of users) list.append(avatar(user, 24));
  return sidebarSection(plural(users.length, "participant"), {}, [list]);
}

// ---------------------------------------------------------------------------------------------
// New issue
// ---------------------------------------------------------------------------------------------

export async function renderNewIssue({ owner, repo: repoName, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const labels = await loadLabels(owner, repoName).catch(() => []);
  if (!fresh()) return;
  const full = repo.full_name;
  repoCrumbs(repo, [{ text: "Issues", href: hrefs.issues(full) }, { text: "New issue", href: hrefs.newIssue(full), current: true }]);
  setRepoNav(repo, "issues");
  setTitle(`New issue · ${full}`);
  const wrap = container();
  main.append(wrap);
  if (repo.archived) {
    wrap.append(archivedBanner(repo), blankslate("lock", "This repository is archived", "Issues cannot be created in a read-only repository.", [button("Back to issues", { onClick: () => navigate(hrefs.issues(full)) })]));
    return;
  }
  const layout = el("div", { class: "Layout" });
  const mainCol = el("div", { class: "Layout-main" });
  const side = el("div", { class: "Layout-sidebar discussion-sidebar" });
  layout.append(mainCol, side);
  wrap.append(layout);
  const form = el("form", { class: "new-item-form" });
  form.append(el("h1", { text: "Create new issue" }));
  const title = el("input", { class: "form-control new-title", attrs: { type: "text", placeholder: "Add a title", "aria-label": "Add a title", required: "", maxlength: "256" } });
  const body = el("textarea", { class: "form-control new-body", attrs: { placeholder: "Add a description", "aria-label": "Add a description" } });
  const errorHost = el("div", { class: "form-note color-fg-danger" });
  form.append(el("div", { class: "form-group" }, [el("label", { class: "form-label", text: "Add a title" }), title]), el("div", { class: "form-group" }, [el("label", { class: "form-label", text: "Add a description" }), markdownEditor(body), el("p", { class: "form-hint", text: "Markdown is supported (headings, lists, code, emphasis)." })]), errorHost);
  const actions = el("div", { class: "form-actions" });
  const cancel = button("Cancel", { onClick: () => navigate(hrefs.issues(full)) });
  const submit = button("Create", { variant: "primary", type: "submit", disabled: true });
  actions.append(cancel, submit);
  form.append(actions);
  mainCol.append(form);
  title.addEventListener("input", () => {
    state.editing = true;
    submit.disabled = title.value.trim().length === 0;
  });
  body.addEventListener("input", () => (state.editing = true));

  const draft = { assignees: [], labels: [] };
  const people = state.user ? [state.user] : [];
  const renderSide = () => {
    clear(side);
    side.append(assigneesSection({ assignees: draft.assignees.map((login) => ({ login })) }, repo, people, async (logins) => {
      draft.assignees = logins;
      renderSide();
    }));
    side.append(labelsSection({ labels: labels.filter((label) => draft.labels.includes(label.name)) }, repo, labels, async (names) => {
      draft.labels = names;
      renderSide();
    }));
    side.append(notSimulatedSidebarItem("Type", "Issue types", "No type"), notSimulatedSidebarItem("Projects", "Projects", "No projects"), notSimulatedSidebarItem("Milestone", "Milestones", "No milestone"));
  };
  renderSide();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void action(
      async () => {
        const issue = await call("issues.write", { owner, repo: repoName, method: "create", title: title.value.trim(), body: body.value, labels: draft.labels.length ? draft.labels : undefined, assignees: draft.assignees.length ? draft.assignees : undefined }, key());
        state.editing = false;
        navigate(hrefs.issue(full, issue.number));
      },
      { onError: (error) => (errorHost.textContent = `${describe(error)}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}`) },
    );
  });
  title.focus();
}

// ---------------------------------------------------------------------------------------------
// Issue page
// ---------------------------------------------------------------------------------------------

export async function renderIssue({ owner, repo: repoName, number, query, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  const page = Math.max(1, Number(query.get("page") ?? 1));
  repoCrumbs(repo, [{ text: "Issues", href: hrefs.issues(full) }, { text: `#${number}`, href: hrefs.issue(full, number), current: true }]);
  setRepoNav(repo, "issues");
  const wrap = container();
  wrap.append(loadingBlock());
  main.append(wrap);
  let issue;
  let comments;
  try {
    issue = await call("issues.read", { owner, repo: repoName, issue_number: number, method: "get" });
    if (isPull(issue)) {
      navigate(hrefs.pull(full, number));
      return;
    }
    comments = await call("issues.read", { owner, repo: repoName, issue_number: number, method: "get_comments", perPage: 30, page });
  } catch (error) {
    if (!fresh()) return;
    clear(wrap).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  const labels = await loadLabels(owner, repoName).catch(() => []);
  if (!fresh()) return;
  setTitle(`${issue.title} · Issue #${number} · ${full}`);
  clear(wrap);
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);
  const reload = () => navigate(location.hash);
  const own = state.user && issue.user.login === state.user.login;
  const mayEdit = !repo.archived && (own || canTriage(repo));
  const update = (patch) => call("issues.write", { owner, repo: repoName, method: "update", issue_number: number, ...patch }, key());

  // Header
  const header = el("div", { class: "gh-header" });
  const titleRow = el("div", { class: "gh-header-title" });
  const h1 = el("h1", {}, [el("span", { text: issue.title }), " ", el("span", { class: "issue-number", text: `#${issue.number}` })]);
  const headerActions = el("div", { class: "gh-header-actions" });
  const editForm = el("div", { class: "gh-header-edit" });
  editForm.hidden = true;
  if (mayEdit) {
    headerActions.append(button("Edit", { onClick: () => {
      h1.hidden = true;
      headerActions.hidden = true;
      editForm.hidden = false;
      editForm.querySelector("input").focus();
      state.editing = true;
    } }));
    const titleInput = el("input", { class: "form-control", attrs: { type: "text", "aria-label": "Title" } });
    titleInput.value = issue.title;
    const save = button("Save", { variant: "primary", onClick: () => action(async () => {
      if (titleInput.value.trim() && titleInput.value.trim() !== issue.title) await update({ title: titleInput.value.trim() });
      state.editing = false;
      reload();
    }) });
    const cancel = button("Cancel", { onClick: () => {
      state.editing = false;
      editForm.hidden = true;
      h1.hidden = false;
      headerActions.hidden = false;
    } });
    editForm.append(titleInput, save, cancel);
  }
  if (!repo.archived) headerActions.append(button("New issue", { variant: "primary", onClick: () => navigate(hrefs.newIssue(full)) }));
  titleRow.append(h1, editForm, headerActions);
  header.append(titleRow);
  const meta = el("div", { class: "gh-header-meta" });
  const badge = el("span", { class: `State ${issue.state === "open" ? "State--open" : issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "State--draft" : "State--done"}` });
  badge.append(icon(issue.state === "open" ? "issue-opened" : issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "skip" : "issue-closed"), el("span", { text: issue.state === "open" ? "Open" : issue.state_reason === "not_planned" ? "Closed as not planned" : issue.state_reason === "duplicate" ? "Closed as duplicate" : "Closed" }));
  meta.append(badge);
  meta.append(el("span", {}, [userLink(issue.user), ` opened this issue `, timeElement(issue.created_at), ` · ${plural(issue.comments, "comment")}`]));
  header.append(meta);
  wrap.append(header);

  // Layout
  const layout = el("div", { class: "Layout" });
  const mainCol = el("div", { class: "Layout-main" });
  const side = el("div", { class: "Layout-sidebar discussion-sidebar" });
  layout.append(mainCol, side);
  wrap.append(layout);
  const timeline = el("div", { class: "timeline" });
  timeline.append(commentBox({ user: issue.user, association: issue.author_association, createdAt: issue.created_at, body: issue.body || "", verb: "opened this issue", onEdit: mayEdit ? async (text) => {
    await update({ body: text });
    reload();
  } : undefined }));
  for (const comment of comments.comments) {
    const ownComment = state.user && comment.user.login === state.user.login;
    timeline.append(commentBox({ user: comment.user, association: comment.author_association, createdAt: comment.created_at, body: comment.body, onEdit: ownComment && !repo.archived ? undefined : undefined }));
  }
  if (comments.total_count > 30 || (comments.total_pages ?? 1) > 1 || page > 1) {
    const footer = pager({ page, perPage: 30, total: comments.total_count, totalPages: comments.total_pages, labels: ["Newer comments", "Older comments"], onPage: (next) => navigate(`${hrefs.issue(full, number)}?page=${next}`) });
    if (footer) timeline.append(footer);
  }
  if (issue.state === "closed") {
    const closer = issue.closed_by ?? issue.user;
    timeline.append(timelineEvent({ user: closer, text: issue.state_reason === "not_planned" ? "closed this as not planned" : issue.state_reason === "duplicate" ? "closed this as a duplicate" : "closed this as completed", iconName: issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "skip" : "issue-closed", tone: issue.state_reason === "not_planned" || issue.state_reason === "duplicate" ? "" : "done", when: issue.closed_at }));
  }
  if (issue.locked) timeline.append(timelineEvent({ text: `locked this conversation${issue.active_lock_reason ? ` as ${issue.active_lock_reason}` : ""}`, iconName: "lock" }));
  mainCol.append(timeline);

  // Comment form with close / reopen controls
  const locked = issue.locked && !canTriage(repo);
  if (!repo.archived) {
    const controls = [];
    let pendingText = "";
    let updateCloseLabel;
    if (issue.state === "open") {
      const closeButton = button("Close issue", { icon: "issue-closed", class: "close-button" });
      const closeCaret = button("", { trailingIcon: "triangle-down", class: "btn-caret", ariaLabel: "Choose a close reason" });
      const closeAs = (reason, label) => action(async () => {
        if (!(await confirmDialog(label, `This issue will be ${label.toLowerCase().replace("close ", "closed ")}. You can reopen it later.`, label))) return;
        if (pendingText.trim()) await call("issues.add-comment", { owner, repo: repoName, issue_number: number, body: pendingText }, key());
        await update({ state: "closed", state_reason: reason });
        state.editing = false;
        flash("Issue closed.", "success");
        reload();
      });
      closeButton.addEventListener("click", () => closeAs("completed", pendingText.trim() ? "Close with comment" : "Close issue"));
      closeCaret.addEventListener("click", () => openMenu(closeCaret, [{ label: "Close as completed", description: "Done, closed, fixed, resolved", icon: "issue-closed", onSelect: () => closeAs("completed", "Close as completed") }, { label: "Close as not planned", description: "Won't fix, can't repro, duplicate, stale", icon: "skip", onSelect: () => closeAs("not_planned", "Close as not planned") }, { label: "Close as duplicate", description: "Already tracked in another issue", icon: "skip", onSelect: () => closeAs("duplicate", "Close as duplicate") }], { align: "end", width: 300 }));
      const group = el("div", { class: "btn-group" }, [closeButton, closeCaret]);
      if (mayEdit) controls.push(group);
      updateCloseLabel = (text) => {
        pendingText = text;
        closeButton.querySelector(".btn-label").textContent = text.trim() ? "Close with comment" : "Close issue";
      };
    } else if (mayEdit) {
      controls.push(button("Reopen issue", { icon: "issue-opened", onClick: () => action(async () => {
        if (pendingText.trim()) await call("issues.add-comment", { owner, repo: repoName, issue_number: number, body: pendingText }, key());
        await update({ state: "open" });
        state.editing = false;
        flash("Issue reopened.", "success");
        reload();
      }) }));
      updateCloseLabel = (text) => (pendingText = text);
    }
    const form = commentForm({
      primary: { label: "Comment", onSubmit: async (text) => {
        await call("issues.add-comment", { owner, repo: repoName, issue_number: number, body: text }, key());
        flash("Comment added.", "success");
        reload();
      } },
      secondary: controls,
      locked,
      lockReason: issue.active_lock_reason ? `Reason: ${issue.active_lock_reason}` : undefined,
    });
    if (!locked && updateCloseLabel) form.addEventListener("comment-input", (event) => updateCloseLabel(event.detail));
    mainCol.append(form);
  }

  // Sidebar
  const people = [...new Map([...(state.user ? [state.user] : []), issue.user, ...issue.assignees, ...comments.comments.map((comment) => comment.user)].map((user) => [user.login, user])).values()];
  side.append(assigneesSection(issue, repo, people, async (logins) => {
    await update({ assignees: logins });
    flash("Assignees updated.", "success");
    reload();
  }));
  side.append(labelsSection(issue, repo, labels, async (names) => {
    await update({ labels: names });
    flash("Labels updated.", "success");
    reload();
  }));
  side.append(notSimulatedSidebarItem("Type", "Issue types", "Not simulated"));
  side.append(...chromeSidebarItems(true));
  side.append(participantsSection([...new Map([issue.user, ...comments.comments.map((comment) => comment.user)].map((user) => [user.login, user])).values()]));
}

// ---------------------------------------------------------------------------------------------
// Labels page
// ---------------------------------------------------------------------------------------------

export async function renderLabels({ owner, repo: repoName, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  const labels = await loadLabels(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  repoCrumbs(repo, [{ text: "Labels", href: hrefs.labels(full), current: true }]);
  setRepoNav(repo, "issues");
  setTitle(`Labels · ${full}`);
  const wrap = container();
  const header = el("div", { class: "list-header" });
  header.append(el("div", { class: "btn-group" }, [button("Labels", { icon: "tag", class: "btn-selected" }), button("Milestones", { icon: "milestone", disabled: true, title: "Milestones are not part of this Tool" })]));
  wrap.append(header);
  const box = el("div", { class: "Box labels-list" });
  box.append(el("div", { class: "Box-header" }, [el("span", { class: "Box-title", text: plural(labels.length, "label") })]));
  if (labels.length === 0) box.append(blankslate("tag", "No labels", "This repository has no labels."));
  const rows = new Map();
  for (const label of labels) {
    const row = el("div", { class: "Box-row" });
    row.append(el("div", { class: "label-cell" }, [labelChip(label)]));
    row.append(el("div", { class: "label-description", text: label.description ?? "" }));
    const count = el("div", { class: "label-count" }, [el("span", { class: "skeleton skeleton-inline skeleton-80" })]);
    row.append(count);
    rows.set(label.name, count);
    box.append(row);
  }
  wrap.append(box);
  main.append(wrap);
  for (const label of labels) {
    try {
      const result = await call("issues.list", { owner, repo: repoName, state: "open", labels: [label.name], perPage: 1 });
      if (!fresh()) return;
      clear(rows.get(label.name)).append(el("a", { text: `${result.total_count} open issue${result.total_count === 1 ? "" : "s"}`, href: hrefs.issues(full, { q: `is:issue is:open label:${/\s/.test(label.name) ? `"${label.name}"` : label.name}` }) }));
    } catch (error) {
      if (!fresh()) return;
      clear(rows.get(label.name)).append(el("span", { class: "text-muted", text: describe(error) }));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Global search (`#/search?q=`) and "Your issues" / "Your pull requests"
// ---------------------------------------------------------------------------------------------

export async function renderSearch(main, query, fresh) {
  const q = query.get("q") ?? "";
  const scope = query.get("scope");
  const page = Math.max(1, Number(query.get("page") ?? 1));
  const sortId = query.get("sort") ?? "";
  setCrumbs([{ text: scope === "issues" ? "Your issues" : scope === "pulls" ? "Your pull requests" : "Search", href: location.hash, current: true }]);
  setRepoNav(undefined);
  setTitle(scope === "issues" ? "Your issues" : scope === "pulls" ? "Your pull requests" : q ? `Search · ${q}` : "Search");
  $("#global-search").value = scope ? "" : q;
  const wrap = container();
  const header = el("div", { class: "list-header" });
  const form = el("form", { class: "list-search", attrs: { role: "search" } });
  const input = el("input", { attrs: { type: "text", placeholder: "Search issues and pull requests", "aria-label": "Search", autocomplete: "off" } });
  input.value = q;
  form.append(icon("search"), input);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    navigate(hrefs.search(input.value.trim()));
  });
  header.append(form);
  const searchHref = (params) => withQuery("#/search", { q, ...params });
  const sortButton = filterMenuButton("Sort", (anchor) => openMenu(anchor, [{ header: "Sort by" }, { label: "Best match", checked: sortId === "", onSelect: () => navigate(searchHref({})) }, ...["created-desc", "created-asc", "updated-desc", "updated-asc", "comments-desc"].map((id) => ({ label: SORTS.find((sort) => sort.id === id).label, checked: sortId === id, onSelect: () => navigate(searchHref({ sort: id })) }))], { align: "end" }));
  header.append(sortButton);
  wrap.append(header);
  const box = el("div", { class: "Box" });
  const boxHeader = el("div", { class: "Box-header" }, [el("span", { class: "Box-title", text: "Searching…" })]);
  const rows = el("div", { attrs: { role: "list" } }, [loadingBlock()]);
  box.append(boxHeader, rows);
  wrap.append(box);
  main.append(wrap);
  if (!q.trim()) {
    clear(rows).append(blankslate("search", "Search issues and pull requests", "Try is:issue is:open, author:@me, label:bug or plain words. Results span every repository you can see."));
    boxHeader.querySelector(".Box-title").textContent = "No query";
    return;
  }
  let result;
  try {
    const sort = SORTS.find((entry) => entry.id === sortId);
    result = await call("issues.search", { query: q, sort: sort?.sort, order: sort?.direction, perPage: PER_PAGE, page });
  } catch (error) {
    if (!fresh()) return;
    clear(rows);
    boxHeader.querySelector(".Box-title").textContent = "Search failed";
    if (error instanceof ToolError && (error.status === "invalid" || error.is("VALIDATION_FAILED"))) {
      flash(`${error.message}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}`, "error", { sticky: true });
      rows.append(blankslate("search", "Unsupported search", "Supported qualifiers: repo:, is:, state:, type:, label:, assignee:, author:, no:, in:, created:, updated:, closed:, comments:, and plain words (negation with - for author/assignee/label)."));
    } else rows.append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  boxHeader.querySelector(".Box-title").textContent = `${result.total_count.toLocaleString("en-US")} result${result.total_count === 1 ? "" : "s"}`;
  clear(rows);
  if (result.items.length === 0) {
    rows.append(blankslate("search", "Your search did not match any issues or pull requests", "Try a broader query, or another repository."));
    return;
  }
  for (const item of result.items) {
    const full = item.repository_url.split("/repos/")[1];
    rows.append(issueRow(item, full, isPull(item) ? "pr" : "issue", { showRepo: true }));
  }
  const footer = pager({ page, perPage: PER_PAGE, total: result.total_count, totalPages: result.total_pages, onPage: (next) => navigate(searchHref({ page: next > 1 ? next : undefined, sort: sortId || undefined })) });
  if (footer) rows.append(footer);
}
