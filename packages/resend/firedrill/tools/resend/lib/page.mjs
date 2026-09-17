// Resend cursor pagination over a fully materialised, bounded row list: `limit` 1–100 (default 20), `after` and
// `before` are exclusive object ids, output `{ object: "list", has_more, data }`.
import { fail, normalizeUuid } from "./core.mjs";
import { utf8Bytes } from "./check.mjs";

// UTF-8 bytes of the rendered rows (plus separators), kept well under the 1 MiB response cap with room for the envelope.
const MAX_PAGE_BYTES = 900_000;

function parseLimit(context, raw) {
  if (raw === undefined || raw === null) return 20;
  let value = raw;
  if (typeof raw === "string") value = /^[0-9]{1,6}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    fail(context, "VALIDATION_ERROR", "The `limit` parameter must be an integer between 1 and 100.");
  }
  return value;
}

function cursorIndex(context, ids, raw, name) {
  const id = normalizeUuid(raw);
  if (id === null) fail(context, "VALIDATION_ERROR", `The \`${name}\` parameter must be a valid id.`);
  const index = ids.indexOf(id);
  if (index < 0) fail(context, "VALIDATION_ERROR", `The \`${name}\` cursor does not match any object in this list.`);
  return index;
}

/** Read `limit`/`after`/`before` from `input` and slice `items` (each with a string `id`). `render` maps an item. */
export function paginate(context, input, items, render) {
  const limit = parseLimit(context, input.limit);
  const hasAfter = input.after !== undefined && input.after !== null;
  const hasBefore = input.before !== undefined && input.before !== null;
  if (hasAfter && hasBefore) fail(context, "VALIDATION_ERROR", "You can only use `after` or `before`, not both.");
  const ids = items.map((item) => item.id);
  let start = 0;
  let end = items.length;
  if (hasAfter) start = cursorIndex(context, ids, input.after, "after") + 1;
  const data = [];
  let bytes = 0;
  if (hasBefore) {
    // Fill backward from the row just before the cursor so a byte-capped page stays adjacent to `before` and
    // every earlier row remains reachable through `has_more`.
    end = cursorIndex(context, ids, input.before, "before");
    const floor = Math.max(0, end - limit);
    let first = end;
    for (let i = end - 1; i >= floor; i -= 1) {
      const rendered = render(items[i]);
      bytes += utf8Bytes(JSON.stringify(rendered)) + 1;
      if (data.length > 0 && bytes > MAX_PAGE_BYTES) break;
      data.push(rendered);
      first = i;
    }
    data.reverse();
    return { object: "list", has_more: first > 0, data };
  }
  end = Math.min(items.length, start + limit);
  for (let i = start; i < end; i += 1) {
    const rendered = render(items[i]);
    bytes += utf8Bytes(JSON.stringify(rendered)) + 1;
    if (data.length > 0 && bytes > MAX_PAGE_BYTES) {
      end = i;
      break;
    }
    data.push(rendered);
  }
  return { object: "list", has_more: end < items.length, data };
}
