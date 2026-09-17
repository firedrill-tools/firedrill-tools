// Controls that belong to the real Sheets chrome but sit outside this Tool's scope render in place with the product's
// glyphs, hover states and tooltips; activating one opens this short panel instead of pretending to work.
import { icon } from "./icons.js";
import { button, el, openModal } from "./ui.js";

/** Open the "not simulated" panel for `feature` (a product name such as "Undo"), with an optional one-line detail. */
export function notSimulated(feature, detail) {
  const body = el("div", { class: "unsupported" }, [
    el("div", { class: "unsupported-icon" }, [icon("info")]),
    el("div", { class: "unsupported-text" }, [
      el("p", { text: `${feature} is not simulated by this Tool.` }),
      el("p", { class: "unsupported-detail", text: detail ?? "The control is shown so the screen matches Google Sheets. Nothing was changed, and no request was sent." }),
    ]),
  ]);
  const modal = openModal({
    title: feature,
    body,
    className: "unsupported-dialog",
    actions: [button("OK", { className: "filled-btn", onClick: () => modal.close() })],
  });
  return modal;
}

/** Menu items that open the panel, from [label, icon?, shortcut?] tuples. */
export function unsupportedItems(entries) {
  return entries.map((entry) => {
    if (entry === "divider") return entry;
    const [label, iconName, shortcut] = entry;
    return { label, icon: iconName, shortcut, onSelect: () => notSimulated(label) };
  });
}

/** A menu row with a submenu whose every entry opens the panel, as for "Paste special". */
export function unsupportedSubmenu(label, iconName, children, extra = {}) {
  return { label, icon: iconName, ...extra, submenu: () => unsupportedItems(children.map((child) => (child === "divider" ? child : Array.isArray(child) ? child : [child]))) };
}
