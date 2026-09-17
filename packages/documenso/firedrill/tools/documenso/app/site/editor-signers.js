// Editor step 2 "Add Signers": recipient rows diffed into recipients.create_many / update / delete and the signing order.
import { icon } from "./icons.js";
import { button, call, el, newKey } from "./ui.js";

const ROLES = [["SIGNER", "Needs to sign"], ["APPROVER", "Needs to approve"], ["VIEWER", "Needs to view"], ["CC", "Receives copy"]];

export function stepSigners(ctx) {
  const { doc, ws } = ctx;
  const sequential = el("input", { attrs: { type: "checkbox", id: "signing-order", checked: doc.documentMeta.signingOrder === "SEQUENTIAL" } });
  const list = el("div", { class: "signer-list" });
  const rows = [];
  let seq = 0;

  function addRow(r = { email: "", name: "", role: "SIGNER", signingOrder: null }) {
    seq += 1;
    const n = seq;
    const order = el("input", { class: "input signer-order", attrs: { id: `signer-order-${n}`, type: "number", min: 1, max: 1000, value: r.signingOrder ?? rows.length + 1, "aria-label": "Signing order" } });
    const email = el("input", { class: "input", attrs: { id: `signer-email-${n}`, type: "email", placeholder: "Email", value: r.email, "aria-label": "Email", maxlength: 254 } });
    const name = el("input", { class: "input", attrs: { id: `signer-name-${n}`, placeholder: "Name", value: r.name, "aria-label": "Name", maxlength: 255 } });
    const role = el("select", { class: "input signer-role", attrs: { id: `signer-role-${n}`, "aria-label": "Role" } }, ROLES.map(([v, label]) => el("option", { text: label, attrs: { value: v, selected: v === r.role } })));
    const locked = r.id !== undefined && r.signingStatus !== undefined && r.signingStatus !== "NOT_SIGNED";
    const row = { original: r.id === undefined ? null : r, email, name, role, order, node: null };
    const remove = el("button", { class: "btn btn-ghost btn-icon", attrs: { type: "button", "aria-label": "Remove signer", title: "Remove signer", disabled: locked } }, icon("trash"));
    remove.addEventListener("click", () => { rows.splice(rows.indexOf(row), 1); row.node.remove(); ctx.dirty = true; });
    row.node = el("div", { class: "signer-row" }, [order, el("div", { class: "signer-main" }, [email, name]), role, remove]);
    rows.push(row);
    list.append(row.node);
    syncOrder();
  }
  const syncOrder = () => list.classList.toggle("is-sequential", sequential.checked);
  sequential.addEventListener("change", () => { ctx.dirty = true; syncOrder(); });

  for (const r of doc.recipients) addRow(r);
  if (doc.recipients.length === 0) addRow();

  const body = el("div", { class: "flow-fields" }, [
    el("label", { class: "check", attrs: { for: "signing-order" } }, [sequential, el("span", { text: "Enable signing order" })]),
    list,
    el("div", { class: "signer-add" }, [
      button("Add Signer", { variant: "outline", iconName: "plus", onClick: () => { addRow(); ctx.dirty = true; } }),
      button("Add myself", { variant: "outline", iconName: "user", disabled: doc.recipients.some((r) => r.email === ws.user.email), onClick: () => { addRow({ email: ws.user.email, name: ws.user.name, role: "SIGNER", signingOrder: null }); ctx.dirty = true; } }),
    ]),
  ]);
  body.addEventListener("input", () => { ctx.dirty = true; });
  const keys = { create: newKey(), order: newKey(), updates: new Map(), deletes: new Map() };
  const keyFor = (map, id) => { if (!map.has(id)) map.set(id, newKey()); return map.get(id); };

  return {
    title: "Add Signers", description: "Add the people who will sign the document.", body,
    async onContinue() {
      const filled = rows.filter((row) => row.email.value.trim() || row.name.value.trim() || row.original);
      const orderOf = (row) => (sequential.checked ? Number(row.order.value) || null : null);
      const wantedIds = new Set(filled.filter((row) => row.original).map((row) => row.original.id));
      for (const r of doc.recipients) if (!wantedIds.has(r.id)) await call("recipients.delete", { recipientId: r.id }, keyFor(keys.deletes, r.id));
      const mode = sequential.checked ? "SEQUENTIAL" : "PARALLEL";
      if (mode !== doc.documentMeta.signingOrder) await call("documents.update", { documentId: doc.id, meta: { signingOrder: mode } }, keys.order);
      for (const row of filled.filter((x) => x.original)) {
        const r = row.original;
        const change = {};
        if (row.email.value.trim() !== r.email) change.email = row.email.value.trim();
        if (row.name.value.trim() !== r.name) change.name = row.name.value.trim();
        if (row.role.value !== r.role) change.role = row.role.value;
        if (orderOf(row) !== r.signingOrder) change.signingOrder = orderOf(row);
        if (Object.keys(change).length) await call("recipients.update", { documentId: doc.id, recipient: { id: r.id, ...change } }, keyFor(keys.updates, `${r.id}:${JSON.stringify(change)}`));
      }
      const fresh = filled.filter((x) => !x.original).map((row) => ({ email: row.email.value.trim(), name: row.name.value.trim(), role: row.role.value, signingOrder: orderOf(row) }));
      if (fresh.length) await call("recipients.create_many", { documentId: doc.id, recipients: fresh }, keys.create);
    },
  };
}
