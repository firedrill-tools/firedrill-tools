// Google Sheets Tool app — a browser client for the synthetic Google Sheets service served by this Tool package.
// Every screen calls the package's own operations through /_firedrill/client.js, so a change made here is visible
// over the Sheets/Drive REST routes and MCP tools, and a change made there appears here after the world revision moves.
import { getContext } from "/_firedrill/client.js";
import { mountIcons } from "./icons.js";
import { $, avatar, call, closeMenus, closeModal, dialogOpen, menuOpen, parseTime, toast, ToolError, watchWorld } from "./ui.js";
import { createHome } from "./home.js";
import { createEditor } from "./editor.js";

const app = {
  context: undefined,
  about: undefined,
  openForms: 0,
  nowMs() {
    return parseTime(app.about?.serverTime);
  },
  formOpened() {
    app.openForms += 1;
  },
  formClosed() {
    app.openForms = Math.max(0, app.openForms - 1);
  },
  async refreshAbout() {
    app.about = await call("about.get", {});
    renderAccount();
  },
  openSpreadsheet(id, gid) {
    const target = `#d/${encodeURIComponent(id)}${gid === undefined ? "" : `/gid=${gid}`}`;
    if (location.hash === target) void route();
    else location.hash = target;
  },
  replaceGid(id, gid) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}#d/${encodeURIComponent(id)}/gid=${gid}`);
  },
  goHome() {
    if (location.hash === "" || location.hash === "#") void route();
    else location.hash = "";
  },
  showDenied() {
    showFullpage("You need access", "The Firedrill actor for this app has no grant for the Google Sheets operations this screen needs. Add the grants to the actor in the world, then reopen the app.");
    $("#fullpage-home").hidden = true;
  },
  showNotFound() {
    showFullpage("Sorry, the file you have requested does not exist.", "Make sure that you have the correct URL and the file exists, and that the owner has shared it with you.");
    $("#fullpage-home").hidden = false;
  },
};

function showFullpage(title, text) {
  $("#boot").hidden = true;
  $("#home").hidden = true;
  $("#editor").hidden = true;
  $("#fullpage-title").textContent = title;
  $("#fullpage-text").textContent = text;
  $("#fullpage").hidden = false;
  document.title = "Google Sheets";
}

function renderAccount() {
  const user = app.about?.user;
  for (const id of ["#account-avatar", "#editor-avatar"]) {
    const host = $(id);
    const fresh = avatar(user?.displayName, user?.emailAddress);
    host.textContent = fresh.textContent;
    host.style.background = fresh.style.background;
  }
  const label = user ? `Google Account: ${user.displayName} (${user.emailAddress})` : "Google Account";
  $("#account-btn").setAttribute("aria-label", label);
  $("#account-btn").title = label;
  $("#editor-account").setAttribute("aria-label", label);
  $("#editor-account").title = label;
}

mountIcons();
const home = createHome(app);
const editor = createEditor(app);
$("#editor-account").addEventListener("click", home.accountMenu);
$("#fullpage-home").addEventListener("click", (event) => {
  event.preventDefault();
  app.goHome();
});

let current;
async function route() {
  closeMenus();
  closeModal();
  const match = /^#d\/([^/]+)(?:\/gid=(\d+))?$/.exec(location.hash);
  $("#boot").hidden = true;
  $("#fullpage").hidden = true;
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      app.showNotFound();
      return;
    }
    $("#home").hidden = true;
    $("#editor").hidden = false;
    current = "editor";
    await editor.open(id, match[2] === undefined ? undefined : Number(match[2]));
  } else {
    editor.close();
    $("#editor").hidden = true;
    $("#home").hidden = false;
    document.title = "Google Sheets";
    current = "home";
    home.show();
  }
}

async function start() {
  try {
    app.context = await getContext();
    await app.refreshAbout();
  } catch (error) {
    if (error instanceof ToolError && error.denied) {
      app.showDenied();
      return;
    }
    showFullpage("Google Sheets can't connect", error instanceof ToolError ? error.message : (error?.message ?? "The local Firedrill environment is unavailable."));
    $("#fullpage-home").hidden = true;
    return;
  }
  window.addEventListener("hashchange", () => void route());
  await route();
  watchWorld(
    async () => {
      try {
        await app.refreshAbout();
      } catch (error) {
        toast(error?.message ?? "Couldn't refresh.", { error: true });
      }
      if (current === "editor") await editor.refresh();
      else if (current === "home") await home.refresh();
    },
    () => app.openForms === 0 && !dialogOpen() && !menuOpen() && !editor.hasUnsavedInput(),
  );
}

void start();
