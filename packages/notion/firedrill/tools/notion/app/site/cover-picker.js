// Cover picker: the product's Gallery / Upload / Link / Unsplash popover. Gallery and Link write `cover` through
// pages.update; Upload and Unsplash need file hosting or a remote service and are visibly disabled.
import { closePopovers, el, openPopover, textButton } from "./ui.js";
import { state } from "./state.js";

/** Gradient seed used to draw a cover (external images are never fetched inside the test environment). */
export function coverSeed(text) {
  let hash = 0;
  for (const character of String(text)) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 6;
}

/** Cover images already used in the workspace (the Tool stores covers as external links; none are invented here). */
export function workspaceCovers() {
  const urls = new Set();
  for (const node of [...state.pages.values(), ...state.databases.values()]) {
    const url = node.raw?.cover?.external?.url;
    if (typeof url === "string" && url !== "") urls.add(url);
  }
  return [...urls].slice(0, 9).map((url) => ({ seed: coverSeed(url), url }));
}

export function openCoverPicker(anchor, currentUrl, onPick, { startWith = "gallery" } = {}) {
  const GALLERY = workspaceCovers();
  const box = el("div", { class: "cover-picker", attrs: { "aria-label": "Change cover" } });
  const tabs = el("div", { class: "cover-tabs", attrs: { role: "tablist" } });
  const body = el("div", { class: "cover-body" });
  const tab = (label, { disabled = false, selected = false } = {}) => {
    const button = el("button", { class: "cover-tab", title: disabled ? `${label}: not simulated by this Tool` : label, attrs: { type: "button", role: "tab", "aria-selected": String(selected) } });
    button.append(el("span", { text: label }));
    button.disabled = disabled;
    return button;
  };
  const gallery = tab("Gallery", { selected: true });
  const upload = tab("Upload", { disabled: true });
  const link = tab("Link");
  const unsplash = tab("Unsplash", { disabled: true });
  const remove = el("button", { class: "cover-remove", text: "Remove", attrs: { type: "button" } });
  remove.disabled = !currentUrl;
  remove.addEventListener("click", () => { closePopovers(); onPick(null); });
  tabs.append(gallery, upload, link, unsplash, el("span", { class: "cover-tabs-gap" }), remove);

  const showGallery = () => {
    gallery.setAttribute("aria-selected", "true");
    link.setAttribute("aria-selected", "false");
    const grid = el("div", { class: "cover-grid" });
    GALLERY.forEach(({ seed, url }, index) => {
      const swatch = el("button", { class: `cover-swatch ${url === currentUrl ? "current" : ""}`.trim(), title: url, attrs: { type: "button", "aria-label": `Use cover ${index + 1}: ${url}` } });
      swatch.dataset.seed = String(seed);
      swatch.addEventListener("click", () => { closePopovers(); onPick(url); });
      grid.append(swatch);
    });
    const group = el("div", { class: "cover-group", text: "Used in this workspace" });
    if (GALLERY.length === 0) grid.append(el("p", { class: "cover-note-text", text: "No covers are used in this workspace yet. Add one from a link." }));
    body.replaceChildren(group, grid, el("p", { class: "cover-note-text", text: "Upload and Unsplash are not simulated by this Tool." }));
  };
  const showLink = () => {
    gallery.setAttribute("aria-selected", "false");
    link.setAttribute("aria-selected", "true");
    const id = "cover-link-input";
    const input = el("input", { class: "cover-link", attrs: { id, type: "url", placeholder: "Paste an image link…", "aria-label": "Image link", value: currentUrl ?? "" } });
    const submit = textButton("Submit", { class: "primary" });
    const run = () => {
      const value = input.value.trim();
      if (!/^https?:\/\/\S+$/.test(value)) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      closePopovers();
      onPick(value);
    };
    submit.addEventListener("click", run);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); run(); } });
    body.replaceChildren(input, submit, el("p", { class: "cover-note-text", text: "Works with any image from the web. Images are stored as links and drawn as a gradient here." }));
    input.focus();
  };
  gallery.addEventListener("click", showGallery);
  link.addEventListener("click", showLink);
  if (startWith === "link") showLink();
  else showGallery();
  box.append(tabs, body);
  return openPopover(anchor, box, { width: 440, align: "end", focusFirst: false });
}
