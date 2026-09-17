// SuiteQL projection: select list, DISTINCT, GROUP BY / HAVING, ORDER BY and FETCH FIRST, rendered as NetSuite does.
import { runSql } from "./suiteql-run.mjs";
import { sqlBad } from "./suiteql-parse.mjs";

const hasAggregate = (node) => {
  if (node === null || node === undefined) return false;
  if (node.kind === "aggregate") return true;
  if (node.kind === "call") return node.args.some(hasAggregate);
  return false;
};

/** NetSuite renders every scalar in a SuiteQL result as a JSON string; null stays null. */
const render = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "T" : "F";
  return String(value);
};

function columnName(item, index, scope) {
  if (item.alias !== null && item.alias !== undefined) return item.alias.toLowerCase();
  if (item.expression.kind === "column") return scope.resolve(item.expression).column;
  if (item.expression.kind === "df") return `df_${scope.resolve(item.expression.column).column}`;
  return `expr${index + 1}`;
}

/** Execute a SuiteQL statement and return plain result rows (all scalars already rendered). */
export function executeSql(session, statement, params) {
  const { plan, scope, rows, value, test } = runSql(session, statement, params);

  const expanded = [];
  for (const [index, item] of plan.select.entries()) {
    if (item.expression.kind === "star") {
      for (const column of scope.star(item.expression.qualifier)) {
        expanded.push({ name: column.name, read: (row) => row[column.key] ?? null });
      }
      continue;
    }
    const name = columnName(item, index, scope);
    expanded.push({ name, expression: item.expression, read: (row) => value(item.expression, row) });
  }

  const grouped = plan.groupBy.length > 0 || plan.select.some((item) => hasAggregate(item.expression));
  let resultRows;
  if (!grouped) {
    if (plan.having !== null) sqlBad("HAVING needs a grouped statement");
    resultRows = rows.map((row) => {
      const output = {};
      for (const column of expanded) output[column.name] = column.read(row);
      return { output, source: row };
    });
  } else {
    const keys = plan.groupBy.map((reference) => scope.resolve(reference).key);
    const buckets = new Map();
    for (const row of rows) {
      const composite = keys.map((key) => (row[key] === null ? "\u0001" : String(row[key]))).join("\u0000");
      const bucket = buckets.get(composite);
      if (bucket === undefined) buckets.set(composite, [row]);
      else bucket.push(row);
    }
    if (keys.length === 0) buckets.set("", rows);
    resultRows = [];
    for (const bucket of buckets.values()) {
      const first = bucket[0] ?? {};
      const output = {};
      const carrier = { ...first, __bucket__: bucket };
      for (const column of expanded) {
        output[column.name] = column.expression !== undefined && hasAggregate(column.expression)
          ? value(column.expression, carrier)
          : column.read(first);
      }
      const groupRow = { output, source: first, bucket, carrier };
      if (plan.having === null || test(plan.having, carrier)) resultRows.push(groupRow);
    }
  }

  if (plan.distinct === true) {
    const seen = new Set();
    resultRows = resultRows.filter((entry) => {
      const key = JSON.stringify(entry.output);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  for (const order of [...plan.orderBy].reverse()) {
    // ORDER BY may name a select alias, as Oracle allows; otherwise it is an expression over the source row.
    const alias = order.expression.kind === "column" && order.expression.qualifier === null
      ? order.expression.name.toLowerCase()
      : null;
    const read = (entry) => {
      if (alias !== null && Object.hasOwn(entry.output, alias)) return entry.output[alias];
      return order.expression.kind === "column"
        ? entry.source[scope.resolve(order.expression).key] ?? null
        : value(order.expression, entry.carrier ?? entry.source);
    };
    resultRows = [...resultRows].sort((left, right) => {
      const a = read(left);
      const b = read(right);
      if (a === b) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      const numeric = Number(a) - Number(b);
      const compared = Number.isFinite(numeric) && String(a).trim() !== "" && String(b).trim() !== ""
        ? numeric
        : String(a) < String(b) ? -1 : 1;
      return order.direction === "desc" ? -compared : compared;
    });
  }

  if (plan.fetch !== null) resultRows = resultRows.slice(0, plan.fetch);

  return resultRows.map((entry) => {
    const output = {};
    for (const [key, raw] of Object.entries(entry.output)) output[key] = render(raw);
    return output;
  });
}
