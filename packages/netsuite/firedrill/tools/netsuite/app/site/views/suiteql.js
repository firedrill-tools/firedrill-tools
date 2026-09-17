// Analytics → SuiteQL Query Tool: a query box, a results grid with paging and the raw response body.
// This screen mirrors the widely used community SuiteQL Query Tool SuiteApp rather than a core NetSuite page.
import { can, register } from "../store.js";
import { call, el, errorBanner, emptyState, describe } from "../ui.js";
import { recordShell, setPageTitle, toolbarButton, nsButton } from "./common.js";

const SAMPLES = [
  ["Invoiced total by customer",
    "SELECT c.entityid AS customer, COUNT(t.id) AS invoices, SUM(t.foreigntotal) AS invoiced\nFROM transaction t JOIN customer c ON c.id = t.entity\nWHERE t.type = 'CustInvc'\nGROUP BY c.entityid\nORDER BY invoiced DESC"],
  ["Customers by subsidiary", "SELECT id, entityid, BUILTIN.DF(subsidiary) AS subsidiary FROM customer ORDER BY id"],
  ["Recent transactions", "SELECT id, tranid, trandate, type, status, foreigntotal FROM transaction ORDER BY trandate DESC"],
];
const PAGE = 25;

register("suiteql", async (main) => {
  setPageTitle("SuiteQL Query Tool");
  if (!can("REPO_ANALYTICS")) {
    main.replaceChildren(recordShell({
      title: "SuiteQL Query Tool",
      subtitle: "SuiteAnalytics Workbook permission required",
      body: errorBanner(new Error("Your role does not have the SuiteAnalytics Workbook permission, so SuiteQL queries are refused."), "Permission Violation"),
    }));
    return;
  }
  const editor = el("textarea", { id: "sql-text", class: "sql-editor", spellcheck: "false", value: SAMPLES[0][1] });
  const resultHost = el("div", {}, el("p", { class: "muted", text: "Run a query to see results." }));
  const rawHost = el("div", {});
  let offset = 0;

  async function run(nextOffset = 0) {
    offset = nextOffset;
    resultHost.replaceChildren(el("p", { class: "muted", text: "Running query…" }));
    rawHost.replaceChildren();
    try {
      const value = await call("suiteql.query", { q: editor.value, prefer: "transient", limit: PAGE, offset });
      const rows = value.items ?? [];
      if (rows.length === 0) {
        resultHost.replaceChildren(emptyState("The query returned no rows.", "SuiteQL returns every scalar as a string, as NetSuite does."));
      } else {
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== "links")))];
        resultHost.replaceChildren(
          el("div", { class: "tablewrap" }, el("table", { class: "grid" }, [
            el("thead", {}, el("tr", {}, columns.map((name) => el("th", { scope: "col", text: name })))),
            el("tbody", {}, rows.map((row) => el("tr", {}, columns.map((name) => el("td", { text: row[name] === undefined || row[name] === null ? "" : String(row[name]) }))))),
          ])),
          el("div", { class: "pager" }, [
            el("span", { text: `${value.offset + 1} to ${value.offset + rows.length} of ${value.totalResults}` }),
            el("span", { class: "grow" }),
            el("button", { type: "button", class: "btn", text: "Previous", disabled: offset === 0, onclick: () => run(Math.max(0, offset - PAGE)) }),
            el("button", { type: "button", class: "btn", text: "Next", disabled: value.hasMore !== true, onclick: () => run(offset + PAGE) }),
          ]),
        );
      }
      rawHost.replaceChildren(el("div", { class: "sql-out" }, el("pre", { text: JSON.stringify(value, null, 2).slice(0, 20000) })));
    } catch (error) {
      resultHost.replaceChildren(errorBanner(error, "The query could not be run"));
      rawHost.replaceChildren(el("div", { class: "sql-out" }, el("pre", { text: describe(error) })));
    }
  }

  main.replaceChildren(recordShell({
    title: "SuiteQL Query Tool",
    subtitle: "POST /services/rest/query/v1/suiteql · Prefer: transient",
    actions: [
      toolbarButton("Run Query", () => run(0), { kind: "primary" }),
      toolbarButton("Clear", () => { editor.value = ""; resultHost.replaceChildren(el("p", { class: "muted", text: "Run a query to see results." })); rawHost.replaceChildren(); }),
      nsButton("Save Query"),
      nsButton("Query History"),
    ],
    body: [
      el("div", { class: "field" }, [el("label", { class: "fl", for: "sql-text", text: "SuiteQL" }), editor]),
      el("div", { class: "btn-row" }, [
        el("span", { class: "muted", text: "Samples:" }),
        ...SAMPLES.map(([label, text]) => el("button", { type: "button", class: "btn link", text: label, onclick: () => { editor.value = text; } })),
      ]),
      el("section", { class: "sublist" }, [el("header", {}, el("h3", { text: "Results" })), el("div", { class: "fg-body" }, resultHost)]),
      el("section", { class: "sublist" }, [el("header", {}, el("h3", { text: "Response body" })), rawHost]),
    ],
  }));
  await run(0);
});
