// Dropbox path rules (pure). Paths are case-insensitive: comparisons use `pathLower`, output keeps `pathDisplay`.

export const MAX_PATH = 4096;
export const MAX_SEGMENT = 255;
const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** True when a string contains an unpaired UTF-16 surrogate (such names cannot be encoded as UTF-8). */
export function hasLoneSurrogate(text) {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

const DISALLOWED = new Set(["desktop.ini", "thumbs.db", ".ds_store", "icon\r", ".dropbox", ".dropbox.attr"]);

/** Lower-cases a display path the way this service compares paths (Unicode simple lower case). */
export function lower(path) {
  return path.toLowerCase();
}

/**
 * Parses a caller path. Returns `{ kind: "root" }`, `{ kind: "path", display, lower, segments }`, `{ kind: "id", id }`,
 * `{ kind: "rev", rev }` or `{ kind: "malformed" }`. `allow` lists the accepted kinds (root, id, rev).
 */
export function parsePath(value, allow = {}) {
  if (typeof value !== "string") return { kind: "malformed" };
  if (value === "") return allow.root ? { kind: "root" } : { kind: "malformed" };
  if (value.startsWith("id:")) {
    return allow.id && /^id:[A-Za-z0-9_-]{1,64}$/.test(value) ? { kind: "id", id: value } : { kind: "malformed" };
  }
  if (value.startsWith("rev:")) {
    return allow.rev && /^rev:[0-9a-f]{9,64}$/.test(value) ? { kind: "rev", rev: value.slice(4) } : { kind: "malformed" };
  }
  if (value === "/") return allow.root ? { kind: "root" } : { kind: "malformed" };
  if (!value.startsWith("/") || value.endsWith("/") || value.length > MAX_PATH) return { kind: "malformed" };
  if (value.includes(NUL) || value.includes(REPLACEMENT) || hasLoneSurrogate(value)) return { kind: "malformed" };
  const segments = value.slice(1).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.length > MAX_SEGMENT) return { kind: "malformed" };
  }
  return { kind: "path", display: value, lower: lower(value), segments };
}

/** Parent display path of a display path ("" for top-level entries). */
export function parentOf(path) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "" : path.slice(0, index);
}

export function nameOf(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Dropbox's disallowed names: trailing space or dot, and reserved desktop-client names. */
export function disallowedName(name) {
  return name.endsWith(" ") || name.endsWith(".") || DISALLOWED.has(name.toLowerCase());
}

/** True when `path` equals `ancestor` or lies below it (both lower-case; "" is the root). */
export function within(path, ancestor) {
  if (ancestor === "") return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/** Autorename candidate: "name (n).ext" (extension kept for files, whole name for folders). */
export function renamed(display, n, isFile) {
  const parent = parentOf(display);
  const name = nameOf(display);
  const dot = isFile ? name.lastIndexOf(".") : -1;
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${parent}/${base} (${n})${ext}`;
}

/** Folder depth of a path ("/a" is 1). */
export function depth(path) {
  let count = 0;
  for (let i = 0; i < path.length; i += 1) if (path.charCodeAt(i) === 47) count += 1;
  return count;
}

/** Lower-case file extension without the dot ("" when none). */
export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
