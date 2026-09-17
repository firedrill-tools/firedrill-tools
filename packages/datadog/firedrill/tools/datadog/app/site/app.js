// Datadog Tool app: hash router and bootstrap. Every screen calls this Tool's operations through
// /_firedrill/client.js; screens re-render when the world revision moves (never over a dirty form).
import { $, call, clear, el, setOrg, watchWorld, world } from "./ui.js";
import { hydrateIcons } from "./icons.js";
import { errorBlock, loadingBlock } from "./feedback.js";
import { notSimulated, renderNav, setActiveNav } from "./nav.js";
import { renderMonitors } from "./monitors.js";

const ROUTES = [
  [/^\/monitors\/manage$/, "monitors", () => renderMonitors],
  [/^\/monitors\/create$/, "monitors", async () => (await import("./monitor-edit.js")).renderMonitorCreate],
  [/^\/monitors\/(\d{1,16})\/edit$/, "monitors", async () => (await import("./monitor-edit.js")).renderMonitorEdit],
  [/^\/monitors\/(\d{1,16})$/, "monitors", async () => (await import("./monitor-detail.js")).renderMonitorDetail],
  [/^\/event\/explorer$/, "service", async () => (await import("./events.js")).renderEvents],
  [/^\/metric\/explorer$/, "metrics", async () => (await import("./metrics.js")).renderMetricExplorer],
  [/^\/metric\/summary$/, "metrics", async () => (await import("./metrics.js")).renderMetricSummary],
  [/^\/dashboard\/lists$/, "dashboards", async () => (await import("./dashboards.js")).renderDashboardList],
  [/^\/dashboard\/([a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3})$/, "dashboards", async () => (await import("./dashboard-view.js")).renderDashboard],
  [/^\/incidents$/, "service", async () => (await import("./incidents.js")).renderIncidents],
  [/^\/incidents\/([0-9a-f-]{1,36})$/, "service", async () => (await import("./incident-detail.js")).renderIncident],
];

export const app = { dirty: false, token: 0 };

export function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/monitors/manage";
  const [path, qs = ""] = raw.split("?");
  return { path, params: new URLSearchParams(qs) };
}

async function render({ soft = false } = {}) {
  const main = $("#main");
  const token = ++app.token;
  const { path, params } = parseRoute();
  const match = ROUTES.find(([re]) => re.test(path));
  if (!match) { location.replace("#/monitors/manage"); return; }
  setActiveNav(match[1]);
  const args = path.match(match[0]).slice(1);
  if (!soft) { clear(main); main.append(loadingBlock()); }
  try {
    const renderer = await match[2]();
    const fresh = el("div.dd-page", {});
    const scroll = main.scrollTop;
    const rerender = () => { if (token === app.token) void render({ soft: true }); };
    const done = renderer(fresh, rerender, { args, params, isCurrent: () => token === app.token });
    // Swap after the first synchronous paint so loading states inside the page are visible.
    if (token !== app.token) return;
    main.replaceChildren(fresh);
    if (soft) main.scrollTop = scroll;
    await done;
    hydrateIcons(fresh);
  } catch (error) {
    if (token !== app.token) return;
    main.replaceChildren(errorBlock(error, () => render()));
  }
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-notsim]");
  if (trigger) { event.preventDefault(); notSimulated(trigger.dataset.notsim); }
});

async function boot() {
  try {
    setOrg(await call("org.context"));
  } catch (error) {
    $("#main").replaceChildren(errorBlock(error, () => location.reload()));
    return;
  }
  renderNav();
  hydrateIcons(document);
  window.addEventListener("hashchange", () => { app.dirty = false; void render(); });
  watchWorld(async () => {
    try { setOrg(await call("org.context")); } catch { /* keep last context */ }
    if (!app.dirty && $("#modal-root").hidden) void render({ soft: true });
  });
  await render();
}
void boot();
export { world };
