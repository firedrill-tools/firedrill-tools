// Pull request screens: list tab and the pull request page (Conversation · Commits · Files changed) with the
// merge box, reviews, comments and sidebar.
import { chromeSidebarItems } from "./compose.js";
import { $, ToolError, action, avatar, button, call, pageAll, clear, confirmDialog, describe, el, flash, icon, iconButton, key, labelChip, markdown, openMenu, openSelectPanel, plural, timeElement, validationDetail } from "./ui.js";
import { archivedBanner, blankslate, canPush, canTriage, container, errorBlock, hrefs, loadLabels, loadRepo, loadingBlock, navigate, setCrumbs, setRepoNav, setTitle, stateBadge, state, userLink } from "./shared.js";
import { commitTitle, compareBranches, diffStats, fileDiff, shortSha } from "./code.js";
import { assigneesSection, commentBox, commentForm, labelsSection, participantsSection, renderListTab, sidebarSection, timelineEvent } from "./issues.js";

export const renderPulls = (args) => renderListTab({ ...args, kind: "pr" });

function repoCrumbs(repo, extra = []) {
  setCrumbs([{ text: repo.owner.login, href: hrefs.user(repo.owner.login) }, { text: repo.name, href: hrefs.repo(repo.full_name) }, ...extra]);
}

const REVIEW_TEXT = { APPROVED: "approved these changes", CHANGES_REQUESTED: "requested changes", COMMENTED: "reviewed" };

/** Latest non-comment review per reviewer. */
function reviewSummary(reviews) {
  const latest = new Map();
  for (const review of [...reviews].sort((left, right) => left.submitted_at.localeCompare(right.submitted_at))) {
    if (review.state === "COMMENTED" && !latest.has(review.user.login)) latest.set(review.user.login, review);
    if (review.state !== "COMMENTED") latest.set(review.user.login, review);
  }
  return [...latest.values()];
}

function mergeBox({ pull, reviews, repo, owner, repoName, reload, conflicts }) {
  const box = el("div", { class: "merge-box", attrs: { "aria-label": "Merge status" } });
  const status = (tone, iconName, title, text, extra) => {
    const row = el("div", { class: "merge-box-status" });
    row.append(el("span", { class: `merge-status-icon ${tone}`.trim() }, [icon(iconName)]));
    const body = el("div", { class: "status-body" });
    body.append(el("h3", { text: title }));
    if (text) body.append(el("p", { text }));
    if (extra) body.append(extra);
    row.append(body);
    return row;
  };
  const summary = reviewSummary(reviews);
  const approvals = summary.filter((review) => review.state === "APPROVED");
  const changes = summary.filter((review) => review.state === "CHANGES_REQUESTED");

  if (pull.merged) {
    box.append(status("done", "git-merge", "Pull request successfully merged and closed", `You're all set — the ${pull.head.ref} branch can be safely deleted.`));
    return box;
  }
  if (pull.state === "closed") {
    const actions = el("div");
    if (canTriage(repo) || (state.user && pull.user.login === state.user.login)) actions.append(button("Reopen pull request", { onClick: () => action(async () => {
      await call("pulls.update", { owner, repo: repoName, pullNumber: pull.number, state: "open" }, key());
      flash("Pull request reopened.", "success");
      reload();
    }) }));
    box.append(status("", "git-pull-request-closed", "Closed with unmerged commits", `This pull request is closed, but the ${pull.head.ref} branch has unmerged changes.`, actions));
    return box;
  }

  // Reviews line
  if (changes.length > 0) {
    box.append(status("danger", "x", "Changes requested", `${changes.length} review${changes.length === 1 ? "" : "s"} requesting changes by reviewers with write access.`, reviewList(summary)));
  } else if (approvals.length > 0) {
    box.append(status("success", "check", "Changes approved", `${approvals.length} approving review${approvals.length === 1 ? "" : "s"} by reviewers with write access.`, reviewList(summary)));
  } else if (pull.mergeable_state === "blocked") {
    box.append(status("danger", "x", "Review required", "At least 1 approving review is required by reviewers with write access.", summary.length > 0 ? reviewList(summary) : null));
  }

  // Mergeability line
  if (pull.draft) {
    const ready = el("div");
    if (canPush(repo) || (state.user && pull.user.login === state.user.login)) ready.append(button("Ready for review", { onClick: () => action(async () => {
      await call("pulls.update", { owner, repo: repoName, pullNumber: pull.number, draft: false }, key());
      flash("Pull request is ready for review.", "success");
      reload();
    }) }));
    box.append(status("", "git-pull-request-draft", "This pull request is still a work in progress", "Draft pull requests cannot be merged.", ready));
    return box;
  }
  if (pull.mergeable === false || pull.mergeable_state === "dirty") {
    const list = el("div");
    list.append(el("p", { text: "Use the command line or the web editor to resolve conflicts, then update the branch." }));
    if (conflicts && conflicts.length > 0) {
      list.append(el("strong", { class: "text-small", text: "Conflicting files" }));
      const ul = el("ul", { class: "pr-conflict-files" });
      for (const file of conflicts) ul.append(el("li", { text: file }));
      list.append(ul);
    }
    box.append(status("danger", "x", "This branch has conflicts that must be resolved", undefined, list));
    return box;
  }
  if (pull.mergeable === null || pull.mergeable_state === "unknown") {
    box.append(status("", "question", "Checking for ability to merge automatically…", "Mergeability is computed when the pull request changes; reload to check again."));
  } else if (pull.mergeable_state === "blocked") {
    box.append(status("danger", "alert", "Merging is blocked", "The base branch requires an approving review before merging."));
  } else {
    box.append(status("success", "check", "This branch has no conflicts with the base branch", "Merging can be performed automatically."));
  }

  if (!canPush(repo)) {
    box.append(el("div", { class: "merge-box-actions" }, [el("p", { class: "merge-note", text: "Only those with write access to this repository can merge pull requests." })]));
    return box;
  }
  const actions = el("div", { class: "merge-box-actions" });
  const methods = [
    { id: "merge", label: "Create a merge commit", description: `All commits from this branch will be added to the base branch via a merge commit.` },
    { id: "squash", label: "Squash and merge", description: `The ${pull.commits} commit${pull.commits === 1 ? "" : "s"} from this branch will be combined into one commit in the base branch.` },
    { id: "rebase", label: "Rebase and merge", description: `The ${pull.commits} commit${pull.commits === 1 ? "" : "s"} from this branch will be rebased and added to the base branch.` },
  ];
  let method = methods[0];
  const blocked = pull.mergeable_state === "blocked";
  const mergeButton = button(method.label === "Create a merge commit" ? "Merge pull request" : method.label, { variant: "primary", disabled: blocked });
  const caret = button("", { variant: "primary", trailingIcon: "triangle-down", class: "btn-caret", ariaLabel: "Select merge method", disabled: blocked });
  caret.addEventListener("click", () => openMenu(caret, methods.map((entry) => ({ label: entry.label, description: entry.description, checked: entry.id === method.id, onSelect: () => {
    method = entry;
    mergeButton.querySelector(".btn-label").textContent = entry.id === "merge" ? "Merge pull request" : entry.label;
  } })), { width: 360 }));
  const group = el("div", { class: "btn-group" }, [mergeButton, caret]);
  const confirm = el("div", { class: "merge-confirm" });
  confirm.hidden = true;
  actions.append(group, confirm);
  actions.append(el("p", { class: "merge-note", text: blocked ? "Merging is blocked until the review requirement is met." : `You can also merge this with the command line, if you prefer.` }));
  mergeButton.addEventListener("click", () => {
    group.hidden = true;
    clear(confirm);
    confirm.hidden = false;
    const title = el("input", { class: "form-control", attrs: { type: "text", "aria-label": "Commit title" } });
    title.value = method.id === "squash" ? `${pull.title} (#${pull.number})` : `Merge pull request #${pull.number} from ${pull.head.label.replace(":", "/")}`;
    const message = el("textarea", { class: "form-control input-monospace", attrs: { "aria-label": "Commit message" } });
    message.value = method.id === "squash" ? "" : pull.title;
    const errorHost = el("div", { class: "form-note color-fg-danger" });
    if (method.id !== "rebase") confirm.append(title, message);
    else confirm.append(el("p", { class: "text-muted", text: `Rebase and merge replays ${pull.commits} commit${pull.commits === 1 ? "" : "s"} onto ${pull.base.ref}; the commit messages are kept.` }));
    const confirmButton = button(`Confirm ${method.id === "merge" ? "merge" : method.id === "squash" ? "squash and merge" : "rebase and merge"}`, { variant: "primary" });
    const cancel = button("Cancel", { onClick: () => {
      confirm.hidden = true;
      group.hidden = false;
    } });
    confirm.append(errorHost, el("div", { class: "merge-confirm-actions" }, [confirmButton, cancel]));
    confirmButton.addEventListener("click", () =>
      action(
        async () => {
          const args = { owner, repo: repoName, pullNumber: pull.number, merge_method: method.id, sha: pull.head.sha };
          if (method.id === "squash") {
            args.commit_title = title.value.trim() || undefined;
            args.commit_message = message.value.trim() || undefined;
          }
          const result = await call("pulls.merge", args, key());
          flash(`${result.message} (${shortSha(result.sha)}).`, "success");
          reload();
        },
        { onError: (error) => (errorHost.textContent = `${describe(error)}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}`) },
      ),
    );
    title.focus();
  });
  box.append(actions);
  return box;
}

function reviewList(summary) {
  const list = el("ul", { class: "review-list" });
  for (const review of summary) {
    const li = el("li");
    li.append(avatar(review.user, 20), userLink(review.user, ""), el("span", { class: "review-state" }, [icon(review.state === "APPROVED" ? "check" : review.state === "CHANGES_REQUESTED" ? "x" : "comment"), ` ${review.state === "APPROVED" ? "Approved" : review.state === "CHANGES_REQUESTED" ? "Changes requested" : "Commented"}`]));
    list.append(li);
  }
  return list;
}

function reviewChangesButton({ owner, repoName, pull, reload }) {
  const trigger = button("Review changes", { variant: "primary", trailingIcon: "triangle-down" });
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.addEventListener("click", () => {
    const form = el("div", { class: "review-changes-form" });
    form.append(el("h3", { class: "mb-2", text: "Finish your review" }));
    const textarea = el("textarea", { class: "form-control", attrs: { placeholder: "Leave a comment", "aria-label": "Review comment" } });
    form.append(textarea);
    const own = state.user && pull.user.login === state.user.login;
    let event = "COMMENT";
    for (const option of [
      { id: "COMMENT", label: "Comment", description: "Submit general feedback without explicit approval." },
      { id: "APPROVE", label: "Approve", description: own ? "Pull request authors can't approve their own pull request." : "Submit feedback and approve merging these changes." },
      { id: "REQUEST_CHANGES", label: "Request changes", description: own ? "Pull request authors can't request changes on their own pull request." : "Submit feedback that must be addressed before merging." },
    ]) {
      const radio = el("input", { attrs: { type: "radio", name: "review-event", value: option.id } });
      radio.checked = option.id === "COMMENT";
      radio.disabled = own && option.id !== "COMMENT";
      radio.addEventListener("change", () => (event = option.id));
      form.append(el("label", { class: "form-radio" }, [radio, el("span", {}, [el("strong", { text: option.label }), el("div", { class: "text-muted text-small", text: option.description })])]));
    }
    const errorHost = el("div", { class: "form-note color-fg-danger" });
    const submit = button("Submit review", { variant: "primary" });
    form.append(errorHost, submit);
    const overlay = openSelectPanelLike(trigger, form);
    submit.addEventListener("click", () =>
      action(
        async () => {
          await call("pulls.create-review", { owner, repo: repoName, pullNumber: pull.number, event, body: textarea.value }, key());
          overlay.remove();
          flash("Review submitted.", "success");
          reload();
        },
        { onError: (error) => (errorHost.textContent = `${describe(error)}${validationDetail(error) ? ` — ${validationDetail(error)}` : ""}`) },
      ),
    );
    textarea.focus();
  });
  return trigger;
}

/** Position a custom overlay under an anchor the way menus are placed (closes on outside click / Escape). */
function openSelectPanelLike(anchor, content) {
  const overlay = el("div", { class: "overlay", attrs: { role: "dialog", "aria-label": "Review changes" } });
  overlay.style.padding = "0";
  overlay.append(content);
  document.body.append(overlay);
  const rect = anchor.getBoundingClientRect();
  const width = overlay.offsetWidth;
  let left = rect.right - width;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  overlay.style.left = `${left + window.scrollX}px`;
  overlay.style.top = `${rect.bottom + 4 + window.scrollY}px`;
  const close = (event) => {
    if (event.type === "keydown" ? event.key === "Escape" : !overlay.contains(event.target) && !anchor.contains(event.target)) {
      overlay.remove();
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    }
  };
  setTimeout(() => {
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
  });
  return overlay;
}

// ---------------------------------------------------------------------------------------------
// Pull request page
// ---------------------------------------------------------------------------------------------

export async function renderPull({ owner, repo: repoName, number, tab, query, fresh, main }) {
  const repo = await loadRepo(owner, repoName);
  if (!fresh()) return;
  const full = repo.full_name;
  repoCrumbs(repo, [{ text: "Pull requests", href: hrefs.pulls(full) }, { text: `#${number}`, href: hrefs.pull(full, number), current: true }]);
  setRepoNav(repo, "pulls");
  const wrap = container();
  wrap.append(loadingBlock());
  main.append(wrap);
  const read = (method, extra = {}) => call("pulls.read", { owner, repo: repoName, pullNumber: number, method, ...extra });
  let pull;
  let reviews;
  let comments;
  try {
    pull = await read("get");
    [reviews, comments] = await Promise.all([pageAll((page) => read("get_reviews", page), "reviews"), pageAll((page) => read("get_comments", page), "comments")]);
  } catch (error) {
    if (!fresh()) return;
    clear(wrap).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  const labels = await loadLabels(owner, repoName).catch(() => []);
  if (!fresh()) return;
  setTitle(`${pull.title} by ${pull.user.login} · Pull Request #${number} · ${full}`);
  clear(wrap);
  const banner = archivedBanner(repo);
  if (banner) wrap.append(banner);
  const reload = () => navigate(location.hash);
  const own = state.user && pull.user.login === state.user.login;
  const mayEdit = !repo.archived && (own || canTriage(repo));
  const update = (patch) => call("pulls.update", { owner, repo: repoName, pullNumber: number, ...patch }, key());

  // Header
  const header = el("div", { class: "gh-header" });
  const titleRow = el("div", { class: "gh-header-title" });
  const h1 = el("h1", {}, [el("span", { text: pull.title }), " ", el("span", { class: "issue-number", text: `#${pull.number}` })]);
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
    titleInput.value = pull.title;
    editForm.append(titleInput, button("Save", { variant: "primary", onClick: () => action(async () => {
      if (titleInput.value.trim() && titleInput.value.trim() !== pull.title) await update({ title: titleInput.value.trim() });
      state.editing = false;
      reload();
    }) }), button("Cancel", { onClick: () => {
      state.editing = false;
      editForm.hidden = true;
      h1.hidden = false;
      headerActions.hidden = false;
    } }));
  }
  if (!repo.archived && pull.state === "open" && !pull.merged) headerActions.append(reviewChangesButton({ owner, repoName, pull, reload }));
  titleRow.append(h1, editForm, headerActions);
  header.append(titleRow);
  const meta = el("div", { class: "gh-header-meta" });
  meta.append(stateBadge(pull, "pr"));
  const sentence = el("span");
  const commitsText = plural(pull.commits, "commit");
  if (pull.merged) sentence.append(userLink(pull.merged_by ?? pull.user), ` merged ${commitsText} into `, el("span", { class: "branch-name commit-ref", text: pull.base.ref }), " from ", el("span", { class: "branch-name commit-ref", text: pull.head.ref }), " ", timeElement(pull.merged_at));
  else if (pull.state === "closed") sentence.append(userLink(pull.user), ` wants to merge ${commitsText} into `, el("span", { class: "branch-name commit-ref", text: pull.base.ref }), " from ", el("span", { class: "branch-name commit-ref", text: pull.head.ref }), " · closed ", timeElement(pull.closed_at));
  else sentence.append(userLink(pull.user), ` wants to merge ${commitsText} into `, el("a", { class: "branch-name commit-ref", text: pull.base.ref, href: hrefs.tree(full, pull.base.ref) }), " from ", el("a", { class: "branch-name commit-ref", text: pull.head.ref, href: hrefs.tree(full, pull.head.ref) }));
  meta.append(sentence);
  header.append(meta);
  const tabs = el("nav", { class: "tabnav", attrs: { "aria-label": "Pull request" } });
  for (const entry of [
    { id: "conversation", label: "Conversation", icon: "comment", count: pull.comments + reviews.reviews.filter((review) => review.body).length },
    { id: "commits", label: "Commits", icon: "git-commit", count: pull.commits },
    { id: "files", label: "Files changed", icon: "file", count: pull.changed_files },
  ]) {
    const a = el("a", { class: "tabnav-tab", href: hrefs.pull(full, number, entry.id === "conversation" ? undefined : entry.id), attrs: { "aria-current": tab === entry.id ? "page" : undefined } });
    a.append(icon(entry.icon), el("span", { text: entry.label }), el("span", { class: "Counter", text: String(entry.count) }));
    tabs.append(a);
  }
  header.append(tabs);
  wrap.append(header);

  if (tab === "commits") return renderCommitsTab({ wrap, read, full, fresh });
  if (tab === "files") return renderFilesTab({ wrap, read, pull, full, fresh });

  // Conversation
  const layout = el("div", { class: "Layout" });
  const mainCol = el("div", { class: "Layout-main" });
  const side = el("div", { class: "Layout-sidebar discussion-sidebar" });
  layout.append(mainCol, side);
  wrap.append(layout);
  const timeline = el("div", { class: "timeline" });
  timeline.append(commentBox({ user: pull.user, association: pull.author_association, createdAt: pull.created_at, body: pull.body || "", verb: "commented", onEdit: mayEdit ? async (text) => {
    await update({ body: text });
    reload();
  } : undefined }));
  const events = [
    ...comments.comments.map((comment) => ({ at: comment.created_at, kind: "comment", comment })),
    ...reviews.reviews.map((review) => ({ at: review.submitted_at, kind: "review", review })),
  ].sort((left, right) => left.at.localeCompare(right.at));
  for (const entry of events) {
    if (entry.kind === "comment") {
      timeline.append(commentBox({ user: entry.comment.user, association: entry.comment.author_association, createdAt: entry.comment.created_at, body: entry.comment.body }));
      continue;
    }
    const review = entry.review;
    if (review.body) {
      timeline.append(commentBox({ user: review.user, association: review.author_association, createdAt: review.submitted_at, body: review.body, verb: REVIEW_TEXT[review.state] ?? "reviewed", className: review.state === "APPROVED" ? "review-approved" : "", extraHeader: review.state === "APPROVED" ? el("span", { class: "Label Label--success", text: "Approved" }) : review.state === "CHANGES_REQUESTED" ? el("span", { class: "Label Label--danger", text: "Changes requested" }) : undefined }));
    } else {
      timeline.append(timelineEvent({ user: review.user, text: REVIEW_TEXT[review.state] ?? "reviewed", iconName: review.state === "APPROVED" ? "check" : review.state === "CHANGES_REQUESTED" ? "x" : "eye", tone: review.state === "APPROVED" ? "success" : review.state === "CHANGES_REQUESTED" ? "danger" : "", when: review.submitted_at }));
    }
  }
  if (pull.merged) timeline.append(timelineEvent({ user: pull.merged_by ?? pull.user, text: `merged commit ${shortSha(pull.merge_commit_sha ?? "")} into ${pull.base.ref}`, iconName: "git-merge", tone: "done", when: pull.merged_at }));
  else if (pull.state === "closed") timeline.append(timelineEvent({ user: pull.user, text: "closed this", iconName: "git-pull-request-closed", tone: "danger", when: pull.closed_at }));
  mainCol.append(timeline);

  let conflicts;
  if (pull.state === "open" && (pull.mergeable === false || pull.mergeable_state === "dirty")) {
    try {
      conflicts = (await compareBranches(owner, repoName, pull.base.ref, pull.head.ref)).conflicts;
    } catch {
      conflicts = undefined;
    }
    if (!fresh()) return;
  }
  mainCol.append(mergeBox({ pull, reviews: reviews.reviews, repo, owner, repoName, reload, conflicts }));

  if (!repo.archived) {
    const controls = [];
    let pendingText = "";
    if (pull.state === "open" && !pull.merged && mayEdit) {
      const closeButton = button("Close pull request", { icon: "git-pull-request-closed" });
      closeButton.addEventListener("click", () => action(async () => {
        if (!(await confirmDialog("Close pull request", `#${pull.number} will be closed without merging. You can reopen it later.`, "Close pull request"))) return;
        if (pendingText.trim()) await call("issues.add-comment", { owner, repo: repoName, issue_number: number, body: pendingText }, key());
        await update({ state: "closed" });
        state.editing = false;
        flash("Pull request closed.", "success");
        reload();
      }));
      controls.push(closeButton);
    }
    const form = commentForm({
      primary: { label: "Comment", onSubmit: async (text) => {
        await call("issues.add-comment", { owner, repo: repoName, issue_number: number, body: text }, key());
        flash("Comment added.", "success");
        reload();
      } },
      secondary: controls,
      locked: pull.locked && !canTriage(repo),
    });
    form.addEventListener("comment-input", (event) => {
      pendingText = event.detail;
      const label = controls[0]?.querySelector(".btn-label");
      if (label) label.textContent = pendingText.trim() ? "Close with comment" : "Close pull request";
    });
    mainCol.append(form);
  }

  // Sidebar
  const people = [...new Map([...(state.user ? [state.user] : []), pull.user, ...pull.assignees, ...pull.requested_reviewers, ...reviews.reviews.map((review) => review.user), ...comments.comments.map((comment) => comment.user)].map((user) => [user.login, user])).values()];
  const reviewerRows = el("div", { class: "sidebar-people" });
  const summary = reviewSummary(reviews.reviews);
  const shown = new Map();
  for (const review of summary) shown.set(review.user.login, { user: review.user, state: review.state });
  for (const requested of pull.requested_reviewers) if (!shown.has(requested.login)) shown.set(requested.login, { user: requested, state: "REQUESTED" });
  if (shown.size === 0) reviewerRows.append(el("span", { class: "text-muted", text: "No reviews" }));
  for (const { user, state: reviewState } of shown.values()) {
    const row = el("span", { class: "sidebar-person" }, [avatar(user, 20), el("span", { text: user.login })]);
    row.append(el("span", { class: `review-status ml-auto ${reviewState === "APPROVED" ? "approved" : reviewState === "CHANGES_REQUESTED" ? "changes" : ""}`, title: reviewState === "REQUESTED" ? "Awaiting requested review" : reviewState }, [icon(reviewState === "APPROVED" ? "check-circle-fill" : reviewState === "CHANGES_REQUESTED" ? "x-circle-fill" : reviewState === "REQUESTED" ? "clock" : "comment")]));
    reviewerRows.append(row);
  }
  side.append(sidebarSection("Reviewers", {
    onGear: canPush(repo) && pull.state === "open"
      ? (anchor) =>
          openSelectPanel(anchor, {
            title: "Request up to 15 reviewers",
            placeholder: "Type or choose a user",
            options: people.filter((user) => user.login !== pull.user.login).map((user) => ({ id: user.login, label: user.login, avatar: avatar(user, 20), selected: pull.requested_reviewers.some((requested) => requested.login === user.login) })),
            onApply: (selected) => {
              const before = pull.requested_reviewers.map((user) => user.login).sort().join(",");
              if (before !== [...selected].sort().join(",")) void action(async () => {
                await update({ reviewers: selected });
                flash("Reviewers updated.", "success");
                reload();
              });
            },
            footer: el("span", { text: "The pull request author cannot review their own changes." }),
          })
      : undefined,
  }, [reviewerRows]));
  side.append(assigneesSection(pull, repo, people, async (logins) => {
    const added = logins.filter((login) => !pull.assignees.some((assignee) => assignee.login === login));
    if (added.length === 0) {
      flash("Removing assignees from pull requests is not supported by this Tool.", "warn");
      return;
    }
    await call("issues.add-assignees", { owner, repo: repoName, issue_number: number, assignees: added }, key());
    flash("Assignees updated.", "success");
    reload();
  }));
  side.append(labelsSection(pull, repo, labels, async (names) => {
    const current = pull.labels.map((label) => label.name);
    const added = names.filter((name) => !current.some((existing) => existing.toLowerCase() === name.toLowerCase()));
    const removed = current.filter((name) => !names.some((wanted) => wanted.toLowerCase() === name.toLowerCase()));
    if (added.length > 0) await call("issues.add-labels", { owner, repo: repoName, issue_number: number, labels: added }, key());
    for (const name of removed) await call("issues.remove-label", { owner, repo: repoName, issue_number: number, name }, key());
    flash("Labels updated.", "success");
    reload();
  }));
  side.append(...chromeSidebarItems(false));
  if (pull.state === "open" && !pull.merged && mayEdit) {
    const draftToggle = el("div", { class: "discussion-sidebar-item" });
    draftToggle.append(button(pull.draft ? "Ready for review" : "Convert to draft", { size: "sm", onClick: () => action(async () => {
      if (!pull.draft && !(await confirmDialog("Convert to draft", "This pull request will be marked as a draft and cannot be merged until it is marked ready for review.", "Convert to draft"))) return;
      await update({ draft: !pull.draft });
      flash(pull.draft ? "Pull request is ready for review." : "Pull request converted to draft.", "success");
      reload();
    }) }));
    side.append(draftToggle);
  }
  side.append(participantsSection([...new Map([pull.user, ...reviews.reviews.map((review) => review.user), ...comments.comments.map((comment) => comment.user)].map((user) => [user.login, user])).values()]));
}

async function renderCommitsTab({ wrap, read, full, fresh }) {
  const host = el("div", {}, [loadingBlock()]);
  wrap.append(host);
  let result;
  try {
    result = await pageAll((page) => read("get_commits", page), "commits");
  } catch (error) {
    if (!fresh()) return;
    clear(host).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  clear(host);
  if (result.commits.length === 0) {
    host.append(blankslate("git-commit", "No commits", "This pull request has no commits."));
    return;
  }
  const box = el("div", { class: "Box mt-3" });
  box.append(el("div", { class: "Box-header" }, [el("span", { class: "Box-title", text: `Commits (${result.total_count})` })]));
  for (const commit of result.commits) {
    const row = el("div", { class: "commit-row Box-row" });
    const body = el("div", { class: "commit-row-main" });
    body.append(el("a", { class: "commit-row-title", text: commitTitle(commit.commit.message), href: hrefs.commit(full, commit.sha), title: commit.commit.message }));
    const author = commit.author ?? { login: commit.commit.author.name };
    const metaRow = el("div", { class: "commit-row-meta" });
    metaRow.append(avatar(author, 16), el("a", { class: "commit-author", text: author.login, href: hrefs.user(author.login) }), " committed ", timeElement(commit.commit.author.date));
    body.append(metaRow);
    row.append(body, el("div", { class: "commit-row-actions" }, [el("a", { class: "commit-sha", text: shortSha(commit.sha), href: hrefs.commit(full, commit.sha) })]));
    box.append(row);
  }
  host.append(box);
}

async function renderFilesTab({ wrap, read, pull, full, fresh }) {
  const host = el("div", {}, [loadingBlock()]);
  wrap.append(host);
  let result;
  try {
    result = await pageAll((page) => read("get_files", page), "files");
  } catch (error) {
    if (!fresh()) return;
    clear(host).append(errorBlock(error));
    return;
  }
  if (!fresh()) return;
  clear(host);
  host.append(diffStats(result.total_count, pull.additions, pull.deletions));
  if (result.files.length === 0) host.append(blankslate("diff", "No changes", "This pull request introduces no file changes."));
  for (const file of result.files) host.append(fileDiff(file, full, pull.head.sha));
}
