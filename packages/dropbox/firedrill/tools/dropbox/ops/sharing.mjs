// sharing/create_shared_link_with_settings, sharing/list_shared_links and sharing/revoke_shared_link.
// Links are records only: the URLs are shaped like Dropbox's and are never served.
import { callerAccount } from "../lib/account.mjs";
import { failText, failUnion, lookupFail } from "../lib/errors.mjs";
import { decodeCursor, encodeCursor, isBool, isStr } from "../lib/cursor.mjs";
import { parsePath, within } from "../lib/paths.mjs";
import { commit, liveByRef, openStore } from "../lib/store.mjs";
import { fnv32, jsonSize, parseTimestamp, tagOf } from "../lib/util.mjs";
import { accountLinks } from "../lib/writes.mjs";
import { PAGE_BUDGET } from "./list.mjs";

const tag = (value) => ({ ".tag": value });

export function linkMetadata(link, entry) {
  const out = { ".tag": link.tag, url: link.url, id: link.entryId, name: link.name, path_lower: link.pathLower };
  if (link.expires !== undefined) out.expires = link.expires;
  out.link_permissions = {
    can_revoke: true,
    resolved_visibility: tag(link.resolvedVisibility),
    requested_visibility: tag(link.requestedVisibility),
    visibility_policies: [
      { policy: tag("public"), resolved_policy: tag("public"), allowed: true },
      { policy: tag("password"), resolved_policy: tag("password"), allowed: true },
      { policy: tag("team_only"), resolved_policy: tag("team_only"), allowed: false, disallowed_reason: tag("user_not_on_team") },
    ],
    can_set_expiry: true,
    can_remove_expiry: true,
    allow_download: link.allowDownload,
    can_allow_download: true,
    can_disallow_download: true,
    allow_comments: true,
    team_restricts_comments: false,
    audience_options: [
      { audience: tag("public"), allowed: true },
      { audience: tag("team"), allowed: false, disallowed_reason: tag("user_not_on_team") },
      { audience: tag("no_one"), allowed: true },
    ],
    can_set_password: true,
    can_remove_password: true,
    require_password: link.hasPassword,
    effective_audience: tag(link.audience),
    link_access_level: tag("viewer"),
  };
  if (link.tag === "file" && entry !== undefined && !entry.deleted && entry.tag === "file") {
    out.client_modified = entry.clientModified;
    out.server_modified = entry.serverModified;
    out.rev = entry.rev;
    out.size = entry.size;
  }
  return out;
}

export function linkIdFor(n) {
  return `${fnv32(`link${n}`).slice(0, 6).replace(/[^0-9a-z]/g, "0")}${n.toString(36).padStart(9, "0")}`;
}

function settingsError(context, reason) {
  failUnion(context, "SETTINGS_ERROR", { ".tag": "settings_error", settings_error: tag(reason) });
}

export function createSharedLink(input, context) {
  const account = callerAccount(context, "sharing.write");
  const parsed = parsePath(input.path, { id: true });
  if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
  const store = openStore(context, account);
  const entry = liveByRef(store, parsed);
  if (entry === null) lookupFail(context, "path", "not_found");
  const links = accountLinks(store);
  const existing = links.find((link) => link.entryId === entry.id);
  if (existing !== undefined) {
    failUnion(context, "SHARED_LINK_ALREADY_EXISTS", { ".tag": "shared_link_already_exists", shared_link_already_exists: { ".tag": "metadata", metadata: linkMetadata(existing, entry) } });
  }
  const raw = input.settings ?? {};
  const settings = { ...raw, requested_visibility: tagOf(raw.requested_visibility), audience: tagOf(raw.audience) };
  const hasPassword = typeof settings.link_password === "string" && settings.link_password.length > 0;
  const requested = settings.requested_visibility ?? (hasPassword ? "password" : "public");
  if (requested === "team_only" || settings.audience === "team") settingsError(context, "not_authorized");
  if (requested === "password" && !hasPassword) settingsError(context, "invalid_settings");
  if (settings.expires !== undefined) {
    const seconds = parseTimestamp(settings.expires);
    if (seconds === null || seconds * 1_000_000 <= context.clock.nowUs()) settingsError(context, "invalid_settings");
  }
  if (links.length + 1 > store.lim.links) failUnion(context, "TOO_MANY_FILES", tag("too_many_files"), "too_many_files: shared links exceed the supported bound");
  const n = store.c.nextLink;
  store.c.nextLink = n + 1;
  store.dirty = true;
  const linkId = linkIdFor(n);
  const kind = entry.tag === "file" ? "fi" : "fo";
  const rlkey = `${fnv32(`${store.accountId}/${linkId}`)}${fnv32(linkId, 0x2545f491)}`.slice(0, 16);
  const resolved = requested === "password" ? "password" : settings.audience === "no_one" ? "no_one" : "public";
  const link = {
    accountId: store.accountId, linkId, entryId: entry.id, url: `https://www.dropbox.com/scl/${kind}/${linkId}/${encodeURIComponent(entry.name)}?rlkey=${rlkey}&dl=0`,
    name: entry.name, pathLower: entry.pathLower, tag: entry.tag, requestedVisibility: requested, resolvedVisibility: resolved,
    audience: resolved, hasPassword: requested === "password", allowDownload: settings.allow_download !== false, createdAt: context.clock.nowUs(),
  };
  if (settings.expires !== undefined) link.expires = settings.expires;
  context.state.put("shared_links", `${store.accountId}/${linkId}`, link);
  context.events.emit("shared-link.created", { account_id: store.accountId, link_id: linkId, path_lower: entry.pathLower, visibility: resolved });
  commit(store);
  return linkMetadata(link, entry);
}

export function listSharedLinks(input, context) {
  const account = callerAccount(context, "sharing.read");
  const store = openStore(context, account);
  let scope = { e: null, d: input.direct_only === true, o: "" };
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor, "sl", account.accountId);
    if (cursor === null || !(cursor.e === null || isStr(cursor.e, 64)) || !isBool(cursor.d) || !isStr(cursor.o, 64)) {
      failText(context, "BAD_REQUEST", 'Invalid "cursor" parameter');
    }
    scope = cursor;
  } else if (input.path !== undefined) {
    const parsed = parsePath(input.path, { id: true });
    if (parsed.kind === "malformed") lookupFail(context, "path", "malformed_path");
    const entry = liveByRef(store, parsed);
    if (entry === null) lookupFail(context, "path", "not_found");
    scope.e = entry.id;
  }
  const target = scope.e === null ? null : store.byId.get(scope.e);
  if (scope.e !== null && (target === undefined || target.deleted)) lookupFail(context, "path", "not_found");
  const selected = accountLinks(store)
    .filter((link) => link.linkId > scope.o)
    .filter((link) => target === null || link.entryId === target.id || (!scope.d && link.tag === "folder" && within(target.pathLower, link.pathLower)))
    .sort((a, b) => (a.linkId < b.linkId ? -1 : 1));
  const links = [];
  let used = 0;
  for (const link of selected) {
    const metadata = linkMetadata(link, store.byId.get(link.entryId));
    const size = jsonSize(metadata) + 1;
    if (links.length >= 200 || used + size > PAGE_BUDGET) break;
    used += size;
    links.push(metadata);
  }
  const hasMore = links.length < selected.length;
  const result = { links, has_more: hasMore };
  if (hasMore) result.cursor = encodeCursor({ v: 1, k: "sl", a: account.accountId, e: scope.e, d: scope.d, o: selected[links.length - 1].linkId });
  return result;
}

const LINK_URL = /^https:\/\/www\.dropbox\.com\/(?:scl\/f[io]|s)\/([A-Za-z0-9]{1,64})(?:[/?]|$)/;

export function revokeSharedLink(input, context) {
  const account = callerAccount(context, "sharing.write");
  const url = input.url;
  const match = url.length <= 2048 ? LINK_URL.exec(url) : null;
  if (match === null) failUnion(context, "SHARED_LINK_MALFORMED", tag("shared_link_malformed"));
  const rowId = `${account.accountId}/${match[1]}`;
  const link = context.state.get("shared_links", rowId);
  if (link === null || link.url.split("?")[0] !== url.split("?")[0]) failUnion(context, "SHARED_LINK_NOT_FOUND", tag("shared_link_not_found"));
  context.state.delete("shared_links", rowId);
  context.events.emit("shared-link.revoked", { account_id: account.accountId, link_id: link.linkId, path_lower: link.pathLower });
  return { revoked: true, url: link.url };
}
