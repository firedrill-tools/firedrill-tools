// Issues: project list, dashboard list, new issue form and the issue page.
import { ToolError, action, alert, avatar, button, call, clear, confirmModal, copyText, describe, el, icon, iconButton, markdown, newKey, openListbox, openMenu, openModal, pageAll, plural, timeElement, toast } from "./ui.js";
import { PER_PAGE, canPlan, canReport, emptyState, filteredSearch, hrefs, loadLabels, navigate, notSimulated, pagination, projectCrumbs, setBreadcrumbs, setTitle, skeletonRows, sortControl, state, stateBadge, stateTabs, userLink, withQuery } from "./shell.js";
import { activityControls, activityPreference, commentForm, issuableRow, labelTokenOptions, labelsValue, markdownField, mutedBlock, participantsBlock, peopleValue, pickLabels, pickUsers, referenceBlock, saveActivityPreference, showFormError, sidebarBlock, timeline, userTokenOptions } from "./issuable.js";

const stale = (token) => token !== state.navigation;
const refresh = () => navigate(location.hash);
const SORTS = [
  { value: "created_at", label: "Created date" },
  { value: "updated_at", label: "Updated date" },
  { value: "title", label: "Title" },
];

export function refHrefFor(project) {
  return (kind, number) => (kind === "#" ? hrefs.issue(project.path_with_namespace, number) : hrefs.mr(project.path_with_namespace, number));
}

// ---------------------------------------------------------------------------------------------
// Issue list
// ---------------------------------------------------------------------------------------------

function listFilters(query) {
  return {
    author_username: query.get("author_username") ?? undefined,
    assignee_username: query.get("assignee_username") ?? undefined,
    label_name: query.get("label_name") ?? undefined,
    confidential: query.get("confidential") ?? undefined,
  };
}

function filterArgs(filters) {
  const args = {};
  if (filters.author_username) args.author_username = filters.author_username;
  if (filters.assignee_username === "None" || filters.assignee_username === "Any") args.assignee_id = filters.assignee_username;
  else if (filters.assignee_username) args.assignee_username = filters.assignee_username;
  if (filters.label_name) args.labels = filters.label_name;
  if (filters.confidential === "yes" || filters.confidential === "no") args.confidential = filters.confidential === "yes";
  return args;
}

export async function renderIssues(main, route, project, token) {
  const path = project.path_with_namespace;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Issues", href: hrefs.issues(path) }]));
  setTitle(["Issues", project.name_with_namespace]);
  if (!project.issues_enabled) {
    clear(main).append(el("div", { class: "page-padded" }, [emptyState("Issues are turned off", "The Issues feature is disabled for this project.")]));
    return;
  }
  const query = route.query;
  const stateValue = ["opened", "closed", "all"].includes(query.get("state")) ? query.get("state") : "opened";
  const search = query.get("search") ?? "";
  const sort = SORTS.some((option) => option.value === query.get("sort")) ? query.get("sort") : "created_at";
  const direction = query.get("direction") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const filters = listFilters(query);
  const baseParams = { search, sort: sort === "created_at" ? "" : sort, direction: direction === "desc" ? "" : direction, ...filters };
  const hrefFor = (params) => hrefs.issues(path, { state: stateValue === "opened" ? "" : stateValue, ...baseParams, page: "", ...params });
  const container = el("div", { class: "page-padded issues-list-page" });
  const tabs = [
    { id: "opened", label: "Open", href: hrefFor({ state: "" }) },
    { id: "closed", label: "Closed", href: hrefFor({ state: "closed" }) },
    { id: "all", label: "All", href: hrefFor({ state: "all" }) },
  ];
  const actions = [
    button("Bulk edit", { disabled: !canPlan(project), onClick: () => notSimulated("Bulk editing issues") }),
    button("New issue", { variant: "confirm", disabled: project.archived, onClick: () => navigate(hrefs.newIssue(path)) }),
    iconButton("ellipsis_v", "Actions", { variant: "default", onClick: (event) => openMenu(event.currentTarget, [{ label: "Export as CSV", onSelect: () => notSimulated("CSV export") }, { label: "Import CSV", onSelect: () => notSimulated("CSV import") }, { label: "Import from Jira", onSelect: () => notSimulated("Jira import") }, "divider", { label: "Email a new issue to this project", onSelect: () => notSimulated("Incoming email") }, { label: "Subscribe to RSS feed", onSelect: () => notSimulated("RSS feeds") }, { label: "Subscribe to calendar", onSelect: () => notSimulated("Calendar feeds") }], { align: "end", width: 260 }) }),
  ];
  const tabBar = stateTabs(tabs, stateValue, actions);
  const tokens = [
    { type: "assignee_username", title: "Assignee", icon: "user", options: userTokenOptions(project, { includeNone: true }), display: (value) => (value === "None" || value === "Any" ? value : `@${value}`), freeText: true, freeTextPlaceholder: "Username" },
    { type: "author_username", title: "Author", icon: "pencil", options: userTokenOptions(project), display: (value) => `@${value}`, freeText: true, freeTextPlaceholder: "Username" },
    { type: "confidential", title: "Confidential", icon: "eye-slash", options: async () => [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }], display: (value) => (value === "yes" ? "Yes" : "No") },
    { type: "label_name", title: "Label", icon: "label", options: labelTokenOptions(project), display: (value) => `~${value}` },
  ];
  const toolbar = el("div", { class: "filtered-search-block" }, [
    filteredSearch({ tokens, values: filters, search, onSubmit: ({ values, search: text }) => navigate(hrefs.issues(path, { state: stateValue === "opened" ? "" : stateValue, sort: baseParams.sort, direction: baseParams.direction, ...values, search: text })) }),
    sortControl({ options: SORTS, value: sort, direction, onChange: (value, dir) => navigate(hrefFor({ sort: value === "created_at" ? "" : value, direction: dir === "desc" ? "" : dir })) }),
  ]);
  const host = el("div", {}, [skeletonRows(6)]);
  container.append(tabBar, toolbar, host);
  clear(main).append(container);
  const args = { id: project.id, ...filterArgs(filters), ...(search ? { search } : {}), order_by: sort, sort: direction };
  const [result, labels] = await Promise.all([call("issues.list", { ...args, state: stateValue, page, per_page: PER_PAGE }), loadLabels(project).catch(() => [])]);
  if (stale(token)) return;
  void Promise.all(["opened", "closed", "all"].map((name) => (name === stateValue ? Promise.resolve(result.page?.total) : call("issues.list", { ...args, state: name, per_page: 1 }).then((value) => value.page?.total).catch(() => undefined)))).then((counts) => {
    if (stale(token)) return;
    tabBar.querySelectorAll(".gl-tab-nav-item").forEach((anchor, index) => {
      if (counts[index] !== undefined) anchor.append(el("span", { class: "gl-badge badge-neutral badge-sm gl-tab-counter-badge", text: String(counts[index]) }));
    });
  });
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  clear(host);
  if (result.items.length === 0) {
    const filtered = search || Object.values(filters).some(Boolean);
    host.append(filtered ? emptyState("Sorry, your filter produced no results", "To widen your search, change or remove filters above") : stateValue === "closed" ? emptyState("There are no closed issues", "") : emptyState(stateValue === "all" ? "There are no issues to show" : "There are no open issues", "The Issue Tracker is the place to add things that need to be improved or solved in a project.", project.archived ? [] : [button("New issue", { variant: "confirm", onClick: () => navigate(hrefs.newIssue(path)) })], { iconName: "issues" }));
    return;
  }
  const ul = el("ul", { class: "content-list issuable-list issues-list" });
  for (const issue of result.items) ul.append(issuableRow(issue, "issue", project, labelsByName));
  host.append(ul, pagination(result.page, (target) => hrefFor({ page: target })) ?? "");
}

// ---------------------------------------------------------------------------------------------
// Your work → Issues (across projects)
// ---------------------------------------------------------------------------------------------

export async function renderDashboardIssues(main, route, token) {
  setBreadcrumbs([{ text: "Your work", href: "#/" }, { text: "Issues", href: hrefs.dashboard("issues") }]);
  setTitle(["Issues"]);
  const query = route.query;
  const stateValue = ["opened", "closed", "all"].includes(query.get("state")) ? query.get("state") : "opened";
  const assignee = query.get("assignee") ?? "";
  const author = query.get("author") ?? "";
  const search = query.get("search") ?? "";
  const page = Math.max(1, Number(query.get("page")) || 1);
  const hrefFor = (params) => hrefs.dashboard("issues", { state: stateValue === "opened" ? "" : stateValue, assignee, author, search, page: "", ...params });
  const container = el("div", { class: "page-padded" }, [el("div", { class: "page-heading-row" }, [el("h1", { class: "page-heading", text: "Issues" })])]);
  const tabBar = stateTabs([{ id: "opened", label: "Open", href: hrefFor({ state: "" }) }, { id: "closed", label: "Closed", href: hrefFor({ state: "closed" }) }, { id: "all", label: "All", href: hrefFor({ state: "all" }) }], stateValue, [button("Edit issues", { onClick: () => notSimulated("Bulk editing issues") })]);
  const tokens = [
    { type: "assignee", title: "Assignee", icon: "user", options: async () => (state.user ? [{ value: state.user.username, label: state.user.name, avatar: avatar(state.user, 16) }] : []), display: (value) => `@${value}`, freeText: true },
    { type: "author", title: "Author", icon: "pencil", options: async () => (state.user ? [{ value: state.user.username, label: state.user.name, avatar: avatar(state.user, 16) }] : []), display: (value) => `@${value}`, freeText: true },
  ];
  container.append(tabBar, el("div", { class: "filtered-search-block" }, [filteredSearch({ tokens, values: { assignee, author }, search, onSubmit: ({ values, search: text }) => navigate(hrefs.dashboard("issues", { state: stateValue === "opened" ? "" : stateValue, ...values, search: text })) })]));
  const host = el("div", {}, [skeletonRows(5)]);
  container.append(host);
  clear(main).append(container);
  if (!assignee && !author) {
    clear(host).append(emptyState("Please select at least one filter to see results", "Filter by assignee or author to list issues across your projects.", state.user ? [el("a", { class: "gl-button btn-confirm btn-md", href: hrefFor({ assignee: state.user.username }), text: "Show issues assigned to me" })] : []));
    return;
  }
  const projects = await pageAll((p) => call("projects.list", { membership: true, ...p }));
  const failures = [];
  const lists = await Promise.all(
    projects.filter((project) => project.issues_enabled).map(async (project) => {
      const items = await pageAll((p) => call("issues.list", { id: project.id, state: stateValue, ...(assignee ? { assignee_username: assignee } : {}), ...(author ? { author_username: author } : {}), ...(search ? { search } : {}), ...p })).catch((error) => { failures.push(`${project.name_with_namespace}: ${describe(error)}`); return []; });
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
  const ul = el("ul", { class: "content-list issuable-list" });
  for (const { project, item, labels } of rows.slice((current - 1) * PER_PAGE, current * PER_PAGE)) ul.append(issuableRow(item, "issue", project, labels, { showProject: true }));
  host.append(ul, pagination({ page: current, next_page: current < totalPages ? current + 1 : null, prev_page: current > 1 ? current - 1 : null, total_pages: totalPages }, (target) => hrefFor({ page: target })) ?? "");
}

// ---------------------------------------------------------------------------------------------
// New issue
// ---------------------------------------------------------------------------------------------

export async function renderNewIssue(main, route, project, token) {
  const path = project.path_with_namespace;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Issues", href: hrefs.issues(path) }, { text: "New", href: hrefs.newIssue(path) }]));
  setTitle(["New Issue", project.name_with_namespace]);
  const labels = await loadLabels(project).catch(() => []);
  if (stale(token)) return;
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  const draft = { type: "issue", assignees: [], labels: [], confidential: false };
  const container = el("div", { class: "page-padded issuable-form-page" });
  const errorHost = el("div");
  const title = el("input", { class: "gl-form-input", attrs: { id: "issue_title", type: "text", maxlength: "255", required: true, placeholder: "Title", autocomplete: "off" } });
  const description = markdownField({ label: "Description", placeholder: "Write a description or drag your files here…", rows: 10, refHref: (kind, number) => (kind === "#" ? hrefs.issue(path, number) : hrefs.mr(path, number)) });
  const confidential = el("input", { class: "gl-form-checkbox-input", attrs: { type: "checkbox", id: "issue_confidential" } });
  const dirty = () => (state.editing = Boolean(title.value || description.value || draft.assignees.length || draft.labels.length || confidential.checked));
  title.addEventListener("input", dirty);
  description.textarea.addEventListener("input", dirty);
  confidential.addEventListener("change", dirty);
  const typeButton = button("Issue", { icon: "issue-type-issue", trailingIcon: "chevron-down" });
  typeButton.addEventListener("click", () => openListbox(typeButton, { title: "Type", options: [{ id: "issue", label: "Issue", selected: draft.type === "issue" }, { id: "incident", label: "Incident", selected: draft.type === "incident" }], onSelect: (value) => {
    draft.type = value;
    typeButton.querySelector(".gl-button-text").textContent = value === "issue" ? "Issue" : "Incident";
  } }));
  const assigneeValue = el("div");
  const labelValue = el("div");
  const drawAssignees = () => {
    const people = [...state.people.values()].filter((user) => draft.assignees.includes(user.id));
    clear(assigneeValue).append(peopleValue(people, { emptyText: "Unassigned", assignYourself: state.user ? () => {
      draft.assignees = [state.user.id];
      drawAssignees();
      dirty();
    } : undefined }));
  };
  const drawLabels = () => clear(labelValue).append(labelsValue(draft.labels, labelsByName, { onRemove: (name) => {
    draft.labels = draft.labels.filter((item) => item !== name);
    drawLabels();
  } }));
  drawAssignees();
  drawLabels();
  const planner = canPlan(project);
  const assigneeButton = button("Assignee", { trailingIcon: "chevron-down", disabled: !planner });
  assigneeButton.addEventListener("click", () => pickUsers(assigneeButton, project, { title: "Assign to", selectedIds: draft.assignees, onApply: (ids) => {
    draft.assignees = ids;
    drawAssignees();
    dirty();
  } }));
  const labelButton = button("Labels", { trailingIcon: "chevron-down", disabled: !planner });
  labelButton.addEventListener("click", () => pickLabels(labelButton, project, { selected: draft.labels, onApply: (names) => {
    draft.labels = names;
    drawLabels();
    dirty();
  } }));
  const due = el("input", { class: "gl-form-input gl-form-input-md", attrs: { type: "date", id: "issue_due_date", "aria-label": "Due date" } });
  const form = el("form", { class: "issue-form common-note-form" }, [
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Type" }), typeButton]),
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", attrs: { for: "issue_title" } }, [el("span", { text: "Title " }), el("span", { class: "gl-text-subtle", text: "(required)" })]), title]),
    el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Description" }), description.element]),
    el("div", { class: "gl-form-group" }, [el("div", { class: "gl-form-checkbox" }, [confidential, el("label", { attrs: { for: "issue_confidential" } }, [el("span", { text: "This issue is confidential and should only be visible to team members with at least the Planner role." })])])]),
    el("hr"),
    el("div", { class: "issuable-form-columns" }, [
      el("div", {}, [
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Assignee" }), el("div", { class: "form-sidebar-value" }, [assigneeButton, assigneeValue])]),
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Milestone" }), el("div", { class: "form-sidebar-value" }, [button("Milestone", { trailingIcon: "chevron-down", onClick: () => notSimulated("Milestones") })])]),
      ]),
      el("div", {}, [
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Labels" }), el("div", { class: "form-sidebar-value" }, [labelButton, labelValue])]),
        el("div", { class: "gl-form-group form-row-sidebar" }, [el("label", { class: "gl-form-label", text: "Due date", attrs: { for: "issue_due_date" } }), el("div", { class: "form-sidebar-value" }, [due])]),
      ]),
    ]),
  ]);
  if (!planner) form.append(el("p", { class: "gl-text-subtle gl-text-sm", text: "Assignees and labels can be set by members with at least the Planner role." }));
  const submit = button("Create issue", { variant: "confirm", type: "submit", disabled: project.archived });
  form.append(el("div", { class: "form-actions" }, [submit, el("a", { class: "gl-button btn-default btn-md", href: hrefs.issues(path), text: "Cancel" })]));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!title.value.trim()) {
      showFormError(errorHost, new Error("Title can't be blank"));
      title.focus();
      return;
    }
    void action(async () => {
      clear(errorHost);
      const issue = await call("issues.create", { id: project.id, title: title.value.trim(), description: description.value, confidential: confidential.checked, issue_type: draft.type, ...(draft.assignees.length ? { assignee_ids: draft.assignees } : {}), ...(draft.labels.length ? { labels: draft.labels } : {}), ...(due.value ? { due_date: due.value } : {}) }, newKey());
      state.editing = false;
      navigate(hrefs.issue(path, issue.iid));
    }, { onError: (error) => showFormError(errorHost, error) });
  });
  if (project.archived) container.append(alert("This is an archived project. Repository and other project resources are read-only.", "warning"));
  container.append(el("h1", { class: "page-heading", text: "New issue" }), errorHost, form);
  clear(main).append(container);
  title.focus();
}

// ---------------------------------------------------------------------------------------------
// Issue page
// ---------------------------------------------------------------------------------------------

export async function renderIssue(main, route, project, iid, token) {
  const path = project.path_with_namespace;
  const pref = activityPreference("issue");
  const [issue, notes, labels] = await Promise.all([
    call("issues.get", { id: project.id, issue_iid: iid }),
    pageAll((page) => call("issues.list-notes", { id: project.id, issue_iid: iid, sort: pref.sort, activity_filter: pref.filter, ...page })),
    loadLabels(project).catch(() => []),
  ]);
  if (stale(token)) return;
  setBreadcrumbs(projectCrumbs(project, [{ text: "Issues", href: hrefs.issues(path) }, { text: `#${issue.iid}`, href: hrefs.issue(path, issue.iid) }]));
  setTitle([`${issue.title} (#${issue.iid})`, "Issues", project.name_with_namespace]);
  const labelsByName = new Map(labels.map((label) => [label.name, label]));
  const refHref = (kind, number) => (kind === "#" ? hrefs.issue(path, number) : hrefs.mr(path, number));
  const level = project.permissions?.project_access?.access_level ?? 0;
  const isAuthor = state.user?.id === issue.author.id;
  const planner = canPlan(project);
  const canEditText = !project.archived && (planner || isAuthor);
  const canDelete = !project.archived && (level === 15 || level === 50);
  const layout = el("div", { class: "issuable-layout" });
  const mainColumn = el("div", { class: "issuable-main-column" });
  const rerender = () => refresh();

  // Header
  const header = el("div", { class: "detail-page-header" });
  const headerMain = el("div", { class: "detail-page-header-body" }, [stateBadge("issue", issue.state)]);
  if (issue.confidential) headerMain.append(el("span", { class: "gl-badge badge-warning badge-md", title: "Confidential" }, [icon("eye-slash", "gl-badge-icon", 14)]));
  if (issue.discussion_locked) headerMain.append(el("span", { class: "gl-badge badge-warning badge-md", title: "Locked" }, [icon("lock", "gl-badge-icon", 14)]));
  headerMain.append(el("span", { class: "issuable-meta" }, [el("span", { text: "Issue created " }), timeElement(issue.created_at), el("span", { text: " by " }), userLink(issue.author, { withAvatar: true })]));
  const headerActions = el("div", { class: "detail-page-header-actions" });
  const setState = (event) => mutateIssue({ state_event: event }, event === "close" ? "Issue closed" : "Issue reopened");
  const mutateIssue = (changes, message) =>
    action(async () => {
      await call("issues.update", { id: project.id, issue_iid: issue.iid, ...changes }, newKey());
      if (message) toast(message);
      rerender();
    });
  if (canEditText) headerActions.append(button(issue.state === "closed" ? "Reopen issue" : "Close issue", { onClick: () => void setState(issue.state === "closed" ? "reopen" : "close") }));
  headerActions.append(
    iconButton("ellipsis_v", "Issue actions", { variant: "default", onClick: (event) =>
      openMenu(event.currentTarget, [
        { label: "New related issue", disabled: project.archived, onSelect: () => navigate(hrefs.newIssue(path)) },
        { label: "Copy reference", onSelect: () => copyText(issue.references.full, "Reference copied") },
        { label: "Copy issue URL", onSelect: () => copyText(issue.web_url, "URL copied") },
        "divider",
        { label: issue.discussion_locked ? "Unlock discussion" : "Lock discussion", disabled: !planner, onSelect: () => void mutateIssue({ discussion_locked: !issue.discussion_locked }, issue.discussion_locked ? "Discussion unlocked" : "Discussion locked") },
        { label: issue.confidential ? "Turn off confidentiality" : "Turn on confidentiality", disabled: !planner, onSelect: () => void mutateIssue({ confidential: !issue.confidential }, issue.confidential ? "Confidentiality turned off" : "Confidentiality turned on") },
        "divider",
        { label: "Report abuse", onSelect: () => notSimulated("Abuse reports") },
        { label: "Delete issue", danger: true, disabled: !canDelete, onSelect: async () => {
          if (!(await confirmModal("Delete issue?", "Are you sure you want to delete this issue? This action cannot be undone.", "Delete issue", { danger: true }))) return;
          await action(async () => {
            await call("issues.delete", { id: project.id, issue_iid: issue.iid }, newKey());
            toast("The issue was successfully deleted.");
            navigate(hrefs.issues(path));
          });
        } },
      ], { align: "end", width: 240 }) }),
  );
  header.append(headerMain, headerActions);
  mainColumn.append(header);
  if (project.archived) mainColumn.append(alert("This is an archived project. Repository and other project resources are read-only.", "warning"));
  if (issue.confidential) mainColumn.append(el("div", { class: "issuable-note-warning" }, [icon("eye-slash"), el("span", { text: "This is a confidential issue. People without permission will never get a notification." })]));

  // Title and description (inline edit)
  const body = el("div", { class: "issue-details issuable-details" });
  const drawView = () => {
    clear(body);
    const titleRow = el("div", { class: "title-container" }, [el("h1", { class: "title", attrs: { dir: "auto" }, text: issue.title })]);
    if (canEditText) {
      const edit = button("Edit", { onClick: drawEdit });
      edit.classList.add("title-edit-button");
      titleRow.append(edit);
    }
    body.append(titleRow);
    if (issue.task_completion_status.count > 0) body.append(el("div", { class: "task-status gl-text-subtle" }, [icon("list-task", "", 14), el("span", { text: ` ${issue.task_completion_status.completed_count} of ${plural(issue.task_completion_status.count, "checklist item")} completed` })]));
    body.append(el("div", { class: "description" }, [issue.description ? markdown(issue.description, { refHref }) : el("p", { class: "gl-text-subtle", text: "No description" })]));
    if (issue.updated_at !== issue.created_at) body.append(el("small", { class: "edited-text" }, [el("span", { text: "Edited " }), timeElement(issue.updated_at)]));
  };
  const drawEdit = () => {
    state.editing = true;
    clear(body);
    const errorHost = el("div");
    const titleInput = el("input", { class: "gl-form-input qa-title-input", attrs: { type: "text", "aria-label": "Title", maxlength: "255" } });
    titleInput.value = issue.title;
    const field = markdownField({ value: issue.description, label: "Description", rows: 10, refHref });
    const save = button("Save changes", { variant: "confirm", type: "submit" });
    const cancel = button("Cancel", { onClick: () => {
      state.editing = false;
      drawView();
    } });
    const form = el("form", { class: "issuable-edit-form" }, [errorHost, el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Title" }), titleInput]), el("div", { class: "gl-form-group" }, [el("label", { class: "gl-form-label", text: "Description" }), field.element]), el("div", { class: "form-actions" }, [save, cancel])]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void action(async () => {
        await call("issues.update", { id: project.id, issue_iid: issue.iid, title: titleInput.value.trim(), description: field.value }, newKey());
        state.editing = false;
        rerender();
      }, { onError: (error) => showFormError(errorHost, error) });
    });
    body.append(form);
    titleInput.focus();
  };
  drawView();
  mainColumn.append(body);

  // Linked items (not simulated)
  mainColumn.append(el("div", { class: "related-issues-block card" }, [el("div", { class: "card-header" }, [el("h3", { class: "card-title" }, [el("span", { text: "Linked items " }), el("span", { class: "gl-badge badge-neutral badge-sm" }, [icon("issues", "gl-badge-icon", 14), el("span", { text: "0" })])]), button("Add", { size: "sm", onClick: () => notSimulated("Linked items") })]), el("div", { class: "card-body gl-text-subtle", text: "Link issues together to show that they're related or that one is blocking others." })]));

  // Activity
  const activityHeader = el("div", { class: "issuable-activity-header" }, [el("h2", { class: "activity-heading", text: "Activity" }), activityControls({ sort: pref.sort, filter: pref.filter, onChange: (value) => {
    saveActivityPreference("issue", value);
    rerender();
  } })]);
  mainColumn.append(activityHeader, timeline(notes, { project, refHref, noteableAuthorId: issue.author.id, labelsByName }));
  const canComment = !project.archived && (!issue.discussion_locked || canReport(project));
  mainColumn.append(
    commentForm({
      canComment,
      lockedMessage: project.archived ? "This project is archived and cannot be commented on." : "The discussion in this issue is locked. Only project members can comment.",
      canInternal: planner,
      refHref,
      onDirty: (dirty) => (state.editing = dirty),
      onSubmit: async (text, { internal }) => {
        await call("notes.save", { id: project.id, work_item_iid: issue.iid, body: text, ...(internal ? { internal: true } : {}) }, newKey());
        rerender();
      },
      closeLabel: canEditText ? (issue.state === "closed" ? "Reopen issue" : "Close issue") : undefined,
      onClose: async () => {
        await call("issues.update", { id: project.id, issue_iid: issue.iid, state_event: issue.state === "closed" ? "reopen" : "close" }, newKey());
        rerender();
      },
    }),
  );

  // Sidebar
  const sidebar = el("aside", { class: "right-sidebar issuable-sidebar", attrs: { "aria-label": "Issue details" } });
  sidebar.append(el("div", { class: "block issuable-sidebar-header" }, [el("span", { class: "gl-text-subtle", text: "To-Do" }), button("Add a to-do item", { size: "sm", onClick: () => notSimulated("To-Do items") })]));
  const updateSidebar = (changes, message) => mutateIssue(changes, message);
  sidebar.append(
    sidebarBlock("Assignee", {
      canEdit: planner,
      onEdit: (anchor) => pickUsers(anchor, project, { title: "Assign to", selectedIds: issue.assignees.map((user) => user.id), onApply: (ids) => void updateSidebar({ assignee_ids: ids }) }),
      content: peopleValue(issue.assignees, { emptyText: "None", assignYourself: planner && state.user ? () => void updateSidebar({ assignee_ids: [state.user.id] }) : undefined }),
    }),
    sidebarBlock("Labels", {
      canEdit: planner,
      onEdit: (anchor) => pickLabels(anchor, project, { selected: issue.labels, onApply: (names) => void updateSidebar({ labels: names.length ? names : "" }) }),
      content: labelsValue(issue.labels, labelsByName, planner ? { onRemove: (name) => void updateSidebar({ remove_labels: [name] }) } : {}),
    }),
    mutedBlock("Milestone", "None", "Milestones"),
    sidebarBlock("Due date", {
      canEdit: planner,
      onEdit: () => editDueDate(issue, updateSidebar),
      content: el("span", { class: issue.due_date ? "" : "no-value", text: issue.due_date ?? "None" }),
    }),
    mutedBlock("Time tracking", "No estimate or time spent", "Time tracking"),
    sidebarBlock("Confidentiality", {
      canEdit: planner,
      editLabel: "Edit",
      onEdit: async () => {
        const turnOn = !issue.confidential;
        if (await confirmModal(turnOn ? "Turn on confidentiality" : "Turn off confidentiality", turnOn ? "Only project members with at least the Planner role, the author, and assignees can view or be notified about this issue." : "Everyone with access to this project can view and be notified about this issue.", turnOn ? "Turn on" : "Turn off")) void updateSidebar({ confidential: turnOn });
      },
      content: el("span", { class: "sidebar-icon-value" }, [icon(issue.confidential ? "eye-slash" : "eye"), el("span", { text: issue.confidential ? "Confidential" : "Not confidential" })]),
    }),
    sidebarBlock("Lock discussion", {
      canEdit: planner,
      onEdit: () => void updateSidebar({ discussion_locked: !issue.discussion_locked }, issue.discussion_locked ? "Discussion unlocked" : "Discussion locked"),
      editLabel: issue.discussion_locked ? "Unlock" : "Lock",
      content: el("span", { class: "sidebar-icon-value" }, [icon(issue.discussion_locked ? "lock" : "lock-open"), el("span", { text: issue.discussion_locked ? "Locked" : "Unlocked" })]),
    }),
    participantsBlock([issue.author, ...issue.assignees, ...notes.map((note) => note.author)]),
    referenceBlock(issue.references.full),
    el("div", { class: "block" }, [button("Move issue", { size: "sm", onClick: () => notSimulated("Moving issues") })]),
  );
  layout.append(mainColumn, sidebar);
  clear(main).append(el("div", { class: "page-padded issue-page" }, [layout]));
}

function editDueDate(issue, update) {
  void openModal("Due date", (body, close, footer) => {
    const input = el("input", { class: "gl-form-input", attrs: { type: "date", "aria-label": "Due date" } });
    input.value = issue.due_date ?? "";
    body.append(el("label", { class: "gl-form-label", text: "Due date" }), input);
    footer.append(button("Remove due date", { variant: "link", onClick: () => {
      close();
      void update({ due_date: null }, "Due date removed");
    } }), button("Cancel", { onClick: () => close() }), button("Apply", { variant: "confirm", onClick: () => {
      close();
      if (input.value) void update({ due_date: input.value }, "Due date updated");
    } }));
  }, { size: "sm" });
}

export { describe, ToolError, withQuery };
