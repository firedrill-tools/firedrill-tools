// Comment/reply input with "comment as" avatar selector and an @mention picker over the viewer's connections.
import { el, call, describe, avatar, busy } from "./ui.js";
import { icon } from "./icons.js";
import { session, actingPages } from "./store.js";
import { showMenu, notSimulated } from "./overlay.js";

export function commentBox({ placeholder = "Add a comment…", submitLabel = "Comment", asPages = false, autofocus = false, compact = false, initialText = "", initialAttributes = [], onSubmit, onCancel }) {
  const viewer = session.viewer;
  let actor = viewer.personUrn;
  const mentions = []; // { name, urn }
  for (const attribute of initialAttributes ?? []) {
    const urn = attribute.value?.person?.person ?? attribute.value?.organization?.organization;
    if (urn) mentions.push({ name: initialText.slice(attribute.start, attribute.start + attribute.length), urn });
  }

  const form = el("form", { class: `comment-box${compact ? " comment-box--compact" : ""}` });
  const who = el("button", { class: "comment-box__as", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } });
  const paintWho = () => {
    const page = actingPages().find((p) => p.organizationUrn === actor);
    const name = page ? page.name : viewer.name;
    who.replaceChildren(avatar(name, actor, compact ? 32 : 40, Boolean(page)));
    who.setAttribute("aria-label", `Commenting as ${name}. Change`);
    who.title = `Commenting as ${name}`;
  };
  paintWho();
  const pages = asPages ? actingPages() : [];
  if (pages.length > 0) {
    who.addEventListener("click", () => showMenu(who, [{ urn: viewer.personUrn, name: viewer.name }, ...pages.map((p) => ({ urn: p.organizationUrn, name: p.name }))].map((choice) => ({
      label: `${choice.urn === actor ? "✓ " : ""}${choice.name}`, sub: choice.urn === viewer.personUrn ? "Your profile" : "Page you manage", onSelect: () => { actor = choice.urn; paintWho(); },
    })), { align: "left" }));
  } else {
    who.disabled = true;
  }

  const input = el("textarea", { class: "comment-box__input", attrs: { rows: "1", placeholder, "aria-label": placeholder.replace("…", "") } });
  input.value = initialText;
  const picker = el("div", { class: "mention-picker", attrs: { role: "listbox", "aria-label": "Mention suggestions" } });
  picker.hidden = true;
  const error = el("p", { class: "comment-box__error", attrs: { role: "alert" } });
  error.hidden = true;
  const submit = el("button", { class: "btn btn--primary btn--sm comment-box__submit", text: submitLabel, attrs: { type: "submit" } });
  const tools = el("span", { class: "comment-box__tools" }, [
    el("button", { class: "icon-btn icon-btn--sm", title: "Open Emoji Keyboard", attrs: { type: "button", "aria-label": "Open Emoji Keyboard" }, on: { click: () => notSimulated("Emoji keyboard") } }, icon("emoji")),
    el("button", { class: "icon-btn icon-btn--sm", title: "Add a photo", attrs: { type: "button", "aria-label": "Add a photo" }, on: { click: () => notSimulated("Images in comments") } }, icon("photo")),
  ]);
  const field = el("div", { class: "comment-box__field" }, [input, tools]);
  const row = el("div", { class: "comment-box__row" }, [who, el("div", { class: "comment-box__main" }, [field, picker])]);
  const footer = el("div", { class: "comment-box__footer" }, [
    onCancel ? el("button", { class: "btn btn--tertiary btn--sm", text: "Cancel", attrs: { type: "button" }, on: { click: onCancel } }) : null,
    submit,
  ]);
  form.append(row, error, footer);

  const sync = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    const has = input.value.trim().length > 0;
    footer.hidden = !has && !onCancel;
    submit.disabled = !has || [...input.value].length > 1250;
  };
  sync();

  let searchToken = 0;
  const mentionQuery = () => {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length);
    const match = /(?:^|\s)@([\p{L}\p{N} .'-]{0,40})$/u.exec(before);
    return match ? { query: match[1], at: before.length - match[1].length - 1 } : null;
  };
  const refreshPicker = async () => {
    const found = mentionQuery();
    if (!found) { picker.hidden = true; return; }
    const token = ++searchToken;
    try {
      const page = await call("connections.list", { query: found.query.trim(), start: 0, count: 5 });
      if (token !== searchToken) return;
      picker.replaceChildren();
      if (page.elements.length === 0) { picker.append(el("p", { class: "mention-picker__empty", text: "No matching connections" })); }
      for (const { person } of page.elements) {
        const name = `${person.localizedFirstName} ${person.localizedLastName}`.trim();
        picker.append(el("button", { class: "mention-picker__item", attrs: { type: "button", role: "option" }, on: { mousedown: (event) => event.preventDefault(), click: () => {
          input.value = `${input.value.slice(0, found.at)}${name} ${input.value.slice(input.selectionStart ?? input.value.length)}`;
          mentions.push({ name, urn: `urn:li:person:${person.id}` });
          picker.hidden = true;
          input.focus();
          sync();
        } } }, [avatar(name, `urn:li:person:${person.id}`, 32), el("span", {}, [el("span", { class: "t-bold", text: name }), el("span", { class: "mention-picker__sub", text: person.localizedHeadline ?? "" })])]));
      }
      picker.hidden = false;
    } catch { picker.hidden = true; }
  };
  input.addEventListener("input", () => { error.hidden = true; sync(); void refreshPicker(); });
  input.addEventListener("keydown", (event) => { if (event.key === "Escape" && !picker.hidden) { event.stopPropagation(); picker.hidden = true; } });
  input.addEventListener("blur", () => setTimeout(() => { picker.hidden = true; }, 150));

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void busy(submit, async () => {
      const text = input.value.trim();
      const attributes = [];
      let from = 0;
      for (const mention of mentions) {
        const start = text.indexOf(mention.name, from);
        if (start < 0) continue;
        const kind = mention.urn.startsWith("urn:li:organization:") ? "organization" : "person";
        attributes.push({ start, length: mention.name.length, value: kind === "person" ? { person: { person: mention.urn } } : { organization: { organization: mention.urn } } });
        from = start + mention.name.length;
      }
      try {
        await onSubmit({ text, attributes, actor });
        if (form.isConnected) { input.value = ""; mentions.length = 0; sync(); }
      } catch (failure) {
        error.textContent = describe(failure);
        error.hidden = false;
      }
    });
  });
  if (autofocus) queueMicrotask(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  return form;
}
