// Workspace-wide reads shared by every screen: identity, members, objects, lists, attribute schemas and a record-name
// index. Everything is re-read after the world revision moves; nothing cached here is authoritative.
import { ToolError, call } from "./ui.js";

export const store = {
  self: undefined,
  me: undefined,
  members: [],
  membersById: new Map(),
  objects: [],
  objectsBySlug: new Map(),
  objectsById: new Map(),
  lists: [],
  listsDenied: false,
  nowMs: undefined,
  attrs: new Map(),
  choices: new Map(),
  names: new Map(),
  namesLoaded: false,
  namesPartial: new Set(),
  namesMissing: new Set(),
};

/** Visual identity of the standard objects (the sidebar and record avatars use these). */
const OBJECT_META = {
  people: { icon: "user", color: "#266df0", tint: "#e8f0fe" },
  companies: { icon: "building", color: "#f2750f", tint: "#fff1e5" },
  deals: { icon: "deals", color: "#1d9e5b", tint: "#e6f6ec" },
};
export const objectMeta = (slug) => (Object.hasOwn(OBJECT_META, slug) ? OBJECT_META[slug] : { icon: "overview", color: "#75777c", tint: "#f1f1f2" });

export function parseTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(value ?? "");
  if (!match) return undefined;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0));
}

export async function loadBase() {
  // A token without the member-read scope still opens the workspace: names fall back to "Unknown member".
  const membersCall = call("workspace-members.list").catch((error) => {
    if (error instanceof ToolError && error.denied) return { data: [], denied: true };
    throw error;
  });
  const [self, members, objects] = await Promise.all([call("self.identify"), membersCall, call("objects.list")]);
  store.self = self;
  store.membersDenied = members.denied === true;
  store.nowMs = parseTime(self.server_time);
  store.members = members.data;
  store.membersById = new Map(members.data.map((m) => [m.id.workspace_member_id, m]));
  store.me = store.membersById.get(self.authorized_by_workspace_member_id);
  store.objects = objects.data;
  store.objectsBySlug = new Map(objects.data.map((o) => [o.api_slug, o]));
  store.objectsById = new Map(objects.data.map((o) => [o.id.object_id, o]));
  try {
    store.lists = (await call("lists.list")).data;
    store.listsDenied = false;
  } catch (error) {
    if (!(error instanceof ToolError) || !error.denied) throw error;
    store.lists = [];
    store.listsDenied = true;
  }
  store.attrs.clear();
  store.choices.clear();
  store.names.clear();
  store.namesLoaded = false;
  store.namesPartial.clear();
  store.namesMissing.clear();
}

export const memberName = (id) => {
  const m = store.membersById.get(id);
  return m ? `${m.first_name} ${m.last_name}`.trim() : "Unknown member";
};

export async function attributes(target, slug) {
  const k = `${target}/${slug}`;
  if (!store.attrs.has(k)) store.attrs.set(k, call("attributes.list", { target, identifier: slug }).then((r) => r.data));
  try {
    return await store.attrs.get(k);
  } catch (error) {
    store.attrs.delete(k);
    throw error;
  }
}

/** Select options or statuses (not archived) for a select/status attribute. */
export async function choices(target, slug, def) {
  const k = `${target}/${slug}/${def.api_slug}`;
  if (!store.choices.has(k)) {
    const operation = def.type === "status" ? "statuses.list" : "select-options.list";
    store.choices.set(k, call(operation, { target, identifier: slug, attribute: def.api_slug }).then((r) => r.data));
  }
  try {
    return await store.choices.get(k);
  } catch (error) {
    store.choices.delete(k);
    throw error;
  }
}

export function recordTitle(record) {
  const name = record?.values?.name?.[0];
  if (!name) return "Unnamed";
  return (name.full_name ?? name.value ?? "").trim() || "Unnamed";
}

/** Page through the records of the standard objects once per revision to resolve reference names. The index stops at
 * NAME_INDEX_CAP records per object; references past it are resolved on demand by `resolveNames`. */
const NAME_INDEX_CAP = 5000;
const NAME_PAGE = 500;
export async function loadNames() {
  if (store.namesLoaded) return;
  for (const object of store.objects) {
    for (let offset = 0; ; offset += NAME_PAGE) {
      if (offset >= NAME_INDEX_CAP) { store.namesPartial.add(object.api_slug); break; }
      const page = (await call("records.query", { object: object.api_slug, limit: NAME_PAGE, offset })).data;
      for (const record of page) rememberName(object.api_slug, record);
      if (page.length < NAME_PAGE) break;
    }
  }
  store.namesLoaded = true;
}

function rememberName(slug, record) {
  store.names.set(record.id.record_id, { name: recordTitle(record), object: slug, domain: record.values.domains?.[0]?.domain });
}

/** Record references ([object slug, record id]) found in API payloads: attribute values, task links, note and entry parents. */
export function collectRefs(payload) {
  const refs = [];
  const stack = [[payload, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node === null || typeof node !== "object" || depth > 12) continue;
    if (typeof node.target_record_id === "string") {
      const slug = typeof node.target_object === "string" ? objectOfId(node.target_object)?.api_slug : objectOfId(node.target_object_id)?.api_slug;
      if (slug) refs.push([slug, node.target_record_id]);
    }
    if (typeof node.parent_record_id === "string" && typeof node.parent_object === "string") refs.push([node.parent_object, node.parent_record_id]);
    for (const child of Array.isArray(node) ? node : Object.values(node)) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
  }
  return refs;
}

/** Resolve names the capped index does not hold, in batches of 100 ids per object (the filter's "$in" limit). */
export async function resolveNames(payload) {
  await loadNames();
  if (store.namesPartial.size === 0) return;
  const missing = new Map();
  for (const [slug, id] of collectRefs(payload)) {
    if (!store.namesPartial.has(slug) || store.names.has(id) || store.namesMissing.has(id)) continue;
    if (!missing.has(slug)) missing.set(slug, new Set());
    missing.get(slug).add(id);
  }
  for (const [slug, idSet] of missing) {
    const ids = [...idSet];
    for (let start = 0; start < ids.length; start += 100) {
      const batch = ids.slice(start, start + 100);
      const found = (await call("records.query", { object: slug, filter: { record_id: { $in: batch } }, limit: 100 })).data;
      for (const record of found) rememberName(slug, record);
      for (const id of batch) if (!store.names.has(id)) store.namesMissing.add(id);
    }
  }
}

export const refName = (id) => store.names.get(id)?.name ?? "Unknown record";
export const objectOfId = (objectIdOrSlug) => store.objectsBySlug.get(objectIdOrSlug) ?? store.objectsById.get(objectIdOrSlug);

// ------------------------------------------------------------------------------------------------------------
// Formatting in UTC (the world's clock), never the browser's zone or clock.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDate(value) {
  const ms = parseTime(value);
  if (ms === undefined) return value ?? "";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
export function formatDateTime(value) {
  const ms = parseTime(value);
  if (ms === undefined) return value ?? "";
  const d = new Date(ms);
  const h = d.getUTCHours();
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${formatDate(value)} ${hour}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
export function relative(value) {
  const ms = parseTime(value);
  if (ms === undefined || store.nowMs === undefined) return formatDate(value);
  const days = Math.round((store.nowMs - ms) / 86_400_000);
  if (Math.abs(store.nowMs - ms) < 3_600_000) return "Just now";
  if (days === 0) return store.nowMs >= ms ? `${Math.max(1, Math.round((store.nowMs - ms) / 3_600_000))} hours ago` : "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 30) return `${days} days ago`;
  return formatDate(value);
}
export function formatCurrency(amount, code = "USD") {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code || "USD", maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${code}`;
  }
}
