// Setup → Company → Subsidiaries: the read-only subsidiary hierarchy of this OneWorld account.
import { register } from "../store.js";
import { call, el, errorBanner, emptyState, mdy, skeletonRows } from "../ui.js";
import { listShell, setPageTitle, nsButton } from "./common.js";

const COLUMNS = [
  { label: "Name" }, { label: "Internal ID" }, { label: "Parent" },
  { label: "Country" }, { label: "Currency" }, { label: "Elimination" }, { label: "Inactive" },
];

register("subsidiaries", async (main) => {
  setPageTitle("Subsidiaries");
  const body = el("tbody", {}, skeletonRows(COLUMNS.length, 3));
  main.replaceChildren(listShell({
    title: "Subsidiaries",
    subtitle: "Read-only in this Tool: the subsidiary tree is seeded by the world.",
    actions: [nsButton("New Subsidiary"), nsButton("Customize View")],
    columns: COLUMNS,
    body,
  }));
  try {
    const page = await call("subsidiary.list", { limit: 50, offset: 0 });
    const rows = page.items ?? [];
    if (rows.length === 0) {
      body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, emptyState("No subsidiaries are visible to this role."))));
      return;
    }
    body.replaceChildren(...rows.map((record) => el("tr", {}, [
      el("td", {}, el("span", { text: `${record.parent ? "— " : ""}${record.name}` })),
      el("td", { class: "tight mono", text: record.id }),
      el("td", { text: record.parent?.refName ?? "" }),
      el("td", { text: record.country?.refName ?? "" }),
      el("td", { text: record.currency?.refName ?? "" }),
      el("td", { text: record.isElimination ? "Yes" : "No" }),
      el("td", { text: record.isInactive ? "Yes" : "No" }),
    ])));
  } catch (error) {
    body.replaceChildren(el("tr", {}, el("td", { colspan: String(COLUMNS.length) }, errorBanner(error, "Subsidiaries could not be loaded"))));
  }
});
