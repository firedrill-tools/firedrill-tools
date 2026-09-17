// Dashboard widgets: validation of the four supported definitions into a strict stored shape, and rendering back.
import { bad, present } from "./core.mjs";
import { parseMetricQuery } from "./mquery.mjs";
import { text } from "./text.mjs";

export const WIDGET_TYPES = ["note", "timeseries", "query_value", "toplist"];
const DEF_KEYS = new Map([
  ["note", ["type", "content", "background_color", "font_size", "text_align", "show_tick"]],
  ["timeseries", ["type", "title", "show_legend", "requests"]],
  ["query_value", ["type", "title", "requests", "precision", "autoscale", "custom_unit"]],
  ["toplist", ["type", "title", "requests"]],
]);
const REQUEST_KEYS = ["q", "queries", "formulas", "response_format", "display_type", "aggregator"];
const invalid = (context, detail) => bad(context, `Invalid widget definition: ${detail}`);

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace `$name` template variables with a placeholder tag so the query parses; unknown variables fail. */
function checkQuery(context, query, variables) {
  if (typeof query !== "string" || query.length === 0 || query.length > 4000) invalid(context, "query must be 1-4000 characters");
  let expanded = "";
  for (let i = 0; i < query.length; i += 1) {
    if (query[i] !== "$") { expanded += query[i]; continue; }
    let j = i + 1;
    while (j < query.length && /[A-Za-z0-9_-]/.test(query[j])) j += 1;
    const name = query.slice(i + 1, j);
    if (!variables.includes(name)) invalid(context, `unknown template variable $${name}`);
    expanded += `${name}:tv`;
    i = j - 1;
  }
  const parsed = parseMetricQuery(expanded);
  if (!parsed.ok) bad(context, parsed.message);
}

function request(context, raw, variables, type) {
  if (!isObject(raw)) invalid(context, "requests entries must be objects");
  for (const key of Object.keys(raw)) if (!REQUEST_KEYS.includes(key)) invalid(context, `unsupported request field ${key}`);
  const out = { q: null, queries: [], formulas: [], responseFormat: null, displayType: null, aggregator: null };
  if (present(raw.q)) { checkQuery(context, raw.q, variables); out.q = raw.q; }
  if (present(raw.queries)) {
    if (!Array.isArray(raw.queries) || raw.queries.length === 0 || raw.queries.length > 10) invalid(context, "queries must contain 1-10 entries");
    out.queries = raw.queries.map((query) => {
      if (!isObject(query) || query.data_source !== "metrics" || typeof query.name !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(query.name)) {
        invalid(context, "queries entries need data_source \"metrics\", a name and a query");
      }
      checkQuery(context, query.query, variables);
      return { dataSource: "metrics", name: query.name, query: query.query };
    });
    if (!Array.isArray(raw.formulas) || raw.formulas.length === 0 || raw.formulas.length > 10) invalid(context, "formulas must contain 1-10 entries");
    out.formulas = raw.formulas.map((formula) => {
      if (!isObject(formula) || !out.queries.some((query) => query.name === formula.formula)) invalid(context, "each formula must name one of the request queries");
      return { formula: formula.formula, alias: text(context, formula.alias, "alias", { max: 100 }) };
    });
    out.responseFormat = type === "timeseries" ? "timeseries" : "scalar";
    if (present(raw.response_format) && raw.response_format !== out.responseFormat) invalid(context, `response_format must be ${out.responseFormat}`);
  } else if (present(raw.formulas)) invalid(context, "formulas require queries");
  if ((out.q === null) === (out.queries.length === 0)) invalid(context, "each request needs exactly one of q or queries");
  if (present(raw.display_type)) {
    if (type !== "timeseries" || !["line", "bars", "area"].includes(raw.display_type)) invalid(context, "display_type is line, bars or area on timeseries");
    out.displayType = raw.display_type;
  }
  if (present(raw.aggregator)) {
    if (type === "timeseries" || !["avg", "sum", "min", "max", "last"].includes(raw.aggregator)) invalid(context, "aggregator is avg, sum, min, max or last");
    out.aggregator = raw.aggregator;
  }
  return out;
}

function layout(context, raw, layoutType) {
  if (!present(raw)) {
    if (layoutType === "free") invalid(context, "widgets on a free layout need a layout");
    return null;
  }
  if (!isObject(raw)) invalid(context, "layout must be an object");
  const out = {};
  for (const key of ["x", "y", "width", "height"]) {
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0 || raw[key] > 10000 || ((key === "width" || key === "height") && raw[key] < 1)) invalid(context, `layout.${key} must be a non-negative integer`);
    out[key] = raw[key];
  }
  out.is_column_break = raw.is_column_break === true;
  return out;
}

export function normalizeWidgets(context, raw, layoutType, variables, nextWidgetId) {
  if (!Array.isArray(raw)) bad(context, "Missing required parameter: widgets");
  if (raw.length > 100) invalid(context, "a dashboard supports at most 100 widgets");
  return raw.map((widget) => {
    if (!isObject(widget) || !isObject(widget.definition)) invalid(context, "each widget needs a definition object");
    for (const key of Object.keys(widget)) if (!["id", "definition", "layout"].includes(key)) invalid(context, `unsupported widget field ${key}`);
    const def = widget.definition;
    if (typeof def.type !== "string" || !DEF_KEYS.has(def.type)) invalid(context, `type must be one of ${WIDGET_TYPES.join(", ")}`);
    for (const key of Object.keys(def)) if (!DEF_KEYS.get(def.type).includes(key)) invalid(context, `unsupported ${def.type} field ${key}`);
    const out = { type: def.type, title: null, content: null, backgroundColor: null, fontSize: null, textAlign: null, showTick: null, showLegend: null, precision: null, autoscale: null, customUnit: null, requests: [] };
    if (def.type === "note") {
      out.content = text(context, def.content, "content", { required: true, min: 1, max: 20000 });
      out.backgroundColor = text(context, def.background_color, "background_color", { max: 50 });
      out.fontSize = text(context, def.font_size, "font_size", { max: 10 });
      if (present(def.text_align) && !["left", "center", "right"].includes(def.text_align)) invalid(context, "text_align is left, center or right");
      out.textAlign = def.text_align ?? null;
      if (present(def.show_tick) && typeof def.show_tick !== "boolean") invalid(context, "show_tick must be a boolean");
      out.showTick = def.show_tick ?? null;
    } else {
      out.title = text(context, def.title, "title", { max: 500 });
      const max = def.type === "timeseries" ? 10 : 1;
      if (!Array.isArray(def.requests) || def.requests.length === 0 || def.requests.length > max) invalid(context, `${def.type} needs 1-${max} requests`);
      out.requests = def.requests.map((entry) => request(context, entry, variables, def.type));
      if (present(def.show_legend) && typeof def.show_legend !== "boolean") invalid(context, "show_legend must be a boolean");
      out.showLegend = def.show_legend ?? null;
      if (present(def.precision) && (!Number.isSafeInteger(def.precision) || def.precision < 0 || def.precision > 10)) invalid(context, "precision must be 0-10");
      out.precision = def.precision ?? null;
      if (present(def.autoscale) && typeof def.autoscale !== "boolean") invalid(context, "autoscale must be a boolean");
      out.autoscale = def.autoscale ?? null;
      out.customUnit = text(context, def.custom_unit, "custom_unit", { max: 20 });
    }
    return { id: nextWidgetId(), definition: out, layout: layout(context, widget.layout, layoutType) };
  });
}

function renderRequest(entry) {
  const out = entry.q !== null ? { q: entry.q } : {
    queries: entry.queries.map((query) => ({ data_source: query.dataSource, name: query.name, query: query.query })),
    formulas: entry.formulas.map((formula) => (formula.alias === null ? { formula: formula.formula } : { formula: formula.formula, alias: formula.alias })),
    response_format: entry.responseFormat,
  };
  if (entry.displayType !== null) out.display_type = entry.displayType;
  if (entry.aggregator !== null) out.aggregator = entry.aggregator;
  return out;
}

export function renderWidget(widget) {
  const def = widget.definition;
  const out = { type: def.type };
  const pairs = [["title", def.title], ["content", def.content], ["background_color", def.backgroundColor], ["font_size", def.fontSize],
    ["text_align", def.textAlign], ["show_tick", def.showTick], ["show_legend", def.showLegend], ["precision", def.precision],
    ["autoscale", def.autoscale], ["custom_unit", def.customUnit]];
  for (const [key, value] of pairs) if (value !== null) out[key] = value;
  if (def.type !== "note") out.requests = def.requests.map(renderRequest);
  const rendered = { id: widget.id, definition: out };
  if (widget.layout !== null) rendered.layout = widget.layout;
  return rendered;
}
