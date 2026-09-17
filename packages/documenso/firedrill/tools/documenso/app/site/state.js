// Shared app state and hash routing for the Documenso Tool app.
export const app = {
  /** workspace.context result: { now, user, team, teams, usage } */
  workspace: null,
  /** Current page controller: { refresh?(), mayRefresh?() } */
  page: null,
};

/** Parses `#/a/b?x=1` into { parts: ["a","b"], params: URLSearchParams }. */
export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  return { parts, params: new URLSearchParams(query) };
}

export function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

/** Updates query parameters of the current route (null removes one). */
export function setParams(changes) {
  const { parts, params } = parseHash();
  for (const [name, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === "") params.delete(name);
    else params.set(name, String(value));
  }
  const query = params.toString();
  go(`#/${parts.map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`);
}

export const isOwnEmail = (email) => !!app.workspace && typeof email === "string" && email.toLowerCase() === app.workspace.user.email.toLowerCase();
