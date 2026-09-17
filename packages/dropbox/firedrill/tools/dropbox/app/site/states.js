// Empty, loading and permission states.
import { el } from "./ui.js";
import { icon, fileGlyph } from "./icons.js";

export function emptyState(art, title, text, actions = []) {
  const picture = el("div", { class: "db-empty-art" }, art === "folder" ? fileGlyph("folder", "", 64) : art === "logo" ? el("img", { attrs: { src: "./assets/dropbox.svg", alt: "" } }) : icon(art));
  return el("div", { class: "db-empty" }, [picture, el("h2", { text: title }), text ? el("p", { text }) : null, el("div", { class: "db-row-gap" }, actions.filter(Boolean))]);
}

export function deniedState(error) {
  const scope = error?.denied ? undefined : /\b(?:account_info|files\.metadata|files\.content|sharing)\.(?:read|write)\b/.exec(error?.message ?? "")?.[0];
  const box = el("div", { class: "db-empty db-denied" }, [
    el("img", { class: "db-denied-logo", attrs: { src: "./assets/dropbox-logo-2017.svg", alt: "Dropbox" } }),
    el("h2", { text: "You don't have access to this" }),
    el("p", { text: error?.denied ? "The Firedrill actor using this app has no grant for this operation." : "This app's access token is missing a permission this view needs." }),
    scope ? el("p", { class: "db-muted", text: `Required scope: ${scope}` }) : null,
  ]);
  return box;
}

export function skeleton(rows = 8) {
  const table = el("table", { class: "db-table db-skel", attrs: { "aria-hidden": "true" } });
  const body = el("tbody");
  for (let i = 0; i < rows; i += 1) {
    body.append(el("tr", {}, [el("td", { attrs: { style: undefined } }), el("td", {}, el("span", { class: `w${(i % 3) + 1}` })), el("td", {}, el("span")), el("td", {}, el("span")), el("td")]));
  }
  table.append(body);
  return el("div", { attrs: { role: "status", "aria-label": "Loading files" } }, table);
}
