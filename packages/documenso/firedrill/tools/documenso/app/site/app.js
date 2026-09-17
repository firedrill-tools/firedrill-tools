// Documenso Tool browser app. Every screen calls the Tool's own operations through /_firedrill/client.js; records are
// re-read after each write and whenever the world revision moves.
import { getContext } from "/_firedrill/client.js";
import { renderDocument, renderLogs } from "./document.js";
import { renderDocuments } from "./documents.js";
import { renderEditor } from "./editor.js";
import { hydrateIcons, icon } from "./icons.js";
import { closeDialog, closeMenu, initials, menu, notSimulated } from "./overlay.js";
import { renderSign } from "./sign.js";
import { app, go, parseHash } from "./state.js";
import { renderTemplates } from "./templates.js";
import { $, call, describe, el, isBusy, ToolError } from "./ui.js";

hydrateIcons();

async function loadWorkspace() {
  app.workspace = await call("workspace.context");
  const { team, user, teams } = app.workspace;
  $("#org-avatar").textContent = initials(team.name);
  $("#org-name").textContent = team.name;
  $("#org-sub").textContent = user.name;
  $("#org-switcher").title = `${team.name} · ${user.email}`;
  app.teams = teams;
}

function deniedPanel(main, error) {
  main.replaceChildren(el("div", { class: "container" }, el("div", { class: "denied", attrs: { role: "alert" } }, [
    icon("shield"), el("h2", { text: "You don't have access" }),
    el("p", { text: error instanceof ToolError && error.status === "denied" ? "This actor is not granted the operations this page needs. Ask for access to the Documenso Tool in this Firedrill world." : describe(error) }),
  ])));
}

export function errorPanel(main, error) {
  if (error instanceof ToolError && error.denied) return deniedPanel(main, error);
  main.replaceChildren(el("div", { class: "container" }, el("div", { class: "denied", attrs: { role: "alert" } }, [
    icon("alert"), el("h2", { text: error instanceof ToolError && error.is("NOT_FOUND") ? "Not found" : "Something went wrong" }),
    el("p", { text: describe(error) }),
    el("p", {}, el("a", { class: "btn btn-outline", text: "Go back to documents", attrs: { href: "#/documents" } })),
  ])));
}
app.errorPanel = errorPanel;

async function route() {
  closeMenu();
  closeDialog();
  const main = $("#main");
  const { parts, params } = parseHash();
  const [section, id, sub] = parts;
  const signing = section === "sign";
  document.body.classList.toggle("is-signing", signing);
  $("#nav-documents").classList.toggle("is-active", section === "documents" || !section);
  $("#nav-templates").classList.toggle("is-active", section === "templates");
  main.replaceChildren(el("div", { class: "page-loading" }, icon("loader", "spin")));
  try {
    if (!app.workspace && !signing) await loadWorkspace();
    if (signing) app.page = await renderSign(main, id);
    else if (section === "templates") app.page = await renderTemplates(main, params);
    else if (section === "documents" && id && sub === "edit") app.page = await renderEditor(main, id);
    else if (section === "documents" && id && sub === "logs") app.page = await renderLogs(main, id, params);
    else if (section === "documents" && id) app.page = await renderDocument(main, id);
    else if (section !== "documents") return go("#/documents");
    else app.page = await renderDocuments(main, params);
  } catch (error) {
    app.page = null;
    errorPanel(main, error);
  }
}

window.addEventListener("hashchange", () => void route());
window.addEventListener("scroll", () => $("#app-header").classList.toggle("scrolled", window.scrollY > 5));

$("#command-trigger").addEventListener("click", () => {
  go("#/documents");
  queueMicrotask(() => $("#doc-search")?.focus());
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    $("#command-trigger").click();
  }
});

$("#org-switcher").addEventListener("click", (event) => {
  const ws = app.workspace;
  if (!ws) return;
  const items = [{ heading: "Teams" }];
  for (const team of ws.teams) {
    const current = team.id === ws.team.id;
    items.push({ label: team.name, trailing: current ? "Current" : team.role, active: current, iconName: current ? "check" : "users",
      onClick: current ? () => go("#/documents") : () => notSimulated("Switching teams", "This app acts as the Firedrill actor's team (the documensoTeamId attribute). Pick another actor in the inspector to work as a different team.") });
  }
  items.push({ separator: true }, { heading: ws.user.email },
    { label: "Organisation settings", iconName: "building", onClick: () => notSimulated("Organisation settings") },
    { label: "Team settings", iconName: "settings", onClick: () => notSimulated("Team settings", "Team members, API tokens, webhooks, branding and preferences are not simulated by this Tool.") },
    { label: "User settings", iconName: "user", onClick: () => notSimulated("User settings", "Profile, security, passkeys and billing are not simulated by this Tool.") },
    { separator: true },
    { label: "Sign Out", iconName: "logOut", onClick: () => notSimulated("Signing out", "The app is bound to the selected Firedrill actor; there is no session to end.") });
  menu(event.currentTarget, items, { width: 260 });
});

// Refresh the current page when the world revision moves (never while a write, dialog or unsaved form is active).
let revision;
async function watch() {
  if (isBusy() || document.visibilityState !== "visible") return;
  try {
    const context = await getContext();
    const stamp = JSON.stringify(context.revision);
    if (revision === undefined) { revision = stamp; return; }
    if (stamp === revision) return;
    if (document.querySelector(".dialog-backdrop") || app.page?.mayRefresh?.() === false) return;
    revision = stamp;
    if (!document.body.classList.contains("is-signing")) await loadWorkspace().catch(() => {});
    await app.page?.refresh?.();
    $("#banner").hidden = true;
  } catch (error) {
    $("#banner").textContent = `The local Firedrill environment is unavailable: ${describe(error)}`;
    $("#banner").hidden = false;
  }
}
setInterval(() => void watch(), 2000);
void watch();
void route();
