// Attribute value rendering (cells, detail rows, cards) and the per-type inline editor popover.
import { icon } from "./icons.js";
import { choices, formatCurrency, formatDate, formatDateTime, memberName, objectMeta, refName, store } from "./store.js";
import { button, call, closePopover, el, popover, toast, describe } from "./ui.js";

const TAG_COLORS = ["grey", "blue", "green", "yellow", "orange", "red", "pink", "purple"];
function hash(text) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
export const tagColor = (seed) => TAG_COLORS[hash(seed) % TAG_COLORS.length];

export function tag(title, seed, extra = "") {
  return el("span", { class: `at-tag ${tagColor(seed ?? title)} ${extra}`.trim(), text: title, title });
}

const AVATAR = ["#fde2cf", "#dbe8fe", "#d9f2e3", "#f4defa", "#fdf0c4", "#fbdada", "#dff3f6", "#e7e2fb"];
const AVATAR_TEXT = ["#9a4a13", "#1f52b8", "#166b41", "#7d3197", "#7d5d00", "#a12c2c", "#12677a", "#5334b3"];
export function avatar(name, seed, { size = "", square = false } = {}) {
  const i = hash(seed ?? name) % AVATAR.length;
  const initials = String(name ?? "?").trim().split(/\s+/).map((part) => part.charAt(0)).join("").slice(0, square ? 1 : 2).toUpperCase() || "?";
  const node = el("span", { class: `at-avatar ${size} ${square ? "square" : ""}`.trim(), text: initials, attrs: { "aria-hidden": "true" } });
  node.style.background = AVATAR[i];
  node.style.color = AVATAR_TEXT[i];
  return node;
}

export function objectBadge(slug, size = "") {
  const meta = objectMeta(slug);
  const node = el("span", { class: `at-object-badge ${size}`.trim(), attrs: { "aria-hidden": "true" } }, icon(meta.icon, "", size === "large" ? 20 : 12));
  node.style.background = meta.color;
  return node;
}

export function recordAvatar(slug, name, id, size = "") {
  return slug === "companies" ? avatar(name, id, { size, square: true }) : slug === "deals" ? objectBadge("deals", size) : avatar(name, id, { size });
}

export function refChip(targetObject, targetId, navigate = true) {
  const name = refName(targetId);
  const chip = el(navigate ? "a" : "span", { class: "at-ref", title: name, attrs: navigate ? { href: `#/${targetObject}/${targetId}` } : {} }, [recordAvatar(targetObject, name, targetId, "tiny"), el("span", { text: name })]);
  return chip;
}

export function actorChip(id) {
  const name = memberName(id);
  return el("span", { class: "at-actor", title: name }, [avatar(name, id, { size: "tiny" }), el("span", { text: name })]);
}

/** Render one attribute's values. `mode` is "cell", "detail" or "card". */
export function renderValues(def, values, mode = "cell") {
  const box = el("span", { class: `at-values ${mode}` });
  if (!values || values.length === 0) {
    if (mode !== "cell") box.append(el("span", { class: "at-empty-value", text: def.is_writable ? "Set value…" : "No value" }));
    return box;
  }
  for (const v of values) {
    switch (def.type) {
      case "personal-name": box.append(el("span", { class: "at-text", text: v.full_name })); break;
      case "text": box.append(el("span", { class: "at-text", text: v.value })); break;
      case "number": box.append(el("span", { class: "at-num", text: Number(v.value).toLocaleString("en-US") })); break;
      case "checkbox": box.append(el("span", { class: `at-check ${v.value ? "on" : ""}`, attrs: { role: "img", "aria-label": v.value ? "Checked" : "Unchecked" } }, v.value ? icon("check", "", 12) : null)); break;
      case "currency": box.append(el("span", { class: "at-num", text: formatCurrency(v.currency_value, v.currency_code) })); break;
      case "date": box.append(el("span", { class: "at-text", text: formatDate(v.value) })); break;
      case "timestamp": box.append(el("span", { class: "at-text", text: formatDateTime(v.value) })); break;
      case "select": box.append(tag(v.option.title, v.option.id.option_id, v.option.is_archived ? "archived" : "")); break;
      case "status": box.append(tag(v.status.title, v.status.id.status_id)); break;
      case "record-reference": box.append(refChip(v.target_object, v.target_record_id, mode !== "cell")); break;
      case "actor-reference": box.append(actorChip(v.referenced_actor_id)); break;
      case "domain": box.append(el("span", { class: "at-domain" }, [icon("globe", "", 12), el("span", { text: v.domain })])); break;
      case "email-address": box.append(el("span", { class: "at-link-text", text: v.email_address })); break;
      case "phone-number": box.append(el("span", { class: "at-text", text: v.original_phone_number || v.phone_number })); break;
      default: box.append(el("span", { class: "at-text", text: JSON.stringify(v) }));
    }
  }
  return box;
}

/** The value a write request accepts for one stored value (used to resend kept values of multiselects). */
export function writeFormOf(def, v) {
  switch (def.type) {
    case "email-address": return v.email_address;
    case "domain": return v.domain;
    case "phone-number": return v.phone_number;
    case "record-reference": return { target_object: v.target_object, target_record_id: v.target_record_id };
    case "actor-reference": return { referenced_actor_type: v.referenced_actor_type, referenced_actor_id: v.referenced_actor_id };
    case "select": return v.option.title;
    case "status": return v.status.title;
    case "currency": return v.currency_value;
    case "personal-name": return { first_name: v.first_name, last_name: v.last_name, full_name: v.full_name };
    default: return v.value;
  }
}

const TEXTUAL = new Set(["text", "number", "email-address", "domain", "phone-number"]);

/**
 * Inline editor anchored to `anchor`. `ctx` = { target: "objects"|"lists", slug, def, values, save(writeValue) }.
 * `save` receives the attribute's complete new value list (overwrite semantics) and returns a promise.
 */
export function editValue(anchor, ctx) {
  const { def } = ctx;
  if (!def.is_writable) return;
  const body = el("div", { class: "at-editor" });
  const head = el("div", { class: "at-editor-head", text: def.title });
  body.append(head);
  const error = el("div", { class: "at-field-error", attrs: { role: "alert" } });
  const commit = async (value, keepOpen = false) => {
    error.textContent = "";
    body.toggleAttribute("aria-busy", true);
    try {
      await ctx.save(value);
      if (!keepOpen) closePopover();
    } catch (err) {
      error.textContent = describe(err);
    } finally {
      body.toggleAttribute("aria-busy", false);
    }
  };
  const current = (ctx.values ?? []).map((v) => writeFormOf(def, v));

  if (def.type === "checkbox") {
    void commit(!(ctx.values?.[0]?.value === true));
    return;
  }
  if (TEXTUAL.has(def.type) && !def.is_multiselect) body.append(textForm(def, current[0], (v) => commit(v === "" ? [] : [v])));
  else if (TEXTUAL.has(def.type)) body.append(multiTextForm(def, ctx.values ?? [], current, commit));
  else if (def.type === "personal-name") body.append(nameForm(ctx.values?.[0], commit));
  else if (def.type === "currency") body.append(textForm({ ...def, type: "number" }, current[0], (v) => commit(v === "" ? [] : [Number(v)])));
  else if (def.type === "date") body.append(textForm(def, ctx.values?.[0]?.value, (v) => commit(v === "" ? [] : [v]), "date"));
  else if (def.type === "timestamp") body.append(textForm(def, ctx.values?.[0]?.value?.slice(0, 16), (v) => commit(v === "" ? [] : [`${v}:00Z`]), "datetime-local"));
  else if (def.type === "select" || def.type === "status") body.append(choiceForm(ctx, current, commit));
  else if (def.type === "actor-reference") body.append(memberForm(def, current, commit));
  else if (def.type === "record-reference") body.append(referenceForm(def, ctx.values ?? [], commit));
  body.append(error);
  popover(anchor, body, { width: 300 });
}

function textForm(def, value, onSubmit, type) {
  const form = el("form", { class: "at-editor-form" });
  const inputType = type ?? (def.type === "number" ? "number" : def.type === "email-address" ? "email" : "text");
  const input = el("input", { class: "at-input", attrs: { type: inputType, "aria-label": def.title, step: inputType === "number" ? "any" : undefined } });
  input.value = value ?? "";
  form.append(input, el("div", { class: "at-editor-actions" }, [el("span", { class: "at-hint", text: type === "datetime-local" ? "UTC · Enter to save" : "Enter to save" }), button("Save", { class: "primary small" })]));
  form.querySelector("button").type = "submit";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void onSubmit(input.value.trim());
  });
  return form;
}

function multiTextForm(def, stored, current, commit) {
  const wrap = el("div", { class: "at-editor-multi" });
  stored.forEach((v, index) => {
    const row = el("div", { class: "at-editor-row" }, [renderValues(def, [v], "detail")]);
    const remove = el("button", { class: "at-icon-btn small", title: "Remove", attrs: { type: "button", "aria-label": `Remove ${current[index]}` } }, icon("x"));
    remove.addEventListener("click", () => void commit(current.filter((_, i) => i !== index)));
    row.append(remove);
    wrap.append(row);
  });
  wrap.append(textForm({ ...def, title: `Add ${def.title.toLowerCase()}` }, "", (v) => (v === "" ? undefined : commit([...current, v]))));
  return wrap;
}

function nameForm(value, commit) {
  const form = el("form", { class: "at-editor-form" });
  const first = el("input", { class: "at-input", attrs: { type: "text", "aria-label": "First name", placeholder: "First name" } });
  const last = el("input", { class: "at-input", attrs: { type: "text", "aria-label": "Last name", placeholder: "Last name" } });
  first.value = value?.first_name ?? "";
  last.value = value?.last_name ?? "";
  const save = button("Save", { class: "primary small" });
  save.type = "submit";
  form.append(first, last, el("div", { class: "at-editor-actions" }, [el("span", { class: "at-hint", text: "Enter to save" }), save]));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = first.value.trim();
    const l = last.value.trim();
    void commit(f || l ? [{ first_name: f, last_name: l, full_name: `${f} ${l}`.trim() }] : []);
  });
  return form;
}

function optionList(items, render) {
  const list = el("div", { class: "at-option-list", attrs: { role: "listbox" } });
  for (const item of items) list.append(render(item));
  return list;
}

function choiceForm(ctx, current, commit) {
  const { def } = ctx;
  const wrap = el("div", {}, el("div", { class: "at-hint pad", text: "Loading options…" }));
  choices(ctx.target, ctx.slug, def).then((items) => {
    const selected = new Set(current);
    wrap.replaceChildren(optionList(items, (item) => {
      const id = item.id.option_id ?? item.id.status_id;
      const on = selected.has(item.title);
      const row = el("button", { class: `at-option${on ? " selected" : ""}`, attrs: { type: "button", role: "option", "aria-selected": String(on) } }, [tag(item.title, id), on ? icon("check", "at-option-check") : null]);
      row.addEventListener("click", () => {
        if (def.is_multiselect) void commit(on ? current.filter((t) => t !== item.title) : [...current, item.title]);
        else void commit(on ? [] : [item.title]);
      });
      return row;
    }));
    if (current.length > 0 && !def.is_required) wrap.append(button("Clear", { class: "small ghost", onClick: () => void commit([]) }));
    wrap.querySelector("button")?.focus();
  }, (error) => wrap.replaceChildren(el("div", { class: "at-field-error", text: describe(error) })));
  return wrap;
}

function memberForm(def, current, commit) {
  const ids = new Set(current.map((c) => c.referenced_actor_id));
  return optionList(store.members.filter((m) => m.access_level !== "suspended" || ids.has(m.id.workspace_member_id)), (m) => {
    const id = m.id.workspace_member_id;
    const on = ids.has(id);
    const name = `${m.first_name} ${m.last_name}`;
    const row = el("button", { class: `at-option${on ? " selected" : ""}`, attrs: { type: "button", role: "option", "aria-selected": String(on) } }, [avatar(name, id, { size: "tiny" }), el("span", { text: name }), on ? icon("check", "at-option-check") : null]);
    const ref = { referenced_actor_type: "workspace-member", referenced_actor_id: id };
    row.addEventListener("click", () => {
      if (def.is_multiselect) void commit(on ? current.filter((c) => c.referenced_actor_id !== id) : [...current, ref]);
      else void commit(on && !def.is_required ? [] : [ref]);
    });
    return row;
  });
}

/** Record search picker used by reference editors, list "Add record" and task/note linking. */
export function recordPicker({ objects, placeholder = "Search records…", onPick, exclude = new Set() }) {
  const wrap = el("div", { class: "at-picker" });
  const input = el("input", { class: "at-input", attrs: { type: "search", placeholder, "aria-label": placeholder } });
  const results = el("div", { class: "at-option-list", attrs: { role: "listbox" } });
  wrap.append(input, results);
  let seq = 0;
  const run = async () => {
    const mine = ++seq;
    try {
      const hits = (await call("records.search", { query: input.value.trim(), objects, request_as: { type: "workspace" }, limit: 10 })).data;
      if (mine !== seq) return;
      results.replaceChildren();
      const shown = hits.filter((h) => !exclude.has(h.id.record_id));
      if (shown.length === 0) results.append(el("div", { class: "at-hint pad", text: "No records found" }));
      for (const hit of shown) {
        const row = el("button", { class: "at-option", attrs: { type: "button", role: "option" } }, [recordAvatar(hit.object_slug, hit.record_text, hit.id.record_id, "tiny"), el("span", { class: "at-option-main", text: hit.record_text }), el("span", { class: "at-option-sub", text: hit.email_addresses?.[0] ?? hit.domains?.[0] ?? store.objectsBySlug.get(hit.object_slug)?.singular_noun ?? "" })]);
        row.addEventListener("click", () => onPick(hit));
        results.append(row);
      }
    } catch (error) {
      if (mine === seq) results.replaceChildren(el("div", { class: "at-field-error", text: describe(error) }));
    }
  };
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 150);
  });
  void run();
  return wrap;
}

function referenceForm(def, stored, commit) {
  const current = stored.map((v) => writeFormOf(def, v));
  const wrap = el("div", { class: "at-editor-multi" });
  stored.forEach((v, index) => {
    const remove = el("button", { class: "at-icon-btn small", title: "Remove", attrs: { type: "button", "aria-label": `Remove ${refName(v.target_record_id)}` } }, icon("x"));
    remove.addEventListener("click", () => void commit(current.filter((_, i) => i !== index)));
    wrap.append(el("div", { class: "at-editor-row" }, [refChip(v.target_object, v.target_record_id, false), remove]));
  });
  const allowed = def.relationship ? [def.relationship.object] : store.objects.map((o) => o.api_slug);
  wrap.append(recordPicker({
    objects: allowed.filter((slug) => store.objectsBySlug.has(slug)),
    exclude: new Set(stored.map((v) => v.target_record_id)),
    onPick: (hit) => {
      const ref = { target_object: hit.object_slug, target_record_id: hit.id.record_id };
      void commit(def.is_multiselect ? [...current, ref] : [ref]);
    },
  }));
  return wrap;
}

export function toastSaved(title) {
  toast(`${title} updated`);
}
