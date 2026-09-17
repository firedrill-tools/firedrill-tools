// Parsing of GitLab web URLs passed as the MCP `url` argument, against the instance URL stored in `meta/instance`.
// Returns a plain description; the caller resolves projects, iids and refs from state.

const MAX_URL = 2_048;
const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

function decodeSegment(segment) {
  try {
    const value = decodeURIComponent(segment);
    return value.length === 0 || value.includes("\0") || UNSAFE.has(value) ? undefined : value;
  } catch {
    return undefined;
  }
}

/**
 * `https://host/<namespace>/<project>[/-/<kind>/<rest…>]` → `{ projectPath, kind, segments }` where kind is `project`,
 * `issues`, `work_items`, `merge_requests`, `commit`, `blob` or `tree`. Undefined for a foreign host or malformed URL.
 */
export function parseGitlabUrl(url, instanceUrl) {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL || typeof instanceUrl !== "string") return undefined;
  const base = instanceUrl.replace(/\/+$/, "");
  if (!url.startsWith(`${base}/`)) return undefined;
  const rest = url.slice(base.length + 1).replace(/[?#].*$/, "").replace(/\/+$/, "");
  const [projectPart, resourcePart] = rest.split("/-/", 2);
  const projectSegments = projectPart.split("/").map(decodeSegment);
  if (projectSegments.length < 2 || projectSegments.some((segment) => segment === undefined)) return undefined;
  const projectPath = projectSegments.join("/");
  if (projectPath.length > 255) return undefined;
  if (resourcePart === undefined) return { projectPath, kind: "project", segments: [] };
  const parts = resourcePart.split("/").map(decodeSegment);
  if (parts.length === 0 || parts.some((segment) => segment === undefined)) return undefined;
  const [kind, ...segments] = parts;
  if (!["issues", "work_items", "merge_requests", "commit", "blob", "tree"].includes(kind)) return undefined;
  return { projectPath, kind, segments };
}

/** Iid from `…/-/issues/7` style segments, or undefined. */
export function iidFromSegments(segments) {
  return segments.length === 1 && /^[1-9][0-9]{0,8}$/.test(segments[0]) ? Number(segments[0]) : undefined;
}
