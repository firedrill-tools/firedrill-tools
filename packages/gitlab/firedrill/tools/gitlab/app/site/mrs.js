// Merge requests: project list, dashboard list, new merge request and the merge request page with its tabs.
import { ToolError, action, alert, avatar, badge, button, call, clear, confirmModal, copyText, describe, el, icon, iconButton, markdown, newKey, openListbox, openMenu, openModal, pageAll, plural, timeElement, toast } from "./ui.js";
import { PER_PAGE, canDevelop, copyButton, emptyState, filteredSearch, hrefs, loadBranches, loadLabels, navigate, notSimulated, pagination, projectCrumbs, setBreadcrumbs, setTitle, skeletonRows, sortControl, state, stateBadge, stateTabs, userLink } from "./shell.js";
import { activityControls, activityPreference, commentForm, issuableRow, labelTokenOptions, labelsValue, markdownField, mutedBlock, participantsBlock, peopleValue, pickLabels, pickUsers, referenceBlock, saveActivityPreference, showFormError, sidebarBlock, timeline, userTokenOptions } from "./issuable.js";
import { commitList, diffFile, diffStats } from "./projects.js";

const stale = (token) => token !== state.navigation;
const refresh = () => navigate(location.hash);
const SORTS = [
  { value: "created_at", label: "Created date" },
  { value: "updated_at", label: "Updated date" },
  { value: "title", label: "Title" },
];

function refChip(project, name, { link = true } = {}) {
  const chip = el(link ? "a" : "span", { class: "ref-container", href: link ? hrefs.tree(project.path_with_namespace, name) : undefined, text: name, title: name });
  return chip;
}

// ---------------------------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------------------------

export async function renderMrs(main, route, project, token) {
  const path = project.path_with_namespace;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Merge requests", href: hrefs.mrs(path) }]));
  setTitle(["Merge requests", project.name_with_namespace]);
  if (!project.merge_requests_enabled) {
    clear(main).append(el("div", { class: "page-padded" }, [emptyState("Merge requests are turned off", "The Merge requests feature is disabled for this project.")]));
    return;
  }
  const query = route.query;
  const stateValue = ["opened", "merged", "closed", "all"].includes(query.get("state")) ? query.get("state") : "opened";
  const search = query.get("search") ?? "";
  const sort = SORTS.some((option) => option.value === query.get("sort")) ? query.get("sort") : "created_at";
  const direction = query.get("direction") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const filters = {};
  for (const name of ["author_username", "assignee_username", "reviewer_username", "label_name", "draft", "target_branch", "source_branch"]) if (query.get(name)) filters[name] = query.get(name);
  const base = { search, sort: sort === "created_at" ? "" : sort, direction: direction === "desc" ? "" : direction, ...filters };
  const hrefFor = (params) => hrefs.mrs(path, { state: stateValue === "opened" ? "" : stateValue, ...base, page: "", ...params });
  const container = el("div", { class: "page-padded mrs-list-page" });
  const tabBar = stateTabs(
    [
      { id: "opened", label: "Open", href: hrefFor({ state: "" }) },
      { id: "merged", label: "Merged", href: hrefFor({ state: "merged" }) },
      { id: "closed", label: "Closed", href: hrefFor({ state: "closed" }) },
      { id: "all", label: "All", href: hrefFor({ state: "all" }) },
    ],
    stateValue,
    [
      button("Bulk edit", { disabled: !canDevelop(project), onClick: () => notSimulated("Bulk editing merge requests") }),
      button("New merge request", { variant: "confirm", disabled: !canDevelop(project), onClick: () => navigate(hrefs.newMr(path)) }),
      iconButton("ellipsis_v", "Actions", { variant: "default", onClick: (event) => openMenu(event.currentTarget, [{ label: "Export as CSV", onSelect: () => notSimulated("CSV export") }, { label: "Email a new merge request to this project", onSelect: () => notSimulated("Incoming email") }], { align: "end", width: 280 }) }),
    ],
  );
  const branchOptions = async () => (await loadBranches(project)).map((branch) => ({ value: branch.name, label: branch.name }));
  const tokens = [
    { type: "assignee_username", title: "Assignee", icon: "user", options: userTokenOptions(project), display: (value) => `@${value}`, freeText: true },
    { type: "author_username", title: "Author", icon: "pencil", options: userTokenOptions(project), display: (value) => `@${value}`, freeText: true },
    { type: "draft", title: "Draft", icon: "pencil", options: async () => [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], display: (value) => (value === "yes" ? "Yes" : "No") },
    { type: "label_name", title: "Label", icon: "label", options: labelTokenOptions(project), display: (value) => `~${value}` },
    { type: "reviewer_username", title: "Reviewer", icon: "user", options: userTokenOptions(project), display: (value) => `@${value}`, freeText: true },
    { type: "source_branch", title: "Source branch", icon: "branch", options: branchOptions },
    { type: "target_branch", title: "Target branch", icon: "arrow-right", options: branchOptions },
  ];
  const toolbar = el("div", { class: "filtered-search-block" }, [
    filteredSearch({ tokens, values: filters, search, onSubmit: ({ values, search: text }) => navigate(hrefs.mrs(path, { state: stateValue === "opened" ? "" : stateValue, sort: base.sort, direction: base.direction, ...values, search: text })) }),
    sortControl({ options: SORTS, value: sort, direction, onChange: (value, dir) => navigate(hrefFor({ sort: value === "created_at" ? "" : value, direction: dir === "desc" ? "" : dir })) }),
  ]);
  const host = el("div", {}, [skeletonRows(5)]);
  container.append(tabBar, toolbar, host);
  clear(main).append(container);
  const args = { id: project.id, ...(search ? { search } : {}), order_by: sort, sort: direction };
  for (const [name, value] of Object.entries(filters)) {
    if (name === "label_name") args.labels = value;
    else args[name] = value;
  }
  const [result, labels] = await Promise.all([call("merge-requests.list", { ...args, state: stateValue, page, per_page: PER_PAGE }), loadLabels(project).catch(() => [])]);
  if (stale(token)) return;
  void Promise.all(["opened", "merged", "closed", "all"].map((name) => (name === stateValue ? Promise.resolve(result.page?.total) : call("merge-requests.list", { ...args, state: name, per_page: 1 }).then((value) => value.page?.total).catch(() => undefined)))).then((counts) => {
    if (stale(token)) return;
    tabBar.querySelectorAll(".gl-tab-nav-item").forEach((anchor, index) => {
      if (counts[index] !== undefined) anchor.append(el("span", { class: "gl-badge badge-neutral badge-sm gl-tab-counter-badge", text: String(counts[index]) }));
    });
  });
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  clear(host);
  if (result.items.length === 0) {
    const filtered = search || Object.keys(filters).length > 0;
    host.append(filtered ? emptyState("Sorry, your filter produced no results", "To widen your search, change or remove filters above") : emptyState(stateValue === "merged" ? "There are no merged merge requests" : stateValue === "closed" ? "There are no closed merge requests" : "There are no open merge requests", "Merge requests are a place to propose changes you've made to a project and discuss those changes with others", canDevelop(project) ? [button("New merge request", { variant: "confirm", onClick: () => navigate(hrefs.newMr(path)) })] : [], { iconName: "merge-request" }));
    return;
  }
  const ul = el("ul", { class: "content-list issuable-list mr-list" });
  for (const mr of result.items) ul.append(issuableRow(mr, "mr", project, labelsByName));
  host.append(ul, pagination(result.page, (target) => hrefFor({ page: target })) ?? "");
}

export async function renderDashboardMrs(main, route, token) {
  setBreadcrumbs([{ text: "Your work", href: "#/" }, { text: "Merge requests", href: hrefs.dashboard("merge_requests") }]);
  setTitle(["Merge requests"]);
  const query = route.query;
  const stateValue = ["opened", "merged", "closed", "all"].includes(query.get("state")) ? query.get("state") : "opened";
  const assignee = query.get("assignee") ?? "";
  const reviewer = query.get("reviewer") ?? "";
  const author = query.get("author") ?? "";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const hrefFor = (params) => hrefs.dashboard("merge_requests", { state: stateValue === "opened" ? "" : stateValue, assignee, reviewer, author, page: "", ...params });
  const container = el("div", { class: "page-padded" }, [el("div", { class: "page-heading-row" }, [el("h1", { class: "page-heading", text: "Merge requests" })])]);
  const tabBar = stateTabs([{ id: "opened", label: "Open", href: hrefFor({ state: "" }) }, { id: "merged", label: "Merged", href: hrefFor({ state: "merged" }) }, { id: "closed", label: "Closed", href: hrefFor({ state: "closed" }) }, { id: "all", label: "All", href: hrefFor({ state: "all" }) }], stateValue);
  const me = async () => (state.user ? [{ value: state.user.username, label: state.user.name, avatar: avatar(state.user, 16) }] : []);
  const tokens = [
    { type: "assignee", title: "Assignee", icon: "user", options: me, display: (value) => `@${value}`, freeText: true },
    { type: "reviewer", title: "Reviewer", icon: "user", options: me, display: (value) => `@${value}`, freeText: true },
    { type: "author", title: "Author", icon: "pencil", options: me, display: (value) => `@${value}`, freeText: true },
  ];
  container.append(tabBar, el("div", { class: "filtered-search-block" }, [filteredSearch({ tokens, values: { assignee, reviewer, author }, search: "", placeholder: "Filter results", onSubmit: ({ values }) => navigate(hrefs.dashboard("merge_requests", { state: stateValue === "opened" ? "" : stateValue, ...values })) })]));
  const host = el("div", {}, [skeletonRows(5)]);
  container.append(host);
  clear(main).append(container);
  if (!assignee && !reviewer && !author) {
    clear(host).append(emptyState("Please select at least one filter to see results", "Filter by assignee, reviewer or author to list merge requests across your projects.", state.user ? [el("a", { class: "gl-button btn-confirm btn-md", href: hrefFor({ assignee: state.user.username }), text: "Assigned to you" }), el("a", { class: "gl-button btn-default btn-md", href: hrefFor({ reviewer: state.user.username }), text: "Review requests for you" })] : []));
    return;
  }
  const projects = await pageAll((p) => call("projects.list", { membership: true, ...p }));
  const failures = [];
  const lists = await Promise.all(
    projects.filter((project) => project.merge_requests_enabled).map(async (project) => {
      const items = await pageAll((p) => call("merge-requests.list", { id: project.id, state: stateValue, ...(assignee ? { assignee_username: assignee } : {}), ...(reviewer ? { reviewer_username: reviewer } : {}), ...(author ? { author_username: author } : {}), ...p })).catch((error) => { failures.push(`${project.name_with_namespace}: ${describe(error)}`); return []; });
      const labels = items.length ? await pageAll((p) => call("labels.list", { id: project.id, ...p })).catch(() => []) : [];
      return { project, items, labels: new Map(labels.map((label) => [label.name, label])) };
    }),
  );
  if (stale(token)) return;
  const rows = lists.flatMap(({ project, items, labels }) => items.map((item) => ({ project, item, labels }))).sort((a, b) => b.item.updated_at.localeCompare(a.item.updated_at));
  tabBar.querySelector(".gl-tab-nav-item-active")?.append(el("span", { class: "gl-badge badge-neutral badge-sm gl-tab-counter-badge", text: String(rows.length) }));
  clear(host);
  // A project whose list could not be read (or is longer than the app pages through) is named, never silently left out.
  if (failures.length) host.append(alert(failures.join(" · "), "warning", { title: `Results from ${failures.length === 1 ? "1 project" : `${failures.length} projects`} could not be loaded` }));
  if (rows.length === 0) {
    host.append(emptyState("Sorry, your filter produced no results", "To widen your search, change or remove filters above"));
    return;
  }
  const totalPages = Math.ceil(rows.length / PER_PAGE);
  const current = Math.min(page, totalPages);
  const ul = el("ul", { class: "content-list issuable-list mr-list" });
  for (const { project, item, labels } of rows.slice((current - 1) * PER_PAGE, current * PER_PAGE)) ul.append(issuableRow(item, "mr", project, labels, { showProject: true }));
  host.append(ul, pagination({ page: current, next_page: current < totalPages ? current + 1 : null, prev_page: current > 1 ? current - 1 : null, total_pages: totalPages }, (target) => hrefFor({ page: target })) ?? "");
}

// ---------------------------------------------------------------------------------------------
// New merge request
// ---------------------------------------------------------------------------------------------

export async function renderNewMr(main, route, project, token) {
  const path = project.path_with_namespace;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Merge requests", href: hrefs.mrs(path) }, { text: "New", href: hrefs.newMr(path) }]));
  setTitle(["New merge request", project.name_with_namespace]);
  const branches = await loadBranches(project);
  if (stale(token)) return;
  const source = route.query.get("source_branch") ?? "";
  const target = route.query.get("target_branch") ?? project.default_branch ?? "main";
  const sourceBranch = branches.find((branch) => branch.name === source);
  const targetBranch = branches.find((branch) => branch.name === target);
  const container = el("div", { class: "page-padded issuable-form-page new-mr-page" });
  if (!canDevelop(project)) container.append(alert("You need at least the Developer role to open merge requests in this project.", "warning"));
  if (!sourceBranch || !targetBranch || route.query.get("change") === "1") {
    // Step 1: compare branches
    let chosenSource = sourceBranch?.name ?? "";
    let chosenTarget = targetBranch?.name ?? project.default_branch ?? "";
    const panel = (title, getValue, setValue) => {
      const trigger = button(getValue() || "Select source branch", { icon: "branch", trailingIcon: "chevron-down", class: "ref-selector wide" });
      const summary = el("div", { class: "compare-commit-summary" });
      const drawSummary = () => {
        const branch = branches.find((item) => item.name === getValue());
        clear(summary).append(branch ? el("div", { class: "commit-detail" }, [el("a", { class: "commit-row-message", href: hrefs.commit(path, branch.commit.id), text: branch.commit.title }), el("div", { class: "committer" }, [el("span", { text: `${branch.commit.author_name} authored ` }), timeElement(branch.commit.authored_date), el("span", { text: " · " }), el("code", { text: branch.commit.short_id })])]) : el("span", { class: "gl-text-subtle", text: "Select a branch to compare." }));
      };
      trigger.addEventListener("click", () => openListbox(trigger, { title: "Select branch", placeholder: "Search branches", options: branches.map((branch) => ({ id: branch.name, label: branch.name, selected: branch.name === getValue() })), onSelect: (value) => {
        setValue(value);
        trigger.querySelector(".gl-button-text").textContent = value;
        drawSummary();
      } }));
      drawSummary();
      return el("div", { class: "card compare-panel" }, [el("div", { class: "card-header" }, [el("h3", { class: "card-title", text: title })]), el("div", { class: "card-body" }, [el("div", { class: "compare-selectors" }, [button(path, { icon: "project", disabled: true, class: "project-selector" }), trigger]), summary])]);
    };
    const errorHost = el("div");
    const compare = button("Compare branches and continue", { variant: "confirm", disabled: !canDevelop(project), onClick: () => {
      if (!chosenSource || !chosenTarget) {
        clear(errorHost).append(alert("You must select source and target branch", "danger"));
        return;
      }
      if (chosenSource === chosenTarget) {
        clear(errorHost).append(alert("You must select different branches", "danger"));
        return;
      }
      navigate(hrefs.newMr(path, { source_branch: chosenSource, target_branch: chosenTarget }));
    } });
    container.append(el("h1", { class: "page-heading", text: "New merge request" }), errorHost, el("div", { class: "compare-layout" }, [panel("Source branch", () => chosenSource, (value) => (chosenSource = value)), panel("Target branch", () => chosenTarget, (value) => (chosenTarget = value))]), el("div", { class: "form-actions" }, [compare]));
    clear(main).append(container);
    return;
  }
  // Step 2: details
  const labels = await loadLabels(project).catch(() => []);
  if (stale(token)) return;
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  const draft = { assignees: [], reviewers: [], labels: [] };
  const errorHost = el("div");
  const title = el("input", { class: "gl-form-input", attrs: { id: "merge_request_title", type: "text", maxlength: "255", required: true } });
  title.value = sourceBranch.commit.title || source;
  const draftBox = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "mr_draft" } });
  draftBox.checked = /^(draft:|\[draft\]|\(draft\))/i.test(title.value);
  draftBox.addEventListener("change", () => {
    const stripped = title.value.replace(/^(draft:|\[draft\]|\(draft\))\s*/i, "");
    title.value = draftBox.checked ? `Draft: ${stripped}` : stripped;
  });
  title.addEventListener("input", () => {
    draftBox.checked = /^(draft:|\[draft\]|\(draft\))/i.test(title.value);
    state.editing = true;
  });
  const description = markdownField({ label: "Description", placeholder: "Describe the goal of the changes and what reviewers should be aware of.", rows: 10, onInput: () => (state.editing = true) });
  const removeSource = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "mr_remove_source" } });
  removeSource.checked = project.remove_source_branch_after_merge;
  const squash = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "mr_squash" } });
  squash.checked = project.squash_option === "default_on" || project.squash_option === "always";
  squash.disabled = project.squash_option === "always" || project.squash_option === "never";
  const assigneeValue = el("div");
  const reviewerValue = el("div");
  const labelValue = el("div");
  const draw = () => {
    clear(assigneeValue).append(peopleValue([...state.people.values()].filter((user) => draft.assignees.includes(user.id)), { emptyText: "Unassigned", assignYourself: state.user ? () => {
      draft.assignees = [state.user.id];
      draw();
    } : undefined }));
    clear(reviewerValue).append(peopleValue([...state.people.values()].filter((user) => draft.reviewers.includes(user.id)), { emptyText: "None" }));
    clear(labelValue).append(labelsValue(draft.labels, labelsByName, { onRemove: (name) => {
      draft.labels = draft.labels.filter((item) => item !== name);
      draw();
    } }));
  };
  draw();
  const assigneeButton = button("Assignee", { trailingIcon: "chevron-down" });
  assigneeButton.addEventListener("click", () => pickUsers(assigneeButton, project, { title: "Assign to", selectedIds: draft.assignees, onApply: (ids) => {
    draft.assignees = ids;
    draw();
  } }));
  const reviewerButton = button("Reviewer", { trailingIcon: "chevron-down" });
  reviewerButton.addEventListener("click", () => pickUsers(reviewerButton, project, { title: "Request review from", selectedIds: draft.reviewers, onApply: (ids) => {
    draft.reviewers = ids;
    draw();
  } }));
  const labelButton = button("Labels", { trailingIcon: "chevron-down" });
  labelButton.addEventListener("click", () => pickLabels(labelButton, project, { selected: draft.labels, onApply: (names) => {
    draft.labels = names;
    draw();
  } }));
  const header = el("div", { class: "new-mr-branches" }, [el("span", { text: "From " }), refChip(project, source), el("span", { text: " into " }), refChip(project, target), el("a", { class: "gl-link change-branches", href: hrefs.newMr(path, { source_branch: source, target_branch: target, change: "1" }), text: "Change branches" })]);
  const form = el("form", { class: "merge-request-form common-note-form" }, [
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", attrs: { for: "merge_request_title" } }, [el("span", { text: "Title " }), el("span", { class: "gl-text-subtle", text: "(required)" })]), title, el("div", { class: "gl-form-checkbox" }, [draftBox, el("label", { attrs: { for: "mr_draft" } }, [el("span", { text: "Mark as draft" }), el("p", { class: "gl-form-text", text: "Drafts cannot be merged until marked ready." })])])]),
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Description" }), description.element]),
    el("div", { class: "issuable-form-columns" }, [
      el("div", {}, [
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Assignee" }), el("div", { class: "form-sidebar-value" }, [assigneeButton, assigneeValue])]),
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Reviewer" }), el("div", { class: "form-sidebar-value" }, [reviewerButton, reviewerValue])]),
      ]),
      el("div", {}, [
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Milestone" }), el("div", { class: "form-sidebar-value" }, [button("Milestone", { trailingIcon: "chevron-down", onClick: () => notSimulated("Milestones") })])]),
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Labels" }), el("div", { class: "form-sidebar-value" }, [labelButton, labelValue])]),
      ]),
    ]),
    el("fieldset", { class: "gl-form-group" }, [
      el("legend", { class: "gl-form-label", text: "Merge options" }),
      el("div", { class: "gl-form-checkbox" }, [removeSource, el("label", { attrs: { for: "mr_remove_source" }, text: "Delete source branch when merge request is accepted." })]),
      project.squash_option === "never" ? "" : el("div", { class: "gl-form-checkbox" }, [squash, el("label", { attrs: { for: "mr_squash" }, text: "Squash commits when merge request is accepted." })]),
    ]),
  ]);
  const submit = button("Create merge request", { variant: "confirm", type: "submit", disabled: !canDevelop(project) });
  form.append(el("div", { class: "form-actions" }, [submit, el("a", { class: "gl-button btn-default btn-md", href: hrefs.mrs(path), text: "Cancel" })]));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!title.value.trim()) {
      showFormError(errorHost, new Error("Title can't be blank"));
      return;
    }
    void action(async () => {
      clear(errorHost);
      const mr = await call("merge-requests.save", { id: project.id, source_branch: source, target_branch: target, title: title.value.trim(), description: description.value, remove_source_branch: removeSource.checked, squash: squash.checked, ...(draft.assignees.length ? { assignee_ids: draft.assignees } : {}), ...(draft.reviewers.length ? { reviewer_ids: draft.reviewers } : {}), ...(draft.labels.length ? { labels: draft.labels } : {}) }, newKey());
      state.editing = false;
      navigate(hrefs.mr(path, mr.iid));
    }, { onError: (error) => showFormError(errorHost, error) });
  });
  container.append(el("h1", { class: "page-heading", text: "New merge request" }), header, errorHost, form);
  clear(main).append(container);
}

// ---------------------------------------------------------------------------------------------
// Merge request page
// ---------------------------------------------------------------------------------------------

export async function renderMr(main, route, project, iid, tab, token) {
  const path = project.path_with_namespace;
  const activeTab = ["overview", "commits", "diffs", "pipelines"].includes(tab) ? tab : "overview";
  const pref = activityPreference("mr");
  const [mr, labels, commitsPage] = await Promise.all([
    call("merge-requests.get", { id: project.id, merge_request_iid: iid }),
    loadLabels(project).catch(() => []),
    call("merge-requests.list-commits", { id: project.id, merge_request_iid: iid, per_page: 1 }).catch(() => undefined),
  ]);
  if (stale(token)) return;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Merge requests", href: hrefs.mrs(path) }, { text: `!${mr.iid}`, href: hrefs.mr(path, mr.iid) }]));
  setTitle([`${mr.title} (!${mr.iid})`, "Merge requests", project.name_with_namespace]);
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  const refHref = (kind, number) => (kind === "#" ? hrefs.issue(path, number) : hrefs.mr(path, number));
  const isAuthor = state.user?.id === mr.author.id;
  const canEdit = !project.archived && (canDevelop(project) || isAuthor);
  const rerender = () => refresh();
  const save = (changes, message) =>
    action(async () => {
      await call("merge-requests.save", { id: project.id, merge_request_iid: mr.iid, ...changes }, newKey());
      if (message) toast(message);
      rerender();
    });
  const container = el("div", { class: "page-padded merge-request-page" });

  // Header
  const titleRow = el("div", { class: "merge-request-title-row" }, [el("h1", { class: "title merge-request-title", attrs: { dir: "auto" }, text: mr.title })]);
  const headerActions = el("div", { class: "detail-page-header-actions" });
  if (canEdit) headerActions.append(button("Edit", { onClick: () => editMr(project, mr, rerender) }));
  headerActions.append(
    button("Code", { trailingIcon: "chevron-down", onClick: (event) =>
      openMenu(event.currentTarget, [
        { label: "Check out branch", onSelect: () => checkoutModal(project, mr) },
        { label: "Open in Web IDE", onSelect: () => notSimulated("Web IDE") },
        "divider",
        { header: "Download" },
        { label: "Plain diff", onSelect: () => notSimulated("Plain diff download") },
        { label: "Patches", onSelect: () => notSimulated("Patch download") },
      ], { align: "end", width: 220 }) }),
    iconButton("ellipsis_v", "Merge request actions", { variant: "default", onClick: (event) =>
      openMenu(event.currentTarget, [
        { label: mr.draft ? "Mark as ready" : "Mark as draft", disabled: !canEdit || mr.state !== "opened", onSelect: () => void save({ title: mr.draft ? mr.title.replace(/^(draft:|\[draft\]|\(draft\))\s*/i, "") : `Draft: ${mr.title}` }, mr.draft ? "Marked as ready. Merging is now allowed." : "Marked as draft. Can only be merged when marked as ready.") },
        { label: "Copy reference", onSelect: () => copyText(mr.references.full, "Reference copied") },
        { label: mr.discussion_locked ? "Unlock merge request" : "Lock merge request", disabled: !canDevelop(project), onSelect: () => void save({ discussion_locked: !mr.discussion_locked }) },
        "divider",
        mr.state === "closed" ? { label: "Reopen merge request", disabled: !canEdit, onSelect: () => void save({ state_event: "reopen" }, "Merge request reopened") } : { label: "Close merge request", disabled: !canEdit || mr.state !== "opened", onSelect: async () => {
          if (await confirmModal("Close merge request?", `Close !${mr.iid} without merging? You can reopen it later.`, "Close merge request", { danger: true })) void save({ state_event: "close" }, "Merge request closed");
        } },
        { label: "Report abuse", onSelect: () => notSimulated("Abuse reports") },
      ].filter(Boolean), { align: "end", width: 240 }) }),
  );
  titleRow.append(headerActions);
  const meta = el("div", { class: "detail-page-header-body merge-request-meta" }, [stateBadge("mr", mr.state)]);
  if (mr.discussion_locked) meta.append(el("span", { class: "gl-badge badge-warning badge-md", title: "Locked" }, [icon("lock", "gl-badge-icon", 14)]));
  meta.append(el("span", { class: "issuable-meta" }, [userLink(mr.author, { withAvatar: true }), el("span", { text: mr.state === "merged" ? " merged " : " requested to merge " }), refChip(project, mr.source_branch, { link: mr.state !== "merged" }), copyButton(mr.source_branch, "Copy branch name"), el("span", { text: " into " }), refChip(project, mr.target_branch), el("span", { text: " " }), timeElement(mr.created_at)]));
  container.append(titleRow, meta);

  const tabs = el("ul", { class: "merge-request-tabs gl-tabs-nav", attrs: { role: "tablist" } });
  const tabItem = (id, label, count, href) => {
    const a = el("a", { class: `gl-tab-nav-item ${activeTab === id ? "gl-tab-nav-item-active" : ""}`, href, attrs: { role: "tab", "aria-selected": String(activeTab === id) } }, [el("span", { text: label }), el("span", { class: "gl-badge badge-neutral badge-sm gl-tab-counter-badge", text: String(count) })]);
    tabs.append(el("li", {}, [a]));
  };
  tabItem("overview", "Overview", mr.user_notes_count, hrefs.mr(path, mr.iid));
  tabItem("commits", "Commits", commitsPage?.page?.total ?? "?", hrefs.mr(path, mr.iid, "commits"));
  tabItem("pipelines", "Pipelines", 0, hrefs.mr(path, mr.iid, "pipelines"));
  tabItem("diffs", "Changes", mr.changes_count, hrefs.mr(path, mr.iid, "diffs"));
  container.append(el("div", { class: "merge-request-tabs-holder" }, [tabs]));
  if (project.archived) container.append(alert("This is an archived project. Repository and other project resources are read-only.", "warning"));
  const content = el("div", { class: "merge-request-tab-content" }, [skeletonRows(4)]);
  container.append(content);
  clear(main).append(container);

  if (activeTab === "commits") {
    const commits = await pageAll((page) => call("merge-requests.list-commits", { id: project.id, merge_request_iid: mr.iid, ...page }));
    if (stale(token)) return;
    clear(content).append(commits.length ? commitList(project, commits) : emptyState("There are no commits yet.", ""));
    return;
  }
  if (activeTab === "pipelines") {
    clear(content).append(emptyState("There are currently no pipelines.", "CI/CD pipelines are not simulated by this Tool, so no pipeline ever runs for this merge request.", [], { iconName: "rocket" }));
    return;
  }
  if (activeTab === "diffs") {
    const diffs = await pageAll((page) => call("merge-requests.list-diffs", { id: project.id, merge_request_iid: mr.iid, ...page }));
    if (stale(token)) return;
    const totals = diffs.reduce((sum, file) => {
      const stats = diffStats(file.diff);
      return { additions: sum.additions + stats.additions, deletions: sum.deletions + stats.deletions };
    }, { additions: 0, deletions: 0 });
    const layout = el("div", { class: "diffs-layout" });
    const tree = el("nav", { class: "diff-tree-list", attrs: { "aria-label": "Changed files" } }, [el("div", { class: "diff-tree-search" }, [el("span", { class: "gl-text-subtle gl-text-sm", text: plural(diffs.length, "file") })])]);
    for (const file of diffs) {
      const stats = diffStats(file.diff);
      tree.append(el("a", { class: "file-row", href: `#diff-${file.new_path}`, title: file.new_path }, [icon("doc-text", "", 14), el("span", { class: "file-row-name", text: file.new_path.split("/").pop() }), el("span", { class: "file-row-stats" }, [el("span", { class: "gl-text-success", text: `+${stats.additions}` }), el("span", { class: "gl-text-danger", text: ` −${stats.deletions}` })])]));
      tree.lastChild.addEventListener("click", (event) => {
        event.preventDefault();
        document.getElementById(`diff-${file.new_path}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    }
    const files = el("div", { class: "diff-files-holder" });
    files.append(el("div", { class: "mr-version-controls" }, [el("div", { class: "inline-parallel-buttons" }, [iconButton("file-tree", "Hide file browser", { variant: "default", onClick: () => tree.toggleAttribute("hidden") })]), el("div", { class: "files-changed-inner" }, [el("span", { text: "Compare " }), refChip(project, mr.target_branch, { link: false }), el("span", { text: " and latest version · " }), el("strong", { text: plural(diffs.length, "file") }), el("span", { text: " " }), el("strong", { class: "gl-text-success", text: `+${totals.additions}` }), el("strong", { class: "gl-text-danger", text: ` −${totals.deletions}` })])]));
    for (const file of diffs) files.append(diffFile(file, { project, sha: mr.sha }));
    if (diffs.length === 0) files.append(emptyState("No changes between the source and target branch", ""));
    layout.append(tree, files);
    clear(content).append(layout);
    return;
  }

  // Overview
  const notes = await pageAll((page) => call("merge-requests.list-notes", { id: project.id, merge_request_iid: mr.iid, sort: pref.sort, ...page }));
  if (stale(token)) return;
  const branches = await loadBranches(project).catch(() => []);
  if (stale(token)) return;
  const layout = el("div", { class: "issuable-layout" });
  const mainColumn = el("div", { class: "issuable-main-column" });
  mainColumn.append(el("div", { class: "detail-page-description description" }, [mr.description ? markdown(mr.description, { refHref }) : el("p", { class: "gl-text-subtle", text: "No description" })]));
  if (mr.task_completion_status.count > 0) mainColumn.append(el("div", { class: "task-status gl-text-subtle" }, [icon("list-task", "", 14), el("span", { text: ` ${mr.task_completion_status.completed_count} of ${plural(mr.task_completion_status.count, "checklist item")} completed` })]));
  mainColumn.append(mergeWidget(project, mr, branches, { canEdit, save, rerender }));
  const filter = pref.filter;
  const visible = filter === "only_comments" ? notes.filter((note) => !note.system) : filter === "only_activity" ? notes.filter((note) => note.system) : notes;
  mainColumn.append(
    el("div", { class: "issuable-activity-header" }, [el("h2", { class: "activity-heading", text: "Activity" }), activityControls({ sort: pref.sort, filter, onChange: (value) => {
      saveActivityPreference("mr", value);
      rerender();
    } })]),
    timeline(visible, { project, refHref, noteableAuthorId: mr.author.id, labelsByName }),
    commentForm({
      canComment: !project.archived && (!mr.discussion_locked || canDevelop(project)),
      lockedMessage: project.archived ? "This project is archived and cannot be commented on." : "The discussion in this merge request is locked. Only project members can comment.",
      canInternal: false,
      refHref,
      onDirty: (dirty) => (state.editing = dirty),
      onSubmit: async (text) => {
        await call("notes.save", { id: project.id, merge_request_iid: mr.iid, body: text }, newKey());
        rerender();
      },
    }),
  );
  const sidebar = el("aside", { class: "right-sidebar issuable-sidebar", attrs: { "aria-label": "Merge request details" } });
  sidebar.append(
    el("div", { class: "block issuable-sidebar-header" }, [el("span", { class: "gl-text-subtle", text: "To-Do" }), button("Add a to-do item", { size: "sm", onClick: () => notSimulated("To-Do items") })]),
    sidebarBlock(mr.assignees.length > 1 ? `${mr.assignees.length} Assignees` : "Assignee", {
      canEdit,
      onEdit: (anchor) => pickUsers(anchor, project, { title: "Assign to", selectedIds: mr.assignees.map((user) => user.id), onApply: (ids) => void save({ assignee_ids: ids }) }),
      content: peopleValue(mr.assignees, { emptyText: "None", assignYourself: canEdit && state.user ? () => void save({ assignee_ids: [state.user.id] }) : undefined }),
    }),
    sidebarBlock(mr.reviewers.length > 1 ? `${mr.reviewers.length} Reviewers` : "Reviewer", {
      canEdit,
      onEdit: (anchor) => pickUsers(anchor, project, { title: "Request review from", selectedIds: mr.reviewers.map((user) => user.id), onApply: (ids) => void save({ reviewer_ids: ids }) }),
      content: peopleValue(mr.reviewers, { emptyText: "None" }),
    }),
    sidebarBlock("Labels", {
      canEdit,
      onEdit: (anchor) => pickLabels(anchor, project, { selected: mr.labels, onApply: (names) => void save({ labels: names.length ? names : "" }) }),
      content: labelsValue(mr.labels, labelsByName, canEdit ? { onRemove: (name) => void save({ remove_labels: [name] }) } : {}),
    }),
    mutedBlock("Milestone", "None", "Milestones"),
    mutedBlock("Time tracking", "No estimate or time spent", "Time tracking"),
    sidebarBlock("Lock merge request", {
      canEdit: canDevelop(project),
      editLabel: mr.discussion_locked ? "Unlock" : "Lock",
      onEdit: () => void save({ discussion_locked: !mr.discussion_locked }, mr.discussion_locked ? "Merge request unlocked" : "Merge request locked"),
      content: el("span", { class: "sidebar-icon-value" }, [icon(mr.discussion_locked ? "lock" : "lock-open"), el("span", { text: mr.discussion_locked ? "Locked" : "Unlocked" })]),
    }),
    participantsBlock([mr.author, ...mr.assignees, ...mr.reviewers, ...notes.map((note) => note.author)]),
    referenceBlock(mr.references.full),
    el("div", { class: "block reference" }, [el("div", { class: "block-title" }, [el("span", { class: "block-title-text", text: "Source branch: " }), el("span", { class: "reference-value", text: mr.source_branch }), copyButton(mr.source_branch, "Copy branch name")])]),
  );
  layout.append(mainColumn, sidebar);
  clear(content).append(layout);
}

function defaultMergeMessage(project, mr) {
  return `Merge branch '${mr.source_branch}' into '${mr.target_branch}'\n\n${mr.title}\n\nSee merge request ${mr.references.full}`;
}

function mergeWidget(project, mr, branches, { canEdit, save, rerender }) {
  const widget = el("div", { class: "mr-state-widget" });
  // Approvals (not simulated)
  widget.append(el("div", { class: "mr-widget-section mr-approvals" }, [el("span", { class: "mr-widget-icon" }, [icon("approval")]), el("div", { class: "mr-widget-body" }, [button("Approve", { size: "sm", onClick: () => notSimulated("Approvals") }), el("span", { class: "gl-text-subtle", text: " Approval is optional" })])]));
  const section = el("div", { class: "mr-widget-section mr-merge-section" });
  const iconBox = (name, variant) => el("span", { class: `mr-widget-icon ci-status-icon-${variant}` }, [icon(name, "", 24)]);
  const sourceExists = branches.some((branch) => branch.name === mr.source_branch);
  if (mr.state === "merged") {
    section.classList.add("mr-merged");
    const body = el("div", { class: "mr-widget-body" }, [
      el("div", { class: "mr-widget-headline" }, [el("strong", { text: "Merged by " }), mr.merged_by ? userLink(mr.merged_by, { withAvatar: true }) : el("span", { text: "unknown" }), el("span", { text: " " }), mr.merged_at ? timeElement(mr.merged_at) : ""]),
      el("p", { class: "mr-widget-text" }, [el("span", { text: "Changes merged into " }), refChip(project, mr.target_branch), mr.merge_commit_sha || mr.squash_commit_sha ? el("span", { text: " with " }) : "", mr.merge_commit_sha ? el("a", { class: "commit-sha", href: hrefs.commit(project.path_with_namespace, mr.merge_commit_sha), text: mr.merge_commit_sha.slice(0, 8) }) : "", mr.squash_commit_sha && !mr.merge_commit_sha ? el("a", { class: "commit-sha", href: hrefs.commit(project.path_with_namespace, mr.squash_commit_sha), text: mr.squash_commit_sha.slice(0, 8) }) : "", el("span", { text: "." })]),
      el("p", { class: "mr-widget-text gl-text-subtle", text: sourceExists ? `The source branch ${mr.source_branch} has not been deleted.` : "The source branch has been deleted." }),
    ]);
    section.append(iconBox("merge", "merged"), body);
    widget.append(section);
    return widget;
  }
  if (mr.state === "closed") {
    section.append(iconBox("merge-request-close", "failed"), el("div", { class: "mr-widget-body" }, [el("div", { class: "mr-widget-headline" }, [el("strong", { text: "Closed by " }), mr.closed_by ? userLink(mr.closed_by, { withAvatar: true }) : el("span", { text: "unknown" }), el("span", { text: " " }), mr.closed_at ? timeElement(mr.closed_at) : ""]), el("p", { class: "mr-widget-text gl-text-subtle" }, [el("span", { text: "The changes were not merged into " }), refChip(project, mr.target_branch), el("span", { text: "." })])]));
    widget.append(section);
    return widget;
  }
  const status = mr.detailed_merge_status;
  const blocked = (headline, detail, actions = []) => {
    section.append(iconBox("status_warning", "warning"), el("div", { class: "mr-widget-body" }, [el("div", { class: "mr-widget-headline" }, [el("strong", { text: headline })]), el("p", { class: "mr-widget-text gl-text-subtle", text: detail }), actions.length ? el("div", { class: "mr-widget-actions" }, actions) : ""]));
  };
  if (status === "draft_status" || mr.draft) {
    blocked("Merge blocked: 1 check failed", "Merge request must not be draft.", canEdit ? [button("Mark as ready", { size: "sm", onClick: () => void save({ title: mr.title.replace(/^(draft:|\[draft\]|\(draft\))\s*/i, "") }, "Marked as ready. Merging is now allowed.") })] : []);
  } else if (status === "conflict" || mr.has_conflicts) {
    blocked("Merge blocked: 1 check failed", "Merge conflicts must be resolved.", [button("Resolve locally", { size: "sm", onClick: () => checkoutModal(project, mr) }), button("Resolve conflicts", { size: "sm", onClick: () => notSimulated("Resolving conflicts in the browser") })]);
  } else if (status === "need_rebase") {
    blocked("Merge blocked: 1 check failed", "The source branch must be rebased onto the target branch. Merge method is fast-forward merge.", [button("Rebase", { size: "sm", onClick: () => notSimulated("Rebase") })]);
  } else if (status === "commits_status") {
    blocked("Merge blocked: 1 check failed", sourceExists ? "Merge request must have commits: the source branch has no changes compared to the target branch." : `Source branch ${mr.source_branch} does not exist. Restore the branch or close this merge request.`);
  } else if (status === "discussions_not_resolved") {
    blocked("Merge blocked: 1 check failed", "All threads must be resolved.");
  } else if (status !== "mergeable") {
    blocked("Merge blocked", `Merge status: ${status.replace(/_/g, " ")}.`);
  } else if (!mr.user.can_merge) {
    section.append(iconBox("check-circle-filled", "success"), el("div", { class: "mr-widget-body" }, [el("div", { class: "mr-widget-headline" }, [el("strong", { text: "Ready to merge by members who can write to the target branch." })])]));
  } else {
    const removeSource = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "merge-remove-source" } });
    removeSource.checked = Boolean(mr.force_remove_source_branch || mr.should_remove_source_branch || project.remove_source_branch_after_merge);
    const squash = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "merge-squash" } });
    squash.checked = Boolean(mr.squash || project.squash_option === "always" || project.squash_option === "default_on");
    squash.disabled = project.squash_option === "always";
    const editMessage = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "merge-edit-message" } });
    const message = el("textarea", { class: "gl-form-textarea merge-commit-message", attrs: { rows: "6", "aria-label": "Merge commit message" } });
    message.value = defaultMergeMessage(project, mr);
    const messageBox = el("div", { class: "merge-commit-message-box" }, [el("label", { class: "gl-form-label", text: "Merge commit message" }), message]);
    messageBox.hidden = true;
    editMessage.addEventListener("change", () => {
      messageBox.hidden = !editMessage.checked;
      state.editing = editMessage.checked;
    });
    const errorHost = el("div");
    const merge = button("Merge", { variant: "confirm", onClick: async () => {
      if (!(await confirmModal("Merge this merge request?", `Merge ${mr.source_branch} into ${mr.target_branch}${squash.checked ? " as one squashed commit" : ""}${removeSource.checked ? " and delete the source branch" : ""}.`, "Merge"))) return;
      await action(async () => {
        clear(errorHost);
        await call("merge-requests.merge", { id: project.id, merge_request_iid: mr.iid, sha: mr.sha, squash: squash.checked, should_remove_source_branch: removeSource.checked, ...(editMessage.checked ? { commit_message: message.value } : {}) }, newKey());
        state.editing = false;
        toast("Merged");
        rerender();
      }, { onError: (error) => clear(errorHost).append(alert(mergeError(error), "danger")) });
    } });
    section.append(
      iconBox("check-circle-filled", "success"),
      el("div", { class: "mr-widget-body" }, [
        el("div", { class: "mr-widget-headline" }, [el("strong", { text: "Ready to merge!" })]),
        el("div", { class: "mr-widget-merge-options" }, [
          el("div", { class: "gl-form-checkbox" }, [removeSource, el("label", { attrs: { for: "merge-remove-source" }, text: "Delete source branch" })]),
          project.squash_option === "never" ? "" : el("div", { class: "gl-form-checkbox" }, [squash, el("label", { attrs: { for: "merge-squash" }, text: "Squash commits" })]),
          el("div", { class: "gl-form-checkbox" }, [editMessage, el("label", { attrs: { for: "merge-edit-message" }, text: "Edit commit message" })]),
        ]),
        messageBox,
        errorHost,
        el("div", { class: "mr-widget-actions" }, [merge, el("span", { class: "gl-text-subtle merge-note" }, [el("span", { text: `${plural(mr.changes_count, "change")} will be merged into ` }), refChip(project, mr.target_branch, { link: false })])]),
      ]),
    );
  }
  widget.append(section);
  return widget;
}

function mergeError(error) {
  if (error instanceof ToolError && error.is("CONFLICT")) return `${error.message} The source branch changed since this page loaded; refresh to review the latest changes before merging.`;
  if (error instanceof ToolError && error.is("NOT_ACCEPTABLE")) return `${error.message} This merge request cannot be merged in its current state.`;
  if (error instanceof ToolError && error.is("METHOD_NOT_ALLOWED")) return `${error.message} Mark the merge request as ready first.`;
  if (error instanceof ToolError && error.is("SERVICE_UNAVAILABLE")) return `${error.message} Merging is temporarily unavailable; try again.`;
  return describe(error);
}

function checkoutModal(project, mr) {
  void openModal("Check out branch", (body, close, footer) => {
    body.append(
      el("p", { class: "gl-text-subtle", text: "The Git remote below belongs to this synthetic instance; there is no Git server behind it." }),
      el("p", { html: undefined }, [el("strong", { text: "Step 1. " }), el("span", { text: "Fetch and check out this merge request's feature branch:" })]),
      el("pre", { class: "code-block", text: `git fetch origin\ngit checkout -b '${mr.source_branch}' 'origin/${mr.source_branch}'` }),
      el("p", {}, [el("strong", { text: "Step 2. " }), el("span", { text: "Review the changes locally." })]),
      el("p", {}, [el("strong", { text: "Step 3. " }), el("span", { text: "Resolve any conflicts." })]),
      el("p", {}, [el("strong", { text: "Step 4. " }), el("span", { text: "Push the result of the merge to GitLab:" })]),
      el("pre", { class: "code-block", text: `git push origin '${mr.source_branch}'` }),
    );
    footer.append(button("Close", { onClick: () => close() }));
  }, { size: "md" });
}

function editMr(project, mr, rerender) {
  void openModal(`Edit merge request !${mr.iid}`, (body, close, footer) => {
    const errorHost = el("div");
    const title = el("input", { class: "gl-form-input", attrs: { type: "text", "aria-label": "Title", maxlength: "255" } });
    title.value = mr.title;
    const field = markdownField({ value: mr.description, label: "Description", rows: 8 });
    body.append(errorHost, el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Title" }), title]), el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Description" }), field.element]));
    footer.append(
      button("Cancel", { onClick: () => close() }),
      button("Save changes", { variant: "confirm", onClick: () =>
        action(async () => {
          await call("merge-requests.save", { id: project.id, merge_request_iid: mr.iid, title: title.value.trim(), description: field.value }, newKey());
          close(true);
          rerender();
        }, { onError: (error) => showFormError(errorHost, error) }) }),
    );
  }, { size: "lg" });
}

export { badge };
