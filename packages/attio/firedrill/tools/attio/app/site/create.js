// "New record" modal: the object's writable scalar attributes, submitted once with an idempotency key.
import { icon, typeIcon } from "./icons.js";
import { choices } from "./store.js";
import { action, button, call, describe, el, newKey, openModal } from "./ui.js";
import { objectBadge } from "./values.js";

const SCALAR = new Set(["text", "number", "email-address", "domain", "phone-number", "currency", "date", "select", "status", "personal-name", "checkbox"]);

function inputFor(def, id) {
  if (def.type === "select" || def.type === "status") {
    const select = el("select", { class: "at-select", attrs: { id } });
    select.append(el("option", { text: "Select an option", attrs: { value: "" } }));
    return select;
  }
  if (def.type === "checkbox") return el("input", { class: "at-cb", attrs: { id, type: "checkbox" } });
  const type = def.type === "number" || def.type === "currency" ? "number" : def.type === "date" ? "date" : def.type === "email-address" ? "email" : "text";
  return el("input", { class: "at-input", attrs: { id, type, step: type === "number" ? "any" : undefined, placeholder: def.type === "personal-name" ? "First Last" : `Set ${def.title}…` } });
}

function readValue(def, control) {
  if (def.type === "checkbox") return control.checked ? [true] : undefined;
  const raw = control.value.trim();
  if (raw === "") return undefined;
  if (def.type === "number" || def.type === "currency") return [Number(raw)];
  if (def.type === "personal-name") {
    const [first, ...rest] = raw.split(/\s+/);
    return [{ first_name: first, last_name: rest.join(" "), full_name: raw }];
  }
  return [raw];
}

/** Opens the modal; resolves after close. `onCreated(record)` runs after a successful create. */
export function openCreateRecord(object, defs, onCreated) {
  const fields = defs.filter((d) => d.is_writable && !d.is_archived && SCALAR.has(d.type) && (!d.is_multiselect || ["email-address", "domain", "phone-number"].includes(d.type)));
  fields.sort((a, b) => Number(b.is_required) - Number(a.is_required));
  let dirty = false;
  const promise = openModal({
    title: `Create ${object.singular_noun}`,
    iconElement: objectBadge(object.api_slug),
    render(body, foot, close) {
      const form = el("form", { class: "at-editor-form", attrs: { id: "create-record-form" } });
      const controls = new Map();
      fields.forEach((def, index) => {
        const id = `create-field-${index}`;
        const control = inputFor(def, id);
        control.addEventListener("input", () => { dirty = true; });
        if (def.type === "select" || def.type === "status") {
          choices("objects", object.api_slug, def).then((items) => {
            for (const item of items) control.append(el("option", { text: item.title, attrs: { value: item.title } }));
          }, () => undefined);
        }
        controls.set(def, control);
        const label = el("label", { attrs: { for: id } }, [icon(typeIcon(def.type)), el("span", { text: def.title }), def.is_required ? el("span", { class: "at-req", text: "*" }) : null]);
        form.append(el("div", { class: "at-form-row" }, [label, control]));
      });
      const error = el("div", { class: "at-banner", attrs: { role: "alert" } });
      error.hidden = true;
      body.append(error, form);
      const createMore = el("input", { class: "at-cb", attrs: { type: "checkbox", id: "create-more" } });
      const submit = button(`Create record`, { class: "primary" });
      submit.type = "submit";
      submit.setAttribute("form", "create-record-form");
      foot.append(el("label", { class: "at-hint", attrs: { for: "create-more" } }, [createMore, " Create more"]), el("span", { class: "grow" }), button("Cancel", { onClick: close }), submit);
      foot.style.justifyContent = "flex-start";
      const key = { value: newKey() };
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = {};
        for (const [def, control] of controls) {
          const v = readValue(def, control);
          if (v !== undefined) values[def.api_slug] = v;
        }
        submit.disabled = true;
        void action(async () => {
          const created = await call("records.create", { object: object.api_slug, data: { values } }, key.value);
          dirty = false;
          onCreated(created.data, createMore.checked);
          if (createMore.checked) {
            form.reset();
            key.value = newKey();
            error.hidden = true;
          } else close();
        }, {
          onError: (err) => {
            error.hidden = false;
            error.textContent = describe(err);
          },
        }).finally(() => { submit.disabled = false; });
      });
    },
  });
  return { promise, unsaved: () => dirty };
}
