// Dropbox Tool app shell: product rail, section sidebar with storage meter, top bar, router and revision refresh.
import { getContext } from "/_firedrill/client.js";
import { $, el, call, describe, formatSize, setServerTime } from "./ui.js";
import { icon, hydrateIcons, fileGlyph } from "./icons.js";
import { openMenu, notSimulated, isModalOpen, closeMenus, closeAllModals } from "./layer.js";
import { S, route, go, setRenderer, toPath, folderHash, listAll } from "./state.js";
import { renderFiles } from "./files.js";
import { renderPreview } from "./preview.js";
import { renderHome, renderPhotos, renderShared, renderDeleted, renderSearch } from "./views.js";
import { deniedState } from "./states.js";

const RAIL = [
  { id: "home", label: "Home", icon: "home" },
  { id: "files", label: "All files", icon: "folder" },
  { id: "photos", label: "Photos", icon: "photos" },
  { id: "shared", label: "Shared", icon: "shared" },
  { id: "signatures", label: "Signatures", icon: "signature", unsim: "Signatures" },
  { id: "send", label: "Send and track", icon: "send", unsim: "Send and track" },
];

function drawRail(active) {
  const nav = $("#rail-nav");
  nav.replaceChildren(...RAIL.map((item) => {
    const a = el("a", { class: "db-rail-item", attrs: { href: item.unsim ? "#" : `#/${item.id}`, "aria-current": active === item.id ? "page" : undefined } }, [icon(item.icon), el("span", { text: item.label })]);
    if (item.unsim) a.addEventListener("click", (e) => { e.preventDefault(); notSimulated(item.unsim); });
    return a;
  }));
  const more = el("button", { class: "db-rail-item", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } }, [icon("more"), el("span", { text: "More" })]);
  more.addEventListener("click", () => openMenu(more, [
    { label: "Deleted files", icon: "trash", onClick: () => go("deleted") },
    { label: "Passwords", icon: "lock", onClick: () => notSimulated("Dropbox Passwords") },
    { label: "Backup", icon: "history", onClick: () => notSimulated("Dropbox Backup") },
    { label: "Transfer", icon: "send", onClick: () => notSimulated("Dropbox Transfer") },
  ]));
  const admin = el("button", { class: "db-rail-item", attrs: { type: "button" } }, [icon("settings"), el("span", { text: "Settings" })]);
  admin.addEventListener("click", () => notSimulated("Account settings"));
  $("#rail-foot").replaceChildren(more, admin);
}

let treeCache = null;
async function drawSide(r) {
  const head = $("#side-head");
  const nav = $("#side-nav");
  const inFiles = ["files", "preview", "deleted", "home", "search"].includes(r.name);
  head.replaceChildren(el("span", { text: r.name === "photos" ? "Photos" : r.name === "shared" ? "Shared" : "Dropbox" }));
  const item = (label, iconName, hash, current, glyph) => {
    const a = el("a", { class: "db-side-item", attrs: { href: hash, "aria-current": current ? "page" : undefined } }, [glyph ?? icon(iconName), el("span", { class: "name", text: label })]);
    return a;
  };
  const top = [
    item("All files", "folder", "#/files", r.name === "files" && !r.arg),
    item("Recents", "clock", "#/home", r.name === "home"),
    item("Photos", "photos", "#/photos", r.name === "photos"),
    item("Shared", "shared", "#/shared", r.name === "shared"),
    item("Deleted files", "trash", "#/deleted", r.name === "deleted"),
  ];
  const starred = el("button", { class: "db-side-item", attrs: { type: "button" } }, [icon("star"), el("span", { class: "name", text: "Starred" })]);
  starred.addEventListener("click", () => notSimulated("Starred items"));
  top.splice(2, 0, starred);
  nav.replaceChildren(...top, el("div", { class: "db-side-label", text: "Folders" }), ...(treeCache ?? []));
  if (!inFiles && treeCache) return;
  try {
    const entries = (await listAll("")).filter((e) => e[".tag"] === "folder").sort((a, b) => a.name.localeCompare(b.name));
    const openTop = r.name === "files" || r.name === "preview" ? `/${r.arg.split("/")[0]}`.toLowerCase() : "";
    treeCache = entries.map((f) => item(f.name, null, `#/files/${encodeURIComponent(f.path_display.slice(1))}`, (r.name === "files" && `/${r.arg}`.toLowerCase() === f.path_lower) || (openTop && openTop === f.path_lower && r.name === "files" && r.arg.includes("/") ? false : false), fileGlyph("folder", "", 20)));
    for (const node of treeCache) if (node.getAttribute("href") === location.hash) node.setAttribute("aria-current", "page");
    nav.replaceChildren(...top, el("div", { class: "db-side-label", text: "Folders" }), ...treeCache);
  } catch {
    /* the main view reports the error */
  }
}

async function drawAccount() {
  try {
    const [account, usage] = await Promise.all([call("users.get-current-account"), call("users.get-space-usage")]);
    S.account = account;
    S.usage = usage;
    setServerTime(account.server_time);
    $("#account-avatar").textContent = account.name.abbreviated_name;
    const allocated = usage.allocation.allocated ?? 0;
    const pct = allocated ? Math.min(100, (usage.used / allocated) * 100) : 0;
    const bar = el("div", { class: "db-meter", attrs: { role: "progressbar", "aria-label": "Storage used", "aria-valuenow": Math.round(pct), "aria-valuemin": 0, "aria-valuemax": 100, "data-full": String(pct >= 100) } }, el("span"));
    bar.firstChild.style.width = `${pct}%`;
    const more = el("button", { class: "db-link-btn", text: "Get more space", attrs: { type: "button" } });
    more.addEventListener("click", () => notSimulated("Plans and storage upgrades"));
    $("#storage").replaceChildren(el("div", { class: "db-storage-title", text: account.account_type[".tag"] === "basic" ? "Basic" : account.account_type[".tag"] === "pro" ? "Plus" : "Business" }), bar, el("div", { class: "db-storage-text", text: `${formatSize(usage.used)} of ${formatSize(allocated)} used` }), more);
    return true;
  } catch (error) {
    S.account = null;
    $("#account-avatar").textContent = "?";
    $("#storage").replaceChildren(el("div", { class: "db-storage-text", text: describe(error) }));
    return error;
  }
}

$("#account-btn").addEventListener("click", (event) => {
  const a = S.account;
  const header = el("div", { class: "db-menu-head" }, [el("span", { class: "db-avatar", text: a?.name?.abbreviated_name ?? "?" }), el("div", {}, [el("strong", { text: a?.name?.display_name ?? "Unknown account" }), el("small", { text: a?.email ?? "" })])]);
  openMenu(event.currentTarget, [
    { label: "Settings", icon: "settings", onClick: () => notSimulated("Account settings") },
    { label: "Upgrade", icon: "star", onClick: () => notSimulated("Plans and upgrades") },
    { label: "Install app", icon: "download", onClick: () => notSimulated("Dropbox desktop app") },
    "sep",
    { label: "Sign out", icon: "signout", disabled: true, hint: "The Firedrill actor is fixed for this app" },
  ], { align: "right", header });
});

for (const b of document.querySelectorAll("[data-unsim]")) b.addEventListener("click", () => notSimulated(b.dataset.unsim));
$("#menu-toggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#search").value.trim();
  if (q) go("search", q);
});

let generation = 0;
async function render({ soft = false } = {}) {
  const r = route();
  const mine = ++generation;
  closeMenus();
  if (!soft) closeAllModals();
  document.body.classList.remove("nav-open");
  const active = r.name === "preview" ? "files" : r.name === "deleted" || r.name === "search" ? "files" : r.name;
  drawRail(active);
  drawSide(r);
  const host = $("#content");
  if (r.name !== "search" && document.activeElement !== $("#search")) $("#search").value = "";
  if (r.name === "search") $("#search").value = r.arg;
  const opts = { soft };
  if (mine !== generation) return;
  if (r.name === "files") return renderFiles(host, toPath(r.arg), opts);
  if (r.name === "preview") return renderPreview(host, toPath(r.arg));
  if (r.name === "photos") return renderPhotos(host, opts);
  if (r.name === "shared") return renderShared(host, opts);
  if (r.name === "deleted") return renderDeleted(host, opts);
  if (r.name === "search" && r.arg) return renderSearch(host, r.arg, opts);
  return renderHome(host, opts);
}

setRenderer(async ({ soft }) => {
  treeCache = null;
  await drawAccount();
  return render({ soft });
});

window.addEventListener("hashchange", () => render());
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !isModalOpen() && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")) {
    e.preventDefault();
    $("#search").focus();
  }
});

hydrateIcons();
let revision = null;
async function boot() {
  try {
    const context = await getContext();
    revision = JSON.stringify(context.revision);
  } catch {}
  const accountResult = await drawAccount();
  if (accountResult !== true && (accountResult?.denied || accountResult?.is?.("MISSING_SCOPE"))) {
    $("#banner").hidden = false;
    $("#banner").textContent = "Account details are unavailable for this actor; dates are shown without relative time.";
  }
  await render();
  setInterval(async () => {
    try {
      const context = await getContext();
      const next = JSON.stringify(context.revision);
      if (next !== revision) {
        revision = next;
        if (!isModalOpen()) {
          treeCache = null;
          await drawAccount();
          render({ soft: true });
        }
      }
    } catch {}
  }, 2000);
}
boot();

export { folderHash, deniedState };
