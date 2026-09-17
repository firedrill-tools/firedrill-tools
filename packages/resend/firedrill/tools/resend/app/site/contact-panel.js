// Contact side panel: edit names and subscription, manage segment membership, delete. Resolves true when anything changed.
import { allSegments } from "./view-audience.js";
import { icon } from "./icons.js";
import { badge, button, call, confirmDialog, describe, el, errorState, field, formatDate, guard, modal, mutate, toast } from "./ui.js";

async function contactSegments(id) {
  const out = [];
  let after;
  for (let page = 0; page < 50; page += 1) {
    const list = await call("contacts.list_segments", { contactId: id, limit: 100, ...(after ? { after } : {}) });
    out.push(...list.data);
    if (!list.has_more || list.data.length === 0) break;
    after = list.data[list.data.length - 1].id;
  }
  return out;
}

export async function openContact(id) {
  let changed = false;
  let contact;
  let member = [];
  let segs = [];
  let loadError = null;
  try {
    [contact, member, segs] = await Promise.all([call("contacts.get", { id }), contactSegments(id), allSegments()]);
  } catch (error) {
    loadError = error;
  }
  await modal(loadError ? "Contact" : contact.email, (close) => {
    if (loadError) return [errorState(loadError), el("div", { class: "dialog-actions" }, [button("Close", { onClick: () => close() })])];
    const first = el("input", { class: "input", attrs: { id: "edit-first", autocomplete: "off" } });
    const last = el("input", { class: "input", attrs: { id: "edit-last", autocomplete: "off" } });
    first.value = contact.first_name ?? "";
    last.value = contact.last_name ?? "";
    const subscribed = el("input", { attrs: { id: "edit-subscribed", type: "checkbox" } });
    subscribed.checked = !contact.unsubscribed;
    const error = el("p", { class: "form-error", attrs: { role: "alert" } });
    const chips = el("div", { class: "chips" });
    const adder = el("select", { class: "select", attrs: { "aria-label": "Add to segment" } });
    const drawChips = () => {
      chips.replaceChildren(...(member.length ? member.map((s) => el("span", { class: "chip" }, [el("span", { text: s.name }), el("button", { class: "icon-btn copy", attrs: { type: "button", "aria-label": `Remove from ${s.name}`, title: `Remove from ${s.name}` }, on: { click: () => void membership("contacts.remove_segment", s) } }, [icon("x", 12)])])) : [el("span", { class: "muted", text: "Not in any segment" })]));
      const available = segs.filter((s) => !member.some((m) => m.id === s.id));
      adder.replaceChildren(el("option", { text: available.length ? "Add to segment…" : "No other segments", attrs: { value: "" } }), ...available.map((s) => el("option", { text: s.name, attrs: { value: s.id } })));
    };
    const membership = async (op, segment) => {
      error.textContent = "";
      try {
        await guard(() => mutate(op, { contactId: id, segmentId: segment.id }));
        changed = true;
        member = await contactSegments(id);
        drawChips();
      } catch (e) { error.textContent = describe(e); }
    };
    adder.addEventListener("change", () => { const s = segs.find((x) => x.id === adder.value); if (s) void membership("contacts.add_segment", s); });
    drawChips();
    const save = button("Save", { variant: "primary" });
    save.type = "submit";
    const del = button("Delete", { variant: "ghost", iconName: "trash", onClick: async () => {
      if (!(await confirmDialog("Delete contact", `Delete ${contact.email}? This removes the contact from every segment.`, "Delete contact"))) return;
      try { await guard(() => mutate("contacts.remove", { id })); changed = true; toast("Contact deleted"); close(); } catch (e) { error.textContent = describe(e); }
    } });
    const props = Object.entries(contact.properties ?? {});
    const form = el("form", {}, [
      el("div", { class: "panel-meta" }, [badge(contact.unsubscribed ? "unsubscribed" : "subscribed"), el("span", { class: "muted", text: `Added ${formatDate(contact.created_at)}` })]),
      el("div", { class: "two" }, [field("First name", first), field("Last name", last)]),
      el("label", { class: "check toggle", attrs: { for: "edit-subscribed" } }, [subscribed, el("span", { text: "Subscribed" })]),
      el("div", { class: "field" }, [el("span", { class: "label", text: "Segments" }), chips, adder]),
      props.length ? el("div", { class: "field" }, [el("span", { class: "label", text: "Properties" }), el("dl", { class: "props" }, props.flatMap(([k, v]) => [el("dt", { class: "mono", text: k }), el("dd", { text: v === null ? "—" : String(v) })]))]) : null,
      error,
      el("div", { class: "dialog-actions split" }, [del, el("span", { class: "spacer" }), button("Close", { onClick: () => close() }), save]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      error.textContent = "";
      try {
        await guard(() => mutate("contacts.update", { id, firstName: first.value.trim() || null, lastName: last.value.trim() || null, unsubscribed: !subscribed.checked }));
        changed = true;
        toast("Contact updated");
        close();
      } catch (e) { error.textContent = describe(e); save.disabled = false; }
    });
    return form;
  }, { wide: true });
  return changed;
}
