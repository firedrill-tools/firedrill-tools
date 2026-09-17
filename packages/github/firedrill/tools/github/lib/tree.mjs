// Flat tree maps: every entry is stored under `"/" + path` rather than the bare path. The framework normalises
// state values through a zod record (`JsonObjectSchema`), which drops an own `__proto__` key, so a bare-keyed map
// could never hold a file or directory named `__proto__` (a name GitHub accepts). Prefixed keys are always
// ordinary own properties. Paths are normalised (no leading slash), so the encoding is a bijection.
const PREFIX = "/";

export function treeKey(path) {
  return PREFIX + path;
}

function treePath(key) {
  return key.slice(PREFIX.length);
}

function has(tree, key) {
  return tree !== null && typeof tree === "object" && Object.prototype.hasOwnProperty.call(tree, key);
}

/** The entry stored at `path`, or undefined (never a prototype-chain read). */
export function treeGet(tree, path) {
  if (typeof path !== "string") return undefined;
  const key = treeKey(path);
  return has(tree, key) ? tree[key] : undefined;
}

/** Every stored path (decoded). */
export function treePaths(tree) {
  return tree !== null && typeof tree === "object" ? Object.keys(tree).map(treePath) : [];
}

/** `[path, entry]` pairs (decoded paths). */
export function treeEntries(tree) {
  return tree !== null && typeof tree === "object" ? Object.keys(tree).map((key) => [treePath(key), tree[key]]) : [];
}

export function treeSize(tree) {
  return tree !== null && typeof tree === "object" ? Object.keys(tree).length : 0;
}

/** Writes on a null-prototype copy (see `nullMap`); the caller owns `tree`. */
export function treeSet(tree, path, entry) {
  tree[treeKey(path)] = entry;
}

export function treeDelete(tree, path) {
  delete tree[treeKey(path)];
}
