// Boot, hash routing and world-revision refresh. Nothing here is authoritative: views re-read after writes and revision moves.
import { getContext } from "/_firedrill/client.js";
import { $, el, call, describe, onWrite, setServerNow, initToast, ToolError } from "./ui.js";
import { hydrateIcons } from "./icons.js";
import { session, resetCaches } from "./store.js";
import { wireNotSimulated, closeModal } from "./overlay.js";
import { initShell, paintMe, setActiveNav } from "./shell.js";
import { renderHome } from "./feed.js";
import { renderProfile } from "./profile.js";
import { renderNetwork } from "./network.js";
import { renderCompany } from "./company.js";

let view = null;
let lastRevision = null;
let ownWrite = false;

function bootScreen(title, message) {
  const boot = $("#boot");
  boot.hidden = false;
  boot.replaceChildren(
    el("img", { attrs: { src: "./assets/linkedin-wordmark.svg", alt: "LinkedIn", width: "168", height: "42" } }),
    el("h1", { class: "state-card__title", text: title }),
    el("p", { class: "boot__message", text: message }),
    el("button", { class: "btn btn--primary", text: "Try again", attrs: { type: "button" }, on: { click: () => location.reload() } }),
  );
}

function route() {
  const hash = location.hash || "#/feed";
  const main = $("#main");
  closeModal();
  const [, section = "feed", param = ""] = hash.split("/");
  let arg = "";
  try { arg = decodeURIComponent(param); } catch { arg = ""; }
  window.scrollTo({ top: 0 });
  if (section === "in" && arg) { setActiveNav(arg === session.viewer.personUrn.split(":").pop() ? "me" : ""); document.title = "Profile | LinkedIn (synthetic)"; view = renderProfile(main, arg); }
  else if (section === "mynetwork") { setActiveNav("mynetwork"); document.title = "Connections | LinkedIn (synthetic)"; view = renderNetwork(main); }
  else if (section === "company" && arg) { setActiveNav(""); document.title = "Company | LinkedIn (synthetic)"; view = renderCompany(main, arg); }
  else { setActiveNav("feed"); document.title = "Feed | LinkedIn (synthetic)"; view = renderHome(main); }
  main.focus({ preventScroll: true });
}

async function pollRevision() {
  try {
    const context = await getContext();
    const revision = JSON.stringify(context?.revision ?? null);
    if (lastRevision !== null && revision !== lastRevision) {
      if (ownWrite) ownWrite = false;
      else { resetCaches(); await view?.refresh?.(); }
    }
    lastRevision = revision;
  } catch { /* the next poll retries */ }
}

async function start() {
  initToast();
  hydrateIcons();
  wireNotSimulated();
  try {
    const first = await call("feed.list", { start: 0, count: 1 });
    session.viewer = first.viewer;
    setServerNow(first.serverTimeMs);
  } catch (error) {
    if (error instanceof ToolError && error.code === "INVALID_ACCESS_TOKEN") return bootScreen("Your session has expired", "This account's access token is no longer valid. Sign in again to continue.");
    if (error instanceof ToolError && (error.status === "denied" || error.code === "ACCESS_DENIED")) return bootScreen("You don't have access", `${describe(error)} The selected actor lacks the grants or scopes this app needs to show the feed.`);
    return bootScreen("Something went wrong", describe(error));
  }
  try { lastRevision = JSON.stringify((await getContext())?.revision ?? null); } catch { lastRevision = null; }
  onWrite(() => { ownWrite = true; void getContext().then((c) => { lastRevision = c?.revision ? JSON.stringify(c.revision) : lastRevision; ownWrite = false; }).catch(() => {}); });
  $("#boot").hidden = true;
  $("#global-nav").hidden = false;
  $("#main").hidden = false;
  paintMe();
  initShell();
  window.addEventListener("hashchange", route);
  route();
  setInterval(pollRevision, 2000);
}

void start();
