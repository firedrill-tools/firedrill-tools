// The customer entry form (Lists → Relationships → Customers → New / Edit), rendered in NetSuite's
// record-dialog style. Writes go through customer.create / customer.update with an idempotency key.
import { call, el, newKey, toast, describe, ToolError } from "../ui.js";
import { dialog } from "../overlay.js";
import { app, can, go } from "../store.js";

const TERMS = [["", "— None —"], ["1", "Net 15"], ["2", "Net 30"], ["3", "Due on receipt"]];

function field(id, label, control, { required = false } = {}) {
  return el("div", { class: "field" }, [
    el("label", { class: "fl", for: id }, [label, required ? el("span", { class: "req", text: "*" }) : null]),
    control,
  ]);
}

/** record === null → New Customer; otherwise Edit Customer. onSaved receives the record id. */
export function openCustomerForm(record, { subsidiaries = [], onSaved } = {}) {
  const editing = record !== null && record !== undefined;
  const values = {
    isPerson: editing ? record.isPerson === true : false,
    companyName: editing ? record.companyName ?? "" : "",
    firstName: editing ? record.firstName ?? "" : "",
    lastName: editing ? record.lastName ?? "" : "",
    email: editing ? record.email ?? "" : "",
    phone: editing ? record.phone ?? "" : "",
    subsidiary: editing ? record.subsidiary?.id ?? "" : "",
    terms: editing ? record.terms?.id ?? "" : "",
    creditLimit: editing ? (record.creditLimit ?? "") : "",
    comments: editing ? record.comments ?? "" : "",
  };
  const controls = {};
  const make = (name, type = "text") => {
    const id = `cust-${name}`;
    const node = type === "textarea"
      ? el("textarea", { id, value: values[name] })
      : el("input", { type, id, value: String(values[name] ?? "") });
    node.addEventListener("input", () => { app.dirty = true; });
    controls[name] = node;
    return node;
  };
  const personBox = el("input", { type: "checkbox", id: "cust-isPerson", checked: values.isPerson });
  const subsidiarySelect = el("select", { id: "cust-subsidiary" }, [
    el("option", { value: "", text: subsidiaries.length ? "— Select —" : "Account default" }),
    ...subsidiaries.map((s) => el("option", { value: s.id, text: s.name, selected: s.id === values.subsidiary })),
  ]);
  const termsSelect = el("select", { id: "cust-terms" },
    TERMS.map(([id, label]) => el("option", { value: id, text: label, selected: id === values.terms })));
  const errorHost = el("div", {});

  const nameBlock = el("div", { class: "formgrid" }, [
    el("div", { class: "field inline" }, [personBox, el("label", { class: "fl", for: "cust-isPerson", text: "Individual" })]),
    field("cust-companyName", "Company Name", make("companyName"), { required: true }),
    field("cust-firstName", "First Name", make("firstName")),
    field("cust-lastName", "Last Name", make("lastName")),
  ]);
  const contactBlock = el("div", { class: "formgrid" }, [
    field("cust-email", "Email", make("email", "email")),
    field("cust-phone", "Phone", make("phone", "tel")),
    field("cust-subsidiary", "Subsidiary", subsidiarySelect, { required: !editing }),
    field("cust-terms", "Terms", termsSelect),
    field("cust-creditLimit", "Credit Limit", make("creditLimit", "number")),
  ]);
  const commentBlock = field("cust-comments", "Comments", make("comments", "textarea"));

  let saving = false;
  let key = newKey();

  function body() {
    const person = personBox.checked;
    controls.companyName.closest(".field").hidden = false;
    controls.firstName.closest(".field").hidden = !person;
    controls.lastName.closest(".field").hidden = !person;
    const payload = {};
    const put = (name, value) => { if (value !== "" && value !== undefined) payload[name] = value; };
    payload.isPerson = person;
    put("companyName", controls.companyName.value.trim());
    if (person) {
      put("firstName", controls.firstName.value.trim());
      put("lastName", controls.lastName.value.trim());
    }
    put("email", controls.email.value.trim());
    put("phone", controls.phone.value.trim());
    put("comments", controls.comments.value.trim());
    const limit = controls.creditLimit.value.trim();
    if (limit !== "") payload.creditLimit = Number(limit);
    if (subsidiarySelect.value !== "") payload.subsidiary = { id: subsidiarySelect.value };
    if (termsSelect.value !== "") payload.terms = { id: termsSelect.value };
    return payload;
  }

  personBox.addEventListener("change", () => {
    controls.firstName.closest(".field").hidden = !personBox.checked;
    controls.lastName.closest(".field").hidden = !personBox.checked;
  });
  controls.firstName.closest(".field").hidden = !values.isPerson;
  controls.lastName.closest(".field").hidden = !values.isPerson;

  if (subsidiaries.length === 0 && can("LIST_SUBSIDIARY")) {
    call("subsidiary.list", { limit: 50, offset: 0 })
      .then((page) => {
        for (const item of page.items ?? []) {
          subsidiarySelect.append(el("option", { value: item.id, text: item.name, selected: item.id === values.subsidiary }));
        }
        subsidiarySelect.querySelector("option").textContent = "— Select —";
      })
      .catch(() => { /* the select keeps the account default */ });
  }

  const box = dialog({
    title: editing ? `Edit Customer — ${record.entityId ?? record.id}` : "New Customer",
    wide: true,
    body: [errorHost, nameBlock, contactBlock, commentBlock,
      el("p", { class: "muted", text: "Address book entries are seeded by the world and are not editable in this Tool." })],
    actions: [
      { label: "Cancel", run: (close) => { app.dirty = false; close(); } },
      {
        label: "Save",
        kind: "primary",
        run: async (close) => {
          if (saving) return;
          saving = true;
          errorHost.replaceChildren();
          try {
            const payload = body();
            const result = editing
              ? await call("customer.update", { recordId: record.id, body: payload }, key)
              : await call("customer.create", { body: payload }, key);
            app.dirty = false;
            toast(editing ? "Customer saved." : `Customer created (internal id ${result.id}).`);
            close();
            if (onSaved) await onSaved(result.id);
            else go(`#/customers/${encodeURIComponent(result.id)}`);
          } catch (error) {
            key = newKey();
            const path = error instanceof ToolError ? error.details?.errorPath : undefined;
            errorHost.replaceChildren(el("div", { class: "banner error", role: "alert" }, [
              el("div", {}, [
                el("div", { class: "banner-title", text: editing ? "The customer could not be saved" : "The customer could not be created" }),
                el("div", { class: "banner-detail", text: describe(error) }),
              ]),
            ]));
            if (path && controls[path]) controls[path].focus();
          } finally {
            saving = false;
          }
        },
      },
    ],
    onClose: () => { app.dirty = false; },
  });
  return box;
}
