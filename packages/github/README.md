# @firedrill-tools/tool-github

A synthetic **GitHub** instance for [Firedrill](https://firedrill.run): one fictional forge holding a handful of
repositories, exposed through a bounded subset of the GitHub REST API (`X-GitHub-Api-Version: 2022-11-28` shapes)
and through the tool names of the official GitHub MCP server. Agents that talk to GitHub over Octokit-style REST
calls or over MCP can be exercised against it without a real repository, token or network access.

Everything is computed from the world's state: issues, pull requests, comments, reviews, labels, branches and a
small synthetic commit graph (each commit carries a flat tree snapshot, so file contents, diffs, merge bases,
mergeability and merges are real computations over that graph). Nothing here contacts github.com.

Package id `github`, version `0.1.0`, engine `>=0.1.0 <0.2.0`, license Apache-2.0. The package ships a backend
(REST + MCP + canonical operations) **and a browser app** that recreates github.com's repository UI over the same
26 operations (see [Browser app](#browser-app)).

## Install

```sh
firedrill tool add ./firedrill-tools-tool-github-0.1.1.tgz --install   # or the npm name once published
firedrill serve --scenario baseline --no-open
```

`firedrill serve` prints the HTTP/MCP endpoints and the app link (also **Tools → Open app** in the inspector); the
app runs as the actor selected for `serve`.

**First run.** In a fresh project, `firedrill tool add … --install` creates the world, copies the 82 starter rows
and creates an actor (e.g. `local-dev`) with the 26 grants and no attributes. That actor works immediately: it acts
as the primary seeded user `dana-reyes` (see "Identities"), so `GET /user`, `GET /user/repos`, issue search and the
app show the Acme Robotics repositories straight away. `tool add` also copies the starter `virtualTimeUs`
(`1789376400000000`, 2026-09-14T09:00:00Z, shortly after the latest seeded timestamp), so the new world has the same
clock as the author world: seeded items render as relative dates ("2 days ago") and new records are stamped at
2026-09-14T09:00:00Z.

A new world receives the starter data and the grants below. Existing worlds do not change silently: add the
grants and (optionally) the `starter.json` rows to your own world or scenario.

### Identities

The caller is resolved on every call from the actor's attributes:

| actor attribute | effect |
|---|---|
| `login` present | must name a `users` row with `type: "User"` (case-insensitive). Anything else — an unknown login, an organisation login, an empty or non-string value — fails every operation with `UNAUTHORIZED` 401 `Bad credentials`, exactly like a bad token. |
| `login` absent (e.g. the actor `firedrill tool add` creates) | the primary seeded user: the `type: "User"` row with the lowest numeric `id` (ties by login). In the starter data that is `dana-reyes` (admin of every repository). Only a world with no user rows at all answers `UNAUTHORIZED`. |

Set `login` on additional actors to act as someone else (`sam-okoro`, `priya-nair`, `lee-chen`, `release-bot`).

### Grants

Every actor that should use the Tool needs the grants for the operations it may call (`packageId: "github"`):

```
users.get-authenticated  repos.list-for-authenticated-user  repos.get  repos.list-branches  repos.get-branch
repos.create-branch  repos.list-commits  repos.get-commit  repos.get-content  repos.create-or-update-file
issues.list-labels-for-repo  issues.list  issues.read  issues.write  issues.add-comment  issues.add-labels
issues.remove-label  issues.add-assignees  issues.search  pulls.list  pulls.read  pulls.create  pulls.update
pulls.create-review  pulls.check-merged  pulls.merge
```

Repository-level permission is **not** a grant: it comes from the `collaborators` rows (`admin` > `maintain` >
`write` > `triage` > `read`; the repository owner is `admin`). Public repositories are readable by every
authenticated login; private ones are invisible (404) to non-collaborators; archived ones reject every write with
403; `write` and above may push, open pulls and merge; `triage` and above may label, assign, close and comment on
locked issues; approvals only count from `write`+ reviewers other than the author.

### Connections

Two connection recipes are declared: `octokit` (`GITHUB_API_URL` = the HTTP binding, `GITHUB_TOKEN` = its token;
send it as `Authorization: token …` or `Bearer …`) and `github-mcp` (`GITHUB_MCP_URL` / `GITHUB_PERSONAL_ACCESS_TOKEN`
for the MCP binding). The values are isolated world tokens for test processes only.

## Starting data

`starter.json` (and the conformance `firedrill/world.json`) contain 82 fictional rows, virtual time
2026-09-14T09:00:00Z: an organisation `acme-robotics` and five users (`dana-reyes` admin, `sam-okoro` maintainer,
`priya-nair` write, `lee-chen` triage, `release-bot` write); three repositories — `acme-robotics/telemetry-service`
(public, protected `main` requiring one approving review with stale-review dismissal, 12 issues, 5 pulls, five
branches with slashed names), `acme-robotics/fleet-console` (private, one merged pull with a two-parent merge
commit) and `dana-reyes/dotfiles` (public, archived); 13 commits with small TypeScript/Markdown trees; 10 labels
(including `priority: high` and `good first issue`); 15 issues (open, closed as completed / not planned /
duplicate, one locked, one with an empty body, one bot-authored); 8 comments; 6 pulls (clean, blocked by
protection, dirty with conflicting edits, draft, closed with a deleted head branch, merged); 4 reviews. All names
and addresses are fictional (`@example.test`).

## Operations

Canonical MCP names are `github.<operation>`; the alias column is the official GitHub MCP server tool name that is
also exposed (same input shape and result). Results are GitHub REST resource objects.

| operation | MCP alias | HTTP route(s) |
|---|---|---|
| `users.get-authenticated` | `get_me` | `GET /user` |
| `repos.list-for-authenticated-user` | — | `GET /user/repos` |
| `repos.get` | — | `GET /repos/{owner}/{repo}` |
| `repos.list-branches` | `list_branches` | `GET /repos/{owner}/{repo}/branches` |
| `repos.get-branch` | — | `GET /repos/{owner}/{repo}/branches/{branch}` (one or two path segments) |
| `repos.create-branch` | `create_branch` | `POST /repos/{owner}/{repo}/git/refs` |
| `repos.list-commits` | `list_commits` | `GET /repos/{owner}/{repo}/commits` |
| `repos.get-commit` | `get_commit` | `GET /repos/{owner}/{repo}/commits/{ref}` (one or two segments) |
| `repos.get-content` | `get_file_contents` | `GET /repos/{owner}/{repo}/contents[/{path}]` (path up to four segments) |
| `repos.create-or-update-file` | `create_or_update_file` | `PUT /repos/{owner}/{repo}/contents/{path}` (up to four segments) |
| `issues.list-labels-for-repo` | — | `GET /repos/{owner}/{repo}/labels` |
| `issues.list` | `list_issues` | `GET /repos/{owner}/{repo}/issues` |
| `issues.read` | `issue_read` | `GET …/issues/{n}`, `GET …/issues/{n}/comments`, `GET …/issues/{n}/labels` |
| `issues.write` | `issue_write` | `POST …/issues`, `PATCH …/issues/{n}` |
| `issues.add-comment` | `add_issue_comment` | `POST …/issues/{n}/comments` |
| `issues.add-labels` | — | `POST …/issues/{n}/labels` |
| `issues.remove-label` | — | `DELETE …/issues/{n}/labels/{name}` |
| `issues.add-assignees` | — | `POST …/issues/{n}/assignees` |
| `issues.search` | `search_issues` | `GET /search/issues` |
| `pulls.list` | `list_pull_requests` | `GET /repos/{owner}/{repo}/pulls` |
| `pulls.read` | `pull_request_read` | `GET …/pulls/{n}`, `…/files`, `…/commits`, `…/reviews` (comments via `issues/{n}/comments`) |
| `pulls.create` | `create_pull_request` | `POST /repos/{owner}/{repo}/pulls` |
| `pulls.update` | `update_pull_request` | `PATCH …/pulls/{n}` |
| `pulls.create-review` | `pull_request_review_write` | `POST …/pulls/{n}/reviews` |
| `pulls.check-merged` | — | `GET …/pulls/{n}/merge` (204 / 404) |
| `pulls.merge` | `merge_pull_request` | `PUT …/pulls/{n}/merge` (`merge`, `squash`, `rebase`) |

41 routes in total. Lists use GitHub's `page` / `per_page` model with a `link` header (`next`, `prev`, `first`,
`last`; host-less relative targets); `list_issues` additionally accepts the MCP server's `after` cursor and returns
`page_info`. Every response must stay under the framework's 1 MiB HTTP cap, so pages are cut by count **and** by
UTF-8 bytes: a page holds at most `per_page` items and about 900 KB of encoded items, cut greedily from the start of
the ordered list, so page N is stable and every item appears on exactly one page. A page can therefore hold fewer
than `per_page` items while more follow: clients follow `link` (REST) or the canonical `total_pages` field (lists,
`issues.read`/`pulls.read` list methods, `issues.search` and `repos.get-commit` files), never "short page = end".
`GET …/commits/{ref}` pages its `files` the same way with a `link` header, and a file whose diff alone cannot fit
loses `patch` (as GitHub omits it for large diffs). A contents response (file or directory listing) that cannot fit
answers 422 `Validation Failed` (`resource: Contents`, `field: path`, `code: too_large`). Errors use GitHub's envelope `{ "message", "documentation_url", "status" }` plus `errors[]` for 422s:
`UNAUTHORIZED` 401 `Bad credentials`, `FORBIDDEN` 403, `NOT_FOUND` 404, `METHOD_NOT_ALLOWED` 405 (`Pull Request is
not mergeable`, review required), `CONFLICT` 409 (stale file sha, head branch modified), `VALIDATION_FAILED` 422,
`RATE_LIMITED` 403 with `retry-after`, `SERVICE_UNAVAILABLE` 503. Framework outcomes are rendered GitHub-shaped
too: a missing grant is 403 `Resource not accessible by personal access token`, an argument that fails the
operation's input schema is 400 (GitHub would answer 422), a request the REST codec cannot map (`content` that is
not base64 of UTF-8 text, a JSON body nested more than 512 levels deep, a non-boolean `protected`) is the framework's
400 `HTTP_REQUEST_MAPPING_FAILED`, an unknown route is 404. REST `page` / `per_page` coerce exactly as
api.github.com does: a value that is not a positive integer (`abc`, `0`, `-5`, `2.5`, blank, `__proto__`) falls back
to the default (page 1, 30 items) and `per_page` above 100 is clamped to 100, answering 200; the canonical
`page`/`perPage` arguments keep their schema (integers, `perPage` 1–100).

Date inputs (`since`, `until`, search `created:`/`updated:`/`closed:`) accept ISO-8601 dates and date-times; a value
without a zone designator is read as UTC, so results never depend on the machine's time zone. The canonical
`users.get-authenticated` result (and MCP `get_me`) carries one Tool extension, `server_time` — the world's virtual
time — which `GET /user` omits. A canonical or MCP `issues.search` call that gives neither `query` nor `q` lists every
issue and pull request visible to the caller (no qualifiers); `GET /search/issues` without `q` stays GitHub's 422, and
giving both `query` and `q` is a 422.

Malformed percent-encoding: the framework decodes query strings leniently, so an invalid UTF-8 sequence such as
`%E0%A4%A` reaches the Tool as U+FFFD. Search `q`/`query`, the `issues.list` filters (`labels`, `assignee`, `creator`,
`milestone`, `state`, `sort`, `direction`, `since`), `repos.list-commits` (`path`, `author`, `sha`, `since`, `until`)
and `pulls.list` (`head`, `base`, `state`, `sort`, `direction`) answer 422 `Validation Failed` naming the field
(`code: invalid`) instead of silently matching nothing. A correctly encoded U+FFFD (`%EF%BF%BD`) is rejected the same
way. `%ZZ` is not malformed UTF-8 and stays literal text. Non-ASCII searches and label names (`café`, `漢字`, emoji) work.

### Issue search qualifiers

`repo:`, `is:issue|pr|open|closed|merged|unmerged|draft`, `type:`, `state:`, `author:` (incl. `@me`),
`assignee:`, `label:` (quoted names allowed), `no:assignee|label`, `in:title|body|comments`, `created:` /
`updated:` / `closed:` (`>`, `<`, `>=`, `<=`, `A..B`), `comments:` (same operators), negation with `-` on `label:`,
`assignee:`, `author:`, `is:`, and bare words / `"phrases"` (every term must match). Any other qualifier is a 422
naming the qualifier (GitHub would treat it as text).

## Browser app

`firedrill/tools/github/app/site/` is a static, hash-routed recreation of github.com's light-theme repository UI
(Primer palette, system font stack with a bundled Noto Sans fallback, Octicons, 1280 px container, GitHub's
global header with hamburger menu, breadcrumb, `/` search, command palette and Copilot buttons, `+` menu, issues,
pull requests, notifications inbox and avatar; repository UnderlineNav with all nine tabs; footer link row). Every control calls the Tool's own operations
through `/_firedrill/client.js`; nothing is cached as authority — lists re-read after each write and whenever the
world revision changes (2 s poll, paused while a form has unsaved text), mutations carry an idempotency key, and
destructive or irreversible actions (close, merge, convert to draft, discard edits) ask for confirmation.

| screen (hash route) | what it does | operations |
|---|---|---|
| Dashboard `#/` | "Top repositories" rail with filter; Home feed of recently updated open issues and pull requests | `repos.list-for-authenticated-user`, `issues.search` |
| Repository Code tab `#/{owner}/{repo}`, `…/tree/{ref}/{path}` | title + Public/Private/Public archive badge, archived banner, Pin / Watch (count) / Fork (count) / Star buttons, branch selector, branch count, Tags, Go to file filter, Add file, Code menu, latest-commit bar with commit count, file table with last commit per entry, README rendered from Markdown (headings, lists, code, emphasis; no HTML), About column (description, homepage, topics, licence, activity, watching/forks), Releases and Packages (not simulated), Contributors (distinct commit authors on the default branch), Languages bar | `repos.get`, `repos.list-branches`, `repos.get-content`, `repos.list-commits` |
| File `…/blob/{ref}/{path}` | line-numbered view, lines/loc/size, Raw toggle, Copy, History, pencil (write access only) | `repos.get-content` |
| Editor `…/edit/{ref}/{path}`, `…/new/{ref}/{dir}` | textarea editor, "Commit changes…" dialog with message, extended description, "Commit directly to `{ref}`" or "Create a new branch for this commit and start a pull request" (→ compare page); stale-sha conflicts are shown inline | `repos.create-or-update-file`, `repos.create-branch` |
| Commits `…/commits/{ref}?path=` and commit page `…/commit/{sha}` | day-grouped history with sha chips and Browse files; commit page with parents, stats and per-file unified diffs from `patch` | `repos.list-commits`, `repos.get-commit` |
| Branches `…/branches` | Default / Active tables with last-commit author and time, New branch dialog (name + source), New pull request per branch | `repos.list-branches`, `repos.get-branch`, `repos.create-branch` |
| Issues `…/issues?q=&page=` | search box (`is:issue is:open …`), Labels and Milestones buttons, Open/Closed counters, Author / Labels / Projects / Milestones / Types / Assignee / Sort menus (Projects, Milestones and Types are not simulated), label chips with contrast text, assignee stacks, comment counts, Previous/Next; unsupported qualifiers show the API's 422 message | `issues.list` (plain filters), `issues.search` (text or other qualifiers), `issues.list-labels-for-repo` |
| New issue `…/issues/new` | title, description with Write/Preview tabs and the same Markdown toolbar as the comment box, Assignees/Labels pickers, Type / Projects / Milestone (not simulated), Create | `issues.write` (`create`) |
| Issue page `…/issues/{n}` | state badge, inline title edit, timeline of body + comments (author association badges, kebab → Edit body), closed/locked events, Write/Preview comment box with GitHub's Markdown toolbar (heading, bold, italic, quote, code, link, numbered/bulleted/task lists, mention, reference edit the text locally; attach files and saved replies are not simulated) and Comment, "Close issue" split button (as completed / not planned / duplicate → "Close with comment"), Reopen; sidebar Assignees (gear picker, "assign yourself"), Labels (gear picker), Type / Projects / Milestone / Relationships / Development / Notifications (not simulated), participants | `issues.read` (`get`, `get_comments`), `issues.write` (`update`), `issues.add-comment` |
| Labels `…/labels` | chip, description, open-issue count per label | `issues.list-labels-for-repo`, `issues.list` |
| Pull requests `…/pulls` | same list UI with PR state icons (open / draft / merged / closed) and review status glyphs | `pulls.list`, `issues.search`, `pulls.read` (`get_reviews`) |
| Pull request `…/pull/{n}[/commits|/files]` | Conversation · Commits · Files changed tabs; "wants to merge N commits into `base` from `head`"; reviews as timeline events or comment boxes; merge box for every `mergeable_state` (clean → "Merge pull request" with Create a merge commit / Squash and merge / Rebase and merge and a Confirm step; blocked → "Review required"; dirty → conflicting files; draft → "Ready for review"; merged; closed → Reopen); "Review changes" (Comment / Approve / Request changes); Close / Close with comment; sidebar Reviewers (gear → request reviewers), Assignees, Labels, Projects / Milestone / Development / Notifications (not simulated), Convert to draft | `pulls.read` (all methods), `pulls.merge`, `pulls.update`, `pulls.create-review`, `issues.add-comment`, `issues.add-assignees`, `issues.add-labels`, `issues.remove-label` |
| Compare `…/compare/{base}...{head}` | base/compare selectors, "Able to merge" / "Can't automatically merge" preview (computed client-side from the two histories' changed paths — informational), commit and file counts, Create pull request / Create draft pull request | `repos.list-commits`, `repos.get-commit`, `pulls.create` |
| Search `#/search?q=`, Your issues `#/issues`, Your pull requests `#/pulls` | cross-repository results with repository prefix and Sort menu | `issues.search` |
| Profile `#/{login}` | identity card + the login's open issues and pull requests | `issues.search` |

States: loading skeletons and spinners, blankslates ("Welcome to issues!", "No results matched your search.",
"There isn't anything to compare"), the framework's denied outcome as "You don't have permission to do that"
(and a full-page notice when `users.get-authenticated` itself is denied), `UNAUTHORIZED` as a "Bad credentials"
page, 404 pages, rate-limit and 503 flashes with the API's own message, archived-repository banner with write
controls hidden, write-access gating of pencil / Add file / New pull request / merge, self-review prevention,
keyboard `/` (search) and `g c` / `g i` / `g p` / `g b`, phone widths (sidebar stacks under the timeline; repository tabs that do not fit collapse into a "…" overflow menu;
the latest-commit bar keeps the author, message and commit count; pull request tabs scroll inside their own bar).

Deliberate differences from github.com: avatars are initials on a deterministic colour (records carry no images);
assignee and reviewer pickers offer the people already visible on the page (there is no collaborator-listing
operation); removing an assignee from a pull request is not offered (the API subset has no removal for pulls);
Markdown rendering is a small safe subset built with DOM calls; the Home feed is derived from recently updated open
items, not an activity stream; the Star button has no counter because star counts are not modelled.

**Not simulated controls.** These render in place with GitHub's Octicons, hover states and tooltips, and open a
short "not simulated by this Tool" panel instead of doing anything: header Copilot button and menu, command
palette, notifications inbox; repository Pin, Watch, Fork and Star buttons and their carets; the Actions,
Projects, Wiki, Security, Insights and Settings tabs (Settings only for admins); Tags link; About-column Releases
and Packages; Milestones button and the Projects / Milestones / Types (issues) / Reviews (pull requests) list
filters; new issue, issue and pull request sidebar Type, Projects, Milestone, Relationships, Development and Notifications
(Subscribe); composer Attach files and Saved replies; footer links (Terms, Privacy, Security, Status, Community,
Docs, Contact, Manage cookies, Do not share my personal information). Disabled: `+` menu "New repository".
The app never contacts github.com and never asks for credentials — the identity is the actor chosen in Firedrill.

## Events and faults

Events: `issues.changed` (`opened`, `edited`, `closed`, `reopened`, `labeled`, `unlabeled`, `assigned`,
`unassigned`), `issue-comment.created`, `pull-request.changed` (`opened`, `edited`, `closed` with `merged` and
`merge_commit_sha`, `reopened`, `ready_for_review`, `converted_to_draft`, `review_requested`, `review_submitted`).
Branch creation and file commits emit no event (GitHub's `push`/`create` webhooks are out of scope).

Faults: `api-rate-limited` (every write answers 403 `API rate limit exceeded …` with `retry-after: 60` and
`x-ratelimit-remaining: 0`; reads keep working) and `merge-unavailable` (`pulls.merge` and
`repos.create-or-update-file` answer 503 `Service Unavailable`). Neither changes state.

## Conformance

`firedrill tool test github` runs ten drills (REST flow, MCP aliases, write and triage permissions, denied
actor, bad credentials, default identity for an actor without attributes, both faults, response byte budget) twice and requires every operation, declared error, event and fault to be
observed. The scripted target (`test/conformance.mjs`, Node built-ins only) is a Tool test, not evidence of
model-driven agent behaviour.

## Protocol compatibility

Not verified against a real client. Route paths, query/body field names, status codes, pagination headers and
error envelopes follow the GitHub REST API reference (2022-11-28) and the MCP alias names and argument names
follow the `github/github-mcp-server` README as read on 2026-09-14, but neither `@octokit/rest`, `PyGithub`, `gh`
nor the official MCP server has been run against this package; the manifest's `compatibility` block is empty.
MCP alias results are the full GitHub JSON objects (the real server trims some fields and returns text content).

## Limitations

- A bounded subset: 26 operations, 41 routes. Everything else on GitHub does not exist here (framework 404):
  organisations/teams, repository/collaborator/label/milestone management, review comments, pending reviews,
  requested-reviewer routes, check runs, statuses, Actions, releases, tags, blobs/trees, file deletion, forks,
  stars, watchers, notifications, gists, webhooks, GraphQL, search beyond `GET /search/issues`.
- Git is simulated: shas are deterministic 40-hex digests of content salted by a commit sequence (not real git
  object hashes); trees are flat snapshots (≤ 200 UTF-8 text files ≤ 64 KiB each, no binaries/symlinks/modes);
  `patch` is a minimal line diff; mergeability is the path-overlap rule since the merge base, computed
  synchronously (GitHub computes it asynchronously and may return `null`); `merge` applies the head's changes onto
  the base tree, `squash` produces one commit, `rebase` replays the pull's commits with new shas.
- Path parameters match single URL segments: file paths deeper than four segments and refs deeper than two are
  not routable over REST (a percent-encoded `/` is rejected by the framework's path matcher); the canonical and
  MCP operations have no such limit.
- `PUT …/contents/{path}` always answers 200 (GitHub: 201 on create). `POST …/git/refs` accepts a missing `sha`
  (default branch head). `PATCH …/pulls/{n}` accepts `draft` and `reviewers` as extensions. `GET …/issues` excludes
  pull requests (GitHub includes them). Assigning a non-assignable user is a 422 (GitHub silently drops it).
- A file or directory named `__proto__` is an ordinary tree entry, as on GitHub: `PUT …/contents/{path}` creates it,
  contents reads, directory listings, diffs, merges and `path=` commit filters see it. Tree maps store every entry
  under `"/" + path` (`lib/tree.mjs`) because the framework normalises state values through a zod record that drops
  an own `__proto__` key; a bare-keyed map could never have held that name. Other inherited names (`constructor`,
  `toString`, `valueOf`, …) are likewise ordinary file, branch and label names.
- Rate-limit headers are constants (`x-ratelimit-limit: 5000`, `remaining: 4999`) and `x-ratelimit-reset` is not
  sent (the wire codec has no clock); `ETag`/conditional requests, custom media types (`.diff`, `.patch`, `.raw`)
  and `Accept`-driven variants are not implemented. Star counts are not modelled (repository objects carry no star-count or
  star-list fields).
- Permission model is a simplification: five collaborator levels, no teams, CODEOWNERS, required status checks,
  token scopes or 2FA enforcement; `author_association` is `OWNER`, `MEMBER` (organisation repository
  collaborator), `COLLABORATOR` or `NONE`.
- Bounded scans (10,000 rows per namespace scan, 1,000-commit ancestor walks, 1,000 commits and 1,000 changed files
  per pull request): beyond that calls fail with 422 (`Repository is too large for this Tool` / `Pull request
  exceeds the supported bound of 1000 …`) rather than truncating.
- Browser app: a repository-centric subset (see above; out-of-scope chrome is listed under "Not simulated
  controls"). No user/organisation settings, no notifications, no milestones/projects, no review comments on diff lines, no file deletion or multi-file commits, no Markdown
  HTML/images/tables, no dark theme. Relative times ("3 days ago") are computed against the world's virtual time
  (`server_time` from `users.get-authenticated`, re-read whenever the world changes) and dates are rendered in UTC,
  so a world renders identically on any machine and any day. Lists (repositories, labels, reviews, comments, pull
  commits and files, compare histories) are read page by page to the end, never just the first page.

## Trademarks

GitHub, the GitHub logo (Invertocat) and the GitHub wordmark are trademarks of GitHub, Inc. Product names and logos
are used here only to identify the simulated service inside a test environment; this package is an independent
Firedrill Tool and is not affiliated with, sponsored by or endorsed by GitHub. The logo files under
`firedrill/tools/github/app/` (`github.svg`, `github-wordmark.svg`) are unmodified official assets whose sources
are recorded in `firedrill/tools/github/app/assets/ATTRIBUTION.md`; the interface icons are Octicons (MIT,
`firedrill/tools/github/app/assets/octicons-LICENSE.txt`) and the bundled Noto Sans font is licensed under the SIL
Open Font License 1.1 (`firedrill/tools/github/app/assets/fonts/OFL.txt`). The `https://github.com` and
`https://api.github.com` literals appear only inside response link fields and are never contacted.

## Safety

Tools and conformance targets are trusted local executable code, not a sandbox. Review before running. Keep
credentials, generated worlds and reports out of the package; never point this Tool at a real GitHub token or
repository.
