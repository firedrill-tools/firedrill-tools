// Entry point: sidebar, hash router, command palette and world-revision refresh.
import { hydrateIcons, icon } from "./icons.js";
import { loadBase, memberName, store } from "./store.js";
import { $, call, closePopover, describe, el, menu, modalOpen, notSimulated, popoverOpen, watchWorld } from "./ui.js";
import { avatar, objectBadge } from "./values.js";
import { renderObject } from "./table.js";
import { renderRecord } from "./record.js";
import { renderList } from "./listview.js";
import { renderTasks } from "./tasks.js";
import { renderNotes } from "./notes.js";
import { openPalette } from "./palette.js";

const OBJECT_ORDER = ["companies", "people", "deals"];
let unsaved = () => false;
// The nav badge counts open tasks page by page; past TASK_COUNT_CAP it shows "1,000+" rather than keep paging.
const TASK_COUNT_PAGE = 200;
const TASK_COUNT_CAP = 1000;

function navItem(href, leading, label, route) {
  return el("li", {}, el("a", { class: "at-nav-item", attrs: { href, "data-route": route } }, [leading, el("span", { class: "at-nav-label", text: label })]));
}

function renderSidebar() {
  const ws = store.self;
  $("#ws-name").textContent = ws.workspace_name;
  $("#ws-logo").textContent = ws.workspace_name.charAt(0).toUpperCase();
  const objects = [...store.objects].sort((a, b) => (OBJECT_ORDER.indexOf(a.api_slug) + 1 || 99) - (OBJECT_ORDER.indexOf(b.api_slug) + 1 || 99));
  $("#nav-objects").replaceChildren(...objects.map((o) => navItem(`#/${o.api_slug}`, objectBadge(o.api_slug), o.plural_noun, o.api_slug)));
  const lists = $("#nav-lists");
  if (store.listsDenied) {
    lists.replaceChildren(el("li", {}, el("span", { class: "at-nav-item at-nav-muted" }, [icon("lock"), el("span", { class: "at-nav-label", text: "No access to lists" })])));
  } else if (store.lists.length === 0) {
    lists.replaceChildren(el("li", {}, el("span", { class: "at-nav-item at-nav-muted" }, [icon("list"), el("span", { class: "at-nav-label", text: "No lists" })])));
  } else {
    lists.replaceChildren(...store.lists.map((l) => navItem(`#/lists/${l.api_slug}`, el("span", { class: "at-list-icon", attrs: { "aria-hidden": "true" } }, icon("list", "", 12)), l.name, `lists/${l.api_slug}`)));
  }
  const meName = store.me ? memberName(store.me.id.workspace_member_id) : "Unknown member";
  $("#me-name").textContent = meName;
  $("#me-avatar").replaceWith(Object.assign(avatar(meName, store.self.authorized_by_workspace_member_id, { size: "small" }), { id: "me-avatar" }));
  void updateTaskCount();
}

async function updateTaskCount() {
  const badge = $("#nav-task-count");
  try {
    let total = 0;
    let more = false;
    for (let offset = 0; ; offset += TASK_COUNT_PAGE) {
      // At the cap, one single-row read decides between exactly the cap and "cap+".
      if (offset >= TASK_COUNT_CAP) { more = (await call("tasks.list", { assignee: store.self.authorized_by_workspace_member_id, is_completed: false, limit: 1, offset })).data.length > 0; break; }
      const page = (await call("tasks.list", { assignee: store.self.authorized_by_workspace_member_id, is_completed: false, limit: TASK_COUNT_PAGE, offset })).data;
      total += page.length;
      if (page.length < TASK_COUNT_PAGE) break;
    }
    badge.textContent = more ? `${TASK_COUNT_CAP.toLocaleString("en-US")}+` : total > 0 ? String(total) : "";
    badge.title = more ? `More than ${TASK_COUNT_CAP.toLocaleString("en-US")} open tasks assigned to you` : "";
  } catch {
    badge.textContent = "";
  }
}

function markActive(route) {
  for (const item of document.querySelectorAll(".at-nav-item[data-route]")) {
    const on = route === item.getAttribute("data-route") || route.startsWith(`${item.getAttribute("data-route")}/`);
    item.classList.toggle("active", on);
    if (on) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

let routeSeq = 0;
async function route() {
  closePopover();
  const main = $("#main");
  const hash = decodeURIComponentSafe(location.hash.replace(/^#\/?/, ""));
  const parts = hash.split("/").filter(Boolean);
  const seq = ++routeSeq;
  const alive = () => seq === routeSeq;
  const defaultSlug = store.objectsBySlug.has("people") ? "people" : store.objects[0]?.api_slug;
  const r = parts.length === 0 ? [defaultSlug] : parts;
  markActive(r.join("/"));
  unsaved = () => false;
  let screen;
  if (r[0] === "tasks") screen = renderTasks(main, { alive });
  else if (r[0] === "notes") screen = renderNotes(main, { alive, noteId: r[1] });
  else if (r[0] === "lists" && r[1]) screen = renderList(main, { alive, slug: r[1] });
  else if (store.objectsBySlug.has(r[0]) && r[1]) screen = renderRecord(main, { alive, slug: r[0], recordId: r[1], tab: r[2] });
  else if (store.objectsBySlug.has(r[0])) screen = renderObject(main, { alive, slug: r[0] });
  else {
    main.replaceChildren(el("div", { class: "at-state" }, [el("h2", { text: "Page not found" }), el("p", { text: "This page does not exist in the workspace." })]));
    return;
  }
  const result = await screen;
  if (alive() && result?.unsaved) unsaved = result.unsaved;
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

async function refresh(first) {
  try {
    await loadBase();
  } catch (error) {
    if (first) {
      $("#splash").classList.add("error");
      $("#splash-text").textContent = describe(error);
      return;
    }
    throw error;
  }
  if (first) {
    $("#splash").hidden = true;
    $("#app").hidden = false;
  }
  renderSidebar();
  await route();
}

function wireChrome() {
  hydrateIcons();
  for (const b of document.querySelectorAll("[data-not-simulated]")) {
    b.addEventListener("click", () => notSimulated(b, b.getAttribute("data-not-simulated"), b.getAttribute("data-ns-detail")));
  }
  $("#sidebar-toggle").addEventListener("click", () => $("#app").classList.toggle("collapsed"));
  $("#open-search").addEventListener("click", () => openPalette());
  $("#workspace-switcher").addEventListener("click", (event) => {
    const anchor = event.currentTarget;
    menu(anchor, [
      { header: store.self?.workspace_slug ?? "Workspace" },
      { label: store.self?.workspace_name ?? "Workspace", leading: el("span", { class: "at-ws-logo" }, store.self?.workspace_name?.charAt(0) ?? "?"), checked: true },
      "divider",
      { label: "Workspace settings", icon: "settings", notSimulated: "Workspace settings are fixed by starter or scenario data." },
      { label: "Create or join workspace", icon: "plus", notSimulated: "This Tool simulates a single workspace." },
    ], { width: 260 });
  });
  $("#me-button").addEventListener("click", (event) => {
    const me = store.me;
    menu(event.currentTarget, [
      { header: me ? me.email_address : "Unknown member" },
      { label: `Access: ${me?.access_level ?? "unknown"}`, icon: "lock", disabled: true },
      "divider",
      { label: "Profile settings", icon: "user", notSimulated: "Member profiles come from starter data." },
      { label: "Log out", icon: "arrowRight", notSimulated: "Sessions are managed by the local environment, not by this Tool." },
    ], { width: 260 });
  });
  $("#help-button").addEventListener("click", (event) => notSimulated(event.currentTarget, "Help and first steps", "Onboarding checklists and help articles are not simulated."));
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openPalette();
    }
  });
  window.addEventListener("hashchange", () => void route());
}

wireChrome();
const check = watchWorld((first) => refresh(first), () => !modalOpen() && !popoverOpen() && !unsaved());
void check();
