// Chrome that frames Drive but lies outside what this Tool simulates: the companion side panel, the Support and
// Settings menus, the Google apps launcher, Computers, Spam and similar entries. Every such control renders in place with
// its real glyph and tooltip and opens a short "not simulated by this Tool" panel; nothing here invents data.
import { icon } from "./icons.js";
import { $, closeModal, el, filledButton, openMenu, openModal } from "./ui.js";

/** A short explanation panel for a control whose feature is outside this Tool's model. */
export function notSimulated(feature, detail) {
  openModal({
    title: feature,
    className: "gd-dialog gd-modal gd-not-simulated",
    body: el("div", { class: "gd-ns-body" }, [
      icon("info", "gd-ns-icon"),
      el("div", {}, [
        el("p", { class: "gd-ns-lead", text: `${feature} is not simulated by this Tool.` }),
        el("p", { class: "gd-ns-text", text: detail ?? "This synthetic Drive models files, folders, sharing, trash and storage. This control is shown so the page matches Drive, but it has no state behind it here." }),
      ]),
    ]),
    actions: [filledButton("OK", { onClick: () => closeModal() })],
  });
}

const COMPANIONS = [
  { id: "calendar", label: "Calendar", logo: "./assets/google-calendar-2026.svg" },
  { id: "keep", label: "Keep", logo: "./assets/google-keep-2026.svg" },
  { id: "tasks", label: "Tasks", logo: "./assets/google-tasks-2026.svg" },
  { id: "contacts", label: "Contacts", logo: "./assets/google-contacts.svg" },
];

/** The collapsible companion rail at the right edge of Drive. */
export function mountSidePanel() {
  const rail = $("#side-panel");
  if (!rail) return;
  rail.replaceChildren();
  const list = el("div", { class: "gd-rail-apps" });
  for (const app of COMPANIONS) {
    const button = el("button", { class: "gd-rail-btn", attrs: { type: "button", "aria-label": app.label, title: app.label } }, [
      el("img", { attrs: { src: app.logo, alt: "", width: 20, height: 20 } }),
    ]);
    button.addEventListener("click", () => notSimulated(`Google ${app.label}`, `The Google ${app.label} side panel belongs to another Google product. This Tool simulates Drive only, so the panel has no content here.`));
    list.append(button);
  }
  list.append(el("div", { class: "gd-rail-divider", attrs: { role: "separator" } }));
  const addOns = el("button", { class: "gd-rail-btn", attrs: { type: "button", "aria-label": "Get add-ons", title: "Get add-ons" } }, [icon("add", "gd-rail-glyph")]);
  addOns.addEventListener("click", () => notSimulated("Get add-ons", "Workspace Marketplace add-ons are not part of this synthetic Drive."));
  list.append(addOns);
  const hide = el("button", { class: "gd-rail-btn gd-rail-hide", attrs: { type: "button", "aria-label": "Hide side panel", title: "Hide side panel", "aria-expanded": "true" } }, [icon("chevron_right", "gd-rail-glyph")]);
  hide.addEventListener("click", () => {
    const app = $("#app");
    const hidden = app.classList.toggle("is-rail-hidden");
    hide.setAttribute("aria-expanded", String(!hidden));
    hide.setAttribute("aria-label", hidden ? "Show side panel" : "Hide side panel");
    hide.title = hidden ? "Show side panel" : "Hide side panel";
    hide.replaceChildren(icon(hidden ? "chevron_left" : "chevron_right", "gd-rail-glyph"));
  });
  rail.append(list, hide);
}

/** Header Support menu (Help, Training, Updates, Send feedback) with the Tool note under Help. */
export function openSupportMenu(anchor, { onHelp }) {
  openMenu(anchor, [
    { label: "Help", icon: "help", onSelect: onHelp },
    { label: "Training", icon: "school", onSelect: () => notSimulated("Training", "Google Workspace training pages are not part of this synthetic Drive.") },
    { label: "Updates", icon: "new_releases", onSelect: () => notSimulated("Updates", "The Drive release notes are not part of this synthetic Drive.") },
    "divider",
    { label: "Send feedback to Google", icon: "feedback", onSelect: () => notSimulated("Send feedback to Google", "Feedback is never sent anywhere from this synthetic Drive.") },
  ], { align: "end" });
}

/** Header Settings menu. */
export function openSettingsMenu(anchor, { onKeyboard, extra = [] }) {
  openMenu(anchor, [
    { label: "Settings", icon: "settings", onSelect: () => notSimulated("Settings", "Drive settings (language, density, notifications, offline) are not modeled by this Tool.") },
    { label: "Get Drive for desktop", icon: "computer", onSelect: () => notSimulated("Drive for desktop", "Desktop sync clients are not simulated. Use the Drive REST routes to change files from outside the browser.") },
    { label: "Keyboard shortcuts", icon: "keyboard", onSelect: onKeyboard },
    ...(extra.length ? ["divider", ...extra] : []),
  ], { align: "end" });
}

const LAUNCHER = [
  ["Account", undefined],
  ["Drive", "./assets/google-drive-2026.svg"],
  ["Docs", "./assets/google-docs-2026.svg"],
  ["Sheets", "./assets/google-sheets-2026.svg"],
  ["Slides", "./assets/google-slides-2026.svg"],
  ["Forms", "./assets/google-forms-2026.svg"],
  ["Calendar", "./assets/google-calendar-2026.svg"],
  ["Keep", "./assets/google-keep-2026.svg"],
  ["Tasks", "./assets/google-tasks-2026.svg"],
  ["Contacts", "./assets/google-contacts.svg"],
];

/** The Google apps launcher: a grid of product tiles. Drive/Docs/Sheets/Slides act through the Tool. */
export function openAppsLauncher(anchor, { initial, onDrive, onCreate }) {
  const gridEl = el("div", { class: "gd-launcher", attrs: { role: "group", "aria-label": "Google apps" } });
  for (const [name, logo] of LAUNCHER) {
    const tile = el("button", { class: "gd-launcher-tile", attrs: { type: "button", role: "menuitem" } }, [
      logo ? el("img", { attrs: { src: logo, alt: "", width: 40, height: 40 } }) : el("span", { class: "gd-launcher-avatar", text: initial }),
      el("span", { class: "gd-launcher-name", text: name }),
    ]);
    tile.addEventListener("click", () => {
      if (name === "Drive") onDrive();
      else if (["Docs", "Sheets", "Slides"].includes(name)) onCreate(name);
      else notSimulated(name === "Account" ? "Google Account" : `Google ${name}`);
    });
    gridEl.append(tile);
  }
  openMenu(anchor, gridEl, { align: "end", className: "gd-menu-launcher" });
}
