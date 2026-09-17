// Editor step 3 "Add Fields": recipient selector, field palette, click-to-place on the page and per-field removal.
import { icon } from "./icons.js";
import { defaultSize, FIELD_LABEL, recipientColor } from "./pages.js";
import { call, describe, el, newKey, run, toast } from "./ui.js";

const PALETTE = [["SIGNATURE", "signature"], ["INITIALS", "contact"], ["EMAIL", "atSign"], ["NAME", "user"], ["DATE", "calendar"], ["TEXT", "type"], ["NUMBER", "hash"], ["RADIO", "circleDot"], ["CHECKBOX", "checkSquare"], ["DROPDOWN", "listDropdown"]];
const SUPPORTED = new Set(["SIGNATURE", "INITIALS", "EMAIL", "NAME", "DATE", "TEXT", "CHECKBOX"]);

const eligible = (doc) => doc.recipients.filter((r) => r.role !== "CC" && r.role !== "VIEWER" && r.signingStatus === "NOT_SIGNED");

export function stepFields(ctx) {
  const { doc } = ctx;
  const people = eligible(doc);
  if (!people.some((r) => r.id === ctx.recipientId)) ctx.recipientId = people[0]?.id ?? null;
  const body = el("div", { class: "flow-fields" });
  if (people.length === 0) {
    body.append(el("div", { class: "alert alert-warning", text: "Add at least one signer or approver in the previous step before placing fields." }));
  } else {
    const who = el("select", { class: "input", attrs: { id: "field-recipient" } }, people.map((r) => el("option", { text: r.name ? `${r.name} (${r.email})` : r.email, attrs: { value: r.id, selected: r.id === ctx.recipientId } })));
    who.addEventListener("change", () => { ctx.recipientId = Number(who.value); ctx.draw(); });
    const color = recipientColor(doc.recipients, ctx.recipientId);
    const grid = el("div", { class: `field-palette field-${color}` });
    for (const [type, iconName] of PALETTE) {
      const supported = SUPPORTED.has(type);
      const tile = el("button", { class: `palette-tile ${ctx.placing === type ? "is-selected" : ""} ${type === "SIGNATURE" || type === "INITIALS" ? "is-script" : ""}`, title: supported ? `Place a ${FIELD_LABEL[type]} field` : "Not simulated by this Tool",
        attrs: { type: "button", disabled: !supported, "aria-pressed": ctx.placing === type } }, [icon(iconName), el("span", { text: FIELD_LABEL[type] })]);
      tile.addEventListener("click", () => { ctx.placing = ctx.placing === type ? null : type; ctx.draw(); });
      grid.append(tile);
    }
    body.append(
      el("div", { class: "form-row" }, [el("label", { class: "label", text: "Recipient", attrs: { for: "field-recipient" } }), who]),
      grid,
      el("p", { class: "hint", text: ctx.placing ? `Click on the document to place the ${FIELD_LABEL[ctx.placing]} field.` : "Select a field, then click on the document to place it." }),
    );
    const missing = doc.recipients.filter((r) => r.role === "SIGNER" && !doc.fields.some((f) => f.recipientId === r.id && f.type === "SIGNATURE"));
    if (missing.length) body.append(el("div", { class: "alert alert-warning", text: `Signers without a signature field: ${missing.map((r) => r.email).join(", ")}` }));
  }
  return { title: "Add Fields", description: "Add all relevant fields for each recipient.", body, async onContinue() { ctx.placing = null; } };
}

export function fieldViewerOptions(ctx) {
  return {
    placing: Boolean(ctx.placing && ctx.recipientId),
    onPlace: (page, x, y) => {
      if (!ctx.placing || !ctx.recipientId) return;
      const size = defaultSize(ctx.placing);
      const pageX = Math.round(Math.max(0, Math.min(100 - size.width, x - size.width / 2)) * 100) / 100;
      const pageY = Math.round(Math.max(0, Math.min(100 - size.height, y - size.height / 2)) * 100) / 100;
      const type = ctx.placing;
      void run(async () => {
        await call("fields.create_many", { documentId: ctx.doc.id, fields: [{ recipientId: ctx.recipientId, type, pageNumber: page, pageX, pageY, ...size }] }, newKey());
        await ctx.reload();
      });
    },
    fieldNode: (f) => {
      if (f.inserted) return [];
      const remove = el("button", { class: "field-remove", attrs: { type: "button", "aria-label": `Remove ${FIELD_LABEL[f.type]} field`, title: "Remove field" } }, icon("x"));
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void run(async () => {
          await call("fields.delete", { fieldId: f.id }, newKey());
          await ctx.reload();
        }, { onError: (e) => toast(describe(e), { variant: "destructive", title: "Could not remove field" }) });
      });
      return [remove];
    },
  };
}
