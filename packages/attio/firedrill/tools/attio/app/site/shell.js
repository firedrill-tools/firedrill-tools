// Page chrome shared by every screen: the 48 px breadcrumb header, view bars and the empty / error / denied states.
import { icon } from "./icons.js";
import { objectBadge } from "./values.js";
import { button, describe, el, iconButton, notSimulated } from "./ui.js";

/** Breadcrumb header. `crumbs` = [{ label, href?, leading?, muted? }]; `actions` = elements on the right. */
export function pageHeader(crumbs, actions = []) {
  const trail = el("div", { class: "at-crumbs" });
  const toggle = iconButton("sidebar", "Open sidebar", () => document.querySelector("#app")?.classList.toggle("mobile-open"), "at-menu-toggle");
  trail.append(toggle);
  crumbs.forEach((crumb, index) => {
    if (index > 0) trail.append(icon("chevronRight", "at-crumb-sep", 14));
    const node = el(crumb.href ? "a" : "span", { class: `at-crumb${crumb.muted ? " muted" : ""}`, attrs: crumb.href ? { href: crumb.href } : { "aria-current": index === crumbs.length - 1 ? "page" : undefined } });
    if (crumb.leading) node.append(crumb.leading);
    node.append(el("span", { text: crumb.label }));
    trail.append(node);
  });
  return el("header", { class: "at-header" }, [trail, el("div", { class: "at-header-actions" }, actions)]);
}

export const objectCrumb = (object) => ({ label: object.plural_noun, href: `#/${object.api_slug}`, leading: objectBadge(object.api_slug) });

/** A control of the real product outside this Tool's model: rendered, focusable, explains itself. */
export function nsButton(label, detail, options = {}) {
  const b = button(options.iconOnly ? "" : label, { icon: options.icon, class: options.class, ariaLabel: options.iconOnly ? label : undefined, title: label });
  b.addEventListener("click", () => notSimulated(b, label, detail));
  return b;
}

export function stateBox({ iconName = "inbox", title, text, action, kind = "" }) {
  return el("div", { class: `at-state ${kind}`.trim(), attrs: { role: kind === "error" ? "alert" : "status" } }, [
    el("span", { class: "at-state-icon" }, icon(iconName, "", 20)),
    el("h2", { text: title }),
    text ? el("p", { text }) : null,
    action ?? null,
  ]);
}

export function errorState(error, retry) {
  if (error?.denied) {
    return stateBox({ iconName: "lock", title: "You don't have access", text: `${describe(error)} Ask a workspace admin to grant access.`, kind: "denied" });
  }
  return stateBox({ iconName: "alert", title: "Something went wrong", text: describe(error), kind: "error", action: retry ? button("Try again", { onClick: retry }) : null });
}

export function loadingRows(columns, rows = 8) {
  const body = el("tbody");
  for (let r = 0; r < rows; r += 1) {
    const tr = el("tr");
    for (let c = 0; c < columns; c += 1) {
      const skel = el("span", { class: "at-skel" });
      skel.style.width = `${40 + ((r * 7 + c * 13) % 50)}%`;
      tr.append(el("td", {}, skel));
    }
    body.append(tr);
  }
  return body;
}
