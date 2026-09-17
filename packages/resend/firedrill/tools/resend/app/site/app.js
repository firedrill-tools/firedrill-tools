// Resend Tool browser app: hash router, chrome and world watching. Every screen reads and writes through the Tool's
// own operations via /_firedrill/client.js; nothing here is authoritative and records are re-read after each write.
import { hydrateIcons } from "./icons.js";
import { $, call, clock, el, notSimulated, watchWorld } from "./ui.js";
import { renderEmails, renderEmailDetail } from "./view-emails.js";
import { renderDomains, renderDomainDetail } from "./view-domains.js";
import { renderApiKeys } from "./view-keys.js";
import { renderContacts, renderSegments } from "./view-audience.js";

export const workspace = { value: null, error: null };

async function loadWorkspace() {
  try {
    const value = await call("workspace.context");
    workspace.value = value;
    workspace.error = null;
    clock.set(value.now);
    $("#team-name").textContent = value.team.name;
    $("#team-avatar").textContent = value.team.name.charAt(0).toUpperCase();
    $("#user-name").textContent = value.apiKey.name;
    $("#user-avatar").textContent = value.apiKey.name.charAt(0).toUpperCase();
    const usage = $("#usage");
    usage.replaceChildren(
      el("div", { class: "usage-plan", text: `${value.team.plan.charAt(0).toUpperCase() + value.team.plan.slice(1)} plan` }),
      el("div", {}, ["Daily emails ", el("strong", { text: `${value.team.sentToday} / ${value.team.dailyQuota}` })]),
      el("div", { class: "meter", attrs: { role: "presentation" } }, [el("span")]),
    );
    usage.querySelector(".meter span").style.width = `${Math.min(100, (100 * value.team.sentToday) / value.team.dailyQuota)}%`;
  } catch (error) {
    workspace.error = error;
    $("#team-name").textContent = "Resend";
    $("#team-avatar").textContent = "?";
    $("#user-name").textContent = "No access";
    $("#user-avatar").textContent = "?";
    $("#usage").replaceChildren();
  }
}

const ROUTES = [
  [/^#\/emails\/([^/]+)$/, "emails", (m, v, o) => renderEmailDetail(decodeURIComponent(m[1]), v, o)],
  [/^#\/emails$/, "emails", (m, v, o) => renderEmails(m, v, o)],
  [/^#\/domains\/([^/]+)$/, "domains", (m, v, o) => renderDomainDetail(decodeURIComponent(m[1]), v, o)],
  [/^#\/domains$/, "domains", (m, v, o) => renderDomains(m, v, o)],
  [/^#\/api-keys$/, "api-keys", (m, v, o) => renderApiKeys(m, v, o)],
  [/^#\/audience\/segments$/, "segments", (m, v, o) => renderSegments(m, v, o)],
  [/^#\/audience(\/contacts)?$/, "contacts", (m, v, o) => renderContacts(m, v, o)],
];

let current = null;
async function route() {
  const hash = location.hash || "#/emails";
  const match = ROUTES.map(([re, name, render]) => ({ m: re.exec(hash), name, render })).find((r) => r.m);
  if (!match) {
    location.replace("#/emails");
    return;
  }
  for (const link of document.querySelectorAll("#nav a[data-route]")) {
    const on = link.dataset.route === match.name || (link.dataset.route === "audience" && (match.name === "contacts" || match.name === "segments"));
    link.classList.toggle("active", on && !(link.dataset.route === "audience"));
    if (on) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  document.body.classList.remove("nav-open");
  current = match;
  const view = $("#view");
  try {
    await match.render(match.m, view);
  } catch (error) {
    view.replaceChildren(el("p", { class: "muted", text: error?.message ?? "Failed to render." }));
  }
}

/** Views call this to re-render the current route in place (after a write or a world revision change). */
export async function refresh() {
  await loadWorkspace();
  if (current) await current.render(current.m, $("#view"), { refresh: true });
}

document.addEventListener("click", (event) => {
  const soon = event.target.closest("[data-soon]");
  if (soon) {
    event.preventDefault();
    void notSimulated(soon.dataset.soon);
  }
});
$("#mobile-menu").addEventListener("click", () => document.body.classList.toggle("nav-open"));
hydrateIcons();
window.addEventListener("hashchange", () => void route());
await loadWorkspace();
await route();
watchWorld(refresh);
