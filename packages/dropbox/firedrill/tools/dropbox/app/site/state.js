// Shared app state, hash routing and "refresh the visible view" plumbing.
import { call } from "./ui.js";

export const S = {
  account: null,
  usage: null,
  view: "list",
  sort: { key: "name", dir: 1 },
  links: new Map(), // path_lower -> shared link metadata, for the "Who can access" column
  linksComplete: false,
};

let renderer = () => {};
export const setRenderer = (fn) => (renderer = fn);

/** Re-render the current route (keeps open dialogs; views re-fetch). */
export const refresh = () => renderer({ soft: true });

/** Route from location.hash: #/home, #/files/<path>, #/preview/<path>, #/search/<q>, #/photos, #/shared, #/deleted, #/unsim/<name>. */
export function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const slash = raw.indexOf("/");
  const name = slash === -1 ? raw : raw.slice(0, slash);
  let rest = slash === -1 ? "" : raw.slice(slash + 1);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    rest = "";
  }
  return { name: name || "home", arg: rest };
}

export function go(name, arg = "") {
  const hash = `#/${name}${arg ? `/${encodeURIComponent(arg)}` : ""}`;
  if (location.hash === hash) renderer({ soft: false });
  else location.hash = hash;
}

export const folderHash = (path) => go("files", path.replace(/^\//, ""));
export const toPath = (arg) => (arg ? `/${arg.replace(/^\/+/, "")}` : "");

/** Every page of a folder listing (never truncates; follows list_folder/continue). */
export async function listAll(path, { recursive = false, includeDeleted = false } = {}) {
  let page = await call("files.list-folder", { path, recursive, include_deleted: includeDeleted, limit: 500 });
  const entries = [...page.entries];
  let guard = 0;
  while (page.has_more && guard < 1000) {
    page = await call("files.list-folder-continue", { cursor: page.cursor });
    entries.push(...page.entries);
    guard += 1;
  }
  return entries;
}

/** Load every shared link of the account into S.links (paged). */
export async function loadLinks() {
  const map = new Map();
  let page = await call("sharing.list-shared-links", {});
  for (const link of page.links) map.set(link.path_lower, link);
  let guard = 0;
  while (page.has_more && page.cursor && guard < 500) {
    page = await call("sharing.list-shared-links", { cursor: page.cursor });
    for (const link of page.links) map.set(link.path_lower, link);
    guard += 1;
  }
  S.links = map;
  S.linksComplete = true;
  return map;
}

export function sortEntries(entries) {
  const { key, dir } = S.sort;
  return [...entries].sort((a, b) => {
    const fa = a[".tag"] === "folder" ? 0 : 1;
    const fb = b[".tag"] === "folder" ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (key === "modified") {
      const ma = a.server_modified ?? "";
      const mb = b.server_modified ?? "";
      if (ma !== mb) return (ma < mb ? -1 : 1) * dir;
    }
    return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) * (key === "name" ? dir : 1);
  });
}
