// Top bar, side panel and peek chrome shared by every screen.
import { icon } from "./icons.js";
import { objectIcon } from "./rich.js";
import { ancestors, navigate, routeFor, state } from "./state.js";
import { $, el, iconButton } from "./ui.js";

/** Breadcrumb from the index: ancestors (oldest first) then the current node; collapses the middle like the product. */
export function setBreadcrumb(current, { extra } = {}) {
  const host = $("#breadcrumb");
  host.replaceChildren();
  if (!current) return;
  const chain = [...ancestors(current).reverse(), current];
  const items = chain.length > 4 ? [chain[0], { ellipsis: true }, chain[chain.length - 2], chain[chain.length - 1]] : chain;
  items.forEach((node, index) => {
    if (index > 0) host.append(el("span", { class: "crumb-sep", text: "/", attrs: { "aria-hidden": "true" } }));
    if (node.ellipsis) {
      host.append(el("span", { class: "crumb ellipsis", text: "…" }));
      return;
    }
    const last = index === items.length - 1;
    const crumb = el(last ? "span" : "a", { class: `crumb ${last ? "current" : ""}`.trim(), attrs: last ? { "aria-current": "page" } : { href: routeHashOf(node) } });
    crumb.append(objectIcon(node.iconObject, node.kind, "crumb-icon"), el("span", { class: "crumb-title", text: node.title }));
    host.append(crumb);
  });
  if (extra) host.append(extra);
}

function routeHashOf(node) {
  const route = routeFor(node);
  return route.name === "database" ? `#/database/${route.id}/table` : `#/page/${route.id}`;
}

export function setPlainBreadcrumb(title, iconName) {
  const host = $("#breadcrumb");
  host.replaceChildren(el("span", { class: "crumb current" }, [iconName ? icon(iconName, "crumb-icon glyph") : null, el("span", { class: "crumb-title", text: title })]));
}

export function setTopbarActions(elements) {
  const host = $("#topbar-actions");
  host.replaceChildren(...elements.filter(Boolean));
}

/** Right-hand panel (comments, markdown, updates). */
export function openSidePanel(title, content, { onClose } = {}) {
  const panel = $("#side-panel");
  panel.replaceChildren(
    el("div", { class: "panel-head" }, [el("span", { class: "panel-title", text: title }), iconButton("close", "Close panel", { onClick: () => closeSidePanel() })]),
    el("div", { class: "panel-body" }, content),
  );
  panel.hidden = false;
  panel.onclose = onClose;
  document.body.classList.add("has-side-panel");
}
export function closeSidePanel() {
  const panel = $("#side-panel");
  if (panel.hidden) return;
  panel.hidden = true;
  document.body.classList.remove("has-side-panel");
  const onClose = panel.onclose;
  panel.onclose = undefined;
  onClose?.();
}
export const sidePanelOpen = () => !$("#side-panel").hidden;

/** Side peek: a page opened from a database view, on the right half like the product's default "Side peek". */
export function openPeek(content, { onClose, onExpand } = {}) {
  const peek = $("#peek");
  const head = el("div", { class: "peek-head" }, [
    iconButton("double_chevron_left", "Close peek", { class: "peek-close-btn", onClick: () => closePeek() }),
    onExpand ? iconButton("expand", "Open as page", { onClick: onExpand }) : null,
  ]);
  peek.replaceChildren(head, el("div", { class: "peek-body" }, content));
  peek.hidden = false;
  peek.onclose = onClose;
  document.body.classList.add("has-peek");
}
export function closePeek() {
  const peek = $("#peek");
  if (peek.hidden) return;
  peek.hidden = true;
  document.body.classList.remove("has-peek");
  const onClose = peek.onclose;
  peek.onclose = undefined;
  onClose?.();
}
export const peekOpen = () => !$("#peek").hidden;
export const peekBody = () => $("#peek .peek-body");

/** Product-style full-screen states used by every screen. */
export function emptyState(title, text, actions = []) {
  return el("div", { class: "empty-state" }, [el("p", { class: "empty-title", text: title }), text ? el("p", { class: "empty-text", text }) : null, actions.length > 0 ? el("div", { class: "empty-actions" }, actions) : null]);
}

export function skeleton(lines = 6) {
  const host = el("div", { class: "skeleton", attrs: { "aria-hidden": "true" } });
  for (let index = 0; index < lines; index += 1) host.append(el("div", { class: `skeleton-line w${(index % 4) + 1}` }));
  return host;
}

export function goTo(node) {
  navigate(routeFor(node));
}

export { state };
