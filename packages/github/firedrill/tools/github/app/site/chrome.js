// Persistent github.com chrome that sits outside this Tool's scope: repository action buttons (Pin, Watch,
// Fork, Star), the Actions/Projects/Wiki/Security/Insights/Settings tabs, Copilot, footer links and similar.
// These controls render in place with GitHub's glyphs, hover states and tooltips; activating one opens a short
// "not simulated by this Tool" panel. They never show data the Tool does not model.
import { $, button, el, icon, iconButton, openDialog, openMenu } from "./ui.js";

/** Open the standard "not simulated" panel for a named GitHub feature. */
export function notSimulated(feature, detail = "") {
  return openDialog(feature, (body, close) => {
    const block = el("div", { class: "not-simulated" });
    block.append(icon("info", "not-simulated-icon", 24));
    block.append(el("p", { class: "not-simulated-title", text: `${feature} is not simulated by this Tool.` }));
    block.append(el("p", { class: "text-muted", text: detail || "This control is shown so the page matches github.com. The GitHub Tool models repositories, contents, commits, branches, issues, labels and pull requests only; nothing here reaches github.com." }));
    const footer = el("div", { class: "not-simulated-footer" }, [button("OK", { variant: "primary", onClick: () => close(true) })]);
    body.append(block, footer);
  });
}

/** A Primer button (optionally with a counter and a caret) that opens the not-simulated panel. */
function chromeButton(label, iconName, feature, { count, caret = false, detail } = {}) {
  const main = button(label, { icon: iconName, size: "sm", title: `${feature} (not simulated)`, onClick: () => notSimulated(feature, detail) });
  main.classList.add("repo-action");
  if (count !== undefined) main.append(el("span", { class: "Counter repo-action-counter", text: formatCount(count) }));
  if (!caret) return main;
  const more = button("", { size: "sm", trailingIcon: "triangle-down", class: "btn-caret", ariaLabel: `${feature} options`, title: `${feature} options (not simulated)`, onClick: () => notSimulated(feature, detail) });
  return el("div", { class: "btn-group repo-action-group" }, [main, more]);
}

/** GitHub abbreviates large counters (1.2k). */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.trunc(n));
  const k = Math.floor(n / 100) / 10;
  return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

/**
 * Pin · Watch · Fork · Star, as on a repository's Code tab. Counts come from the repository record:
 * Watch = subscribers_count (falls back to watchers_count), Fork = forks_count. Stars are not modelled by the
 * Tool, so the Star button carries no counter.
 */
export function repoActions(repo) {
  const watchers = repo.subscribers_count ?? repo.watchers_count;
  return [
    chromeButton("Pin", "pin", "Pinning repositories"),
    chromeButton("Watch", "eye", "Watching and notifications", { count: watchers, caret: true }),
    chromeButton("Fork", "repo-forked", "Forking", { count: repo.forks_count, caret: true }),
    chromeButton("Star", "star", "Starring", { caret: true, detail: "Stars are not modelled: repository records carry no star count or list of users who starred, so no count is shown." }),
  ];
}

/** Repository tabs outside the Tool's scope, in github.com order after Code · Issues · Pull requests. */
export function outOfScopeTabs(repo) {
  const tabs = [
    { label: "Actions", icon: "play", feature: "GitHub Actions" },
    { label: "Projects", icon: "table", feature: "Projects" },
    { label: "Wiki", icon: "book", feature: "Wiki" },
    { label: "Security", icon: "shield", feature: "Security and quality" },
    { label: "Insights", icon: "graph", feature: "Insights" },
  ];
  if (repo.permissions?.admin) tabs.push({ label: "Settings", icon: "gear", feature: "Repository settings" });
  return tabs.map((tab) => {
    const item = el("button", { class: "UnderlineNav-item UnderlineNav-item--chrome", title: `${tab.feature} (not simulated)`, attrs: { type: "button", "data-tab": tab.label.toLowerCase(), "data-icon": tab.icon } });
    item.append(icon(tab.icon), el("span", { text: tab.label }));
    item.addEventListener("click", () => notSimulated(tab.feature));
    return item;
  });
}

/** Sidebar rows for features the Tool does not model (Projects, Milestone, Development, ...). */
export function notSimulatedSidebarItem(title, feature, text) {
  const section = el("div", { class: "discussion-sidebar-item" });
  const heading = el("div", { class: "discussion-sidebar-heading" });
  heading.append(el("span", { text: title }));
  const gear = iconButton("gear", `Edit ${title} (not simulated)`, { class: "btn-sm", onClick: () => notSimulated(feature) });
  heading.append(gear);
  section.append(heading, el("span", { class: "sidebar-none", text }));
  return section;
}

/** Wire static chrome from index.html: Copilot, command palette, footer links. */
export function wireStaticChrome() {
  $("#header-copilot")?.addEventListener("click", () => notSimulated("Copilot"));
  $("#header-copilot-menu")?.addEventListener("click", () => notSimulated("Copilot"));
  $("#header-command-palette")?.addEventListener("click", () => notSimulated("Command palette"));
  for (const item of document.querySelectorAll("[data-not-simulated]")) {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      notSimulated(item.getAttribute("data-not-simulated"));
    });
  }
}

/**
 * github.com collapses repository tabs that do not fit into a "..." overflow menu (UnderlineNav overflow). Show every
 * tab, then move tabs from the end (never the selected one) into the menu until the bar fits its container.
 */
export function fitRepoNav(nav = $("#repo-nav")) {
  if (!nav) return;
  nav.querySelector(".UnderlineNav-more")?.remove();
  const items = [...nav.querySelectorAll(".UnderlineNav-item")];
  for (const item of items) item.hidden = false;
  if (nav.clientWidth === 0 || nav.scrollWidth <= nav.clientWidth + 1) return;
  const more = el("button", { class: "UnderlineNav-item UnderlineNav-more", title: "More repository tabs", attrs: { type: "button", "aria-label": "More repository tabs", "aria-haspopup": "true", "aria-expanded": "false" } }, [icon("kebab-horizontal")]);
  nav.append(more);
  const hidden = [];
  for (let index = items.length - 1; index >= 0 && nav.scrollWidth > nav.clientWidth + 1; index -= 1) {
    if (items[index].hasAttribute("aria-current")) continue;
    items[index].hidden = true;
    hidden.unshift(items[index]);
  }
  more.addEventListener("click", () =>
    openMenu(more, hidden.map((item) => ({ label: item.querySelector("span")?.textContent ?? "", icon: item.getAttribute("data-icon") ?? undefined, onSelect: () => item.click() })), { align: "end" }),
  );
}

let fitScheduled = false;
window.addEventListener("resize", () => {
  if (fitScheduled) return;
  fitScheduled = true;
  requestAnimationFrame(() => {
    fitScheduled = false;
    fitRepoNav();
  });
});
