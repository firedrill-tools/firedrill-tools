// "Create a post" modal: post-as selector, visibility, text with counter, link attachment, repost embed and edit mode.
import { el, call, newKey, describe, toast, avatar, busy } from "./ui.js";
import { icon } from "./icons.js";
import { openModal, closeModal, showMenu } from "./overlay.js";
import { session, actingPages } from "./store.js";
import { escapeLittleText, littleTextToPlain } from "./text.js";

const MAX = 3000;
const VIS = { PUBLIC: ["globe", "Anyone"], CONNECTIONS: ["people", "Connections only"] };
let draft = { text: "", visibility: "PUBLIC" };

/** options: { repostOf?: feed entry, edit?: feed entry, draftPost?: post (publish/edit a draft), onDone } */
export function openComposer({ repostOf = null, edit = null, onDone } = {}) {
  const viewer = session.viewer;
  if (!viewer) return;
  const editing = Boolean(edit);
  let author = editing ? edit.post.author : viewer.personUrn;
  let visibility = editing ? edit.post.visibility : repostOf ? "PUBLIC" : draft.visibility;
  const modal = openModal({ title: editing ? "Edit post" : "Create a post", className: "modal--composer", onClose: () => { if (!editing && !repostOf) draft = { text: textarea.value, visibility }; } });

  const who = el("button", { class: "composer__who", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", disabled: editing ? true : undefined } });
  const paintWho = () => {
    const page = actingPages().find((p) => p.organizationUrn === author);
    const name = page ? page.name : viewer.name;
    const [visIcon, visLabel] = VIS[visibility] ?? VIS.PUBLIC;
    who.replaceChildren(
      avatar(name, author, 56, Boolean(page)),
      el("span", { class: "composer__who-text" }, [
        el("span", { class: "composer__who-name" }, [el("span", { text: name }), editing ? null : icon("caret-down")]),
        el("span", { class: "composer__who-vis" }, [icon(visIcon), el("span", { text: `Post to ${visLabel}` })]),
      ]),
    );
    who.setAttribute("aria-label", `Posting as ${name}, visible to ${visLabel}. Change`);
  };
  who.addEventListener("click", () => {
    const choices = [{ urn: viewer.personUrn, name: viewer.name, sub: "Your profile" }, ...actingPages().map((p) => ({ urn: p.organizationUrn, name: p.name, sub: "Page you manage" }))];
    showMenu(who, [
      ...choices.map((c) => ({ label: `${c.urn === author ? "✓ " : ""}${c.name}`, sub: c.sub, onSelect: () => { author = c.urn; if (c.urn !== viewer.personUrn) visibility = "PUBLIC"; paintWho(); } })),
      ...Object.entries(VIS).map(([key, [visIcon, label]]) => ({ icon: visIcon, label: `${key === visibility ? "✓ " : ""}${label}`, sub: key === "PUBLIC" ? "Anyone on or off LinkedIn" : "Connections on LinkedIn", disabled: key === "CONNECTIONS" && author !== viewer.personUrn, onSelect: () => { visibility = key; paintWho(); } })),
    ], { align: "left" });
  });
  paintWho();

  const textarea = el("textarea", { class: "composer__text", attrs: { "aria-label": "Text editor for creating content", placeholder: repostOf ? "Start writing or use @ to mention people" : "What do you want to talk about?", rows: "8" } });
  textarea.value = editing ? littleTextToPlain(edit.post.commentary) : repostOf ? "" : draft.text;
  const counter = el("span", { class: "composer__counter", attrs: { "aria-live": "polite" } });
  const error = el("p", { class: "composer__error", attrs: { role: "alert" }, hidden: true });
  error.hidden = true;

  const link = { open: false };
  const linkBox = el("div", { class: "composer__link", hidden: true });
  linkBox.hidden = true;
  const linkUrl = el("input", { class: "field__input", attrs: { id: "composer-link-url", type: "url", placeholder: "https://" } });
  const linkTitle = el("input", { class: "field__input", attrs: { id: "composer-link-title", type: "text", maxlength: "400" } });
  linkBox.append(
    el("label", { class: "field__label", text: "Link URL", attrs: { for: "composer-link-url" } }), linkUrl,
    el("label", { class: "field__label", text: "Headline", attrs: { for: "composer-link-title" } }), linkTitle,
  );

  const embed = repostOf ? el("div", { class: "composer__embed" }, [
    el("div", { class: "composer__embed-head" }, [avatar(repostOf.actor.name, repostOf.actor.urn, 32, repostOf.actor.kind === "organization"), el("span", { class: "t-bold", text: repostOf.actor.name })]),
    el("p", { class: "composer__embed-text", text: littleTextToPlain(repostOf.post.commentary) }),
  ]) : null;

  modal.heading.classList.add("visually-hidden");
  modal.heading.before(who);
  modal.body.append(...[textarea, embed, linkBox, error].filter(Boolean));
  const tools = el("div", { class: "composer__tools" }, [
    el("button", { class: "icon-btn", title: "Add a link", attrs: { type: "button", "aria-label": "Add a link", disabled: editing || repostOf ? true : undefined }, on: { click: () => { link.open = !link.open; linkBox.hidden = !link.open; if (link.open) linkUrl.focus(); } } }, icon("link")),
    el("button", { class: "icon-btn", title: "Add media", attrs: { type: "button", "aria-label": "Add media", "data-not-simulated": "Photo and video uploads" } }, icon("photo")),
    el("button", { class: "icon-btn", title: "Create an event", attrs: { type: "button", "aria-label": "Create an event", "data-not-simulated": "Events" } }, icon("calendar")),
    el("button", { class: "icon-btn", title: "More", attrs: { type: "button", "aria-label": "More", "data-not-simulated": "Polls, documents and other post types" } }, icon("plus")),
  ]);
  const submit = el("button", { class: "btn btn--primary btn--sm composer__submit", text: editing ? "Save" : "Post", attrs: { type: "button" } });
  modal.footer.append(tools, el("div", { class: "composer__submit-row" }, [counter, submit]));

  const validate = () => {
    const length = [...textarea.value].length;
    counter.textContent = length > MAX - 200 ? `${MAX - length}` : "";
    counter.classList.toggle("composer__counter--over", length > MAX);
    const empty = textarea.value.trim() === "" && !repostOf && !(link.open && linkUrl.value.trim());
    submit.disabled = empty || length > MAX;
  };
  textarea.addEventListener("input", () => { error.hidden = true; validate(); });
  linkUrl.addEventListener("input", validate);
  validate();

  const key = newKey(); // reused if the same submission is retried after an uncertain failure
  submit.addEventListener("click", () => busy(submit, async () => {
    error.hidden = true;
    const commentary = escapeLittleText(textarea.value.trim());
    try {
      if (editing) {
        await call("posts.update", { postUrn: edit.post.id, commentary }, key);
      } else {
        const args = { author, commentary, visibility, distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false };
        if (repostOf) args.reshareContext = { parent: repostOf.post.id };
        if (link.open && linkUrl.value.trim()) args.content = { article: { source: linkUrl.value.trim(), title: linkTitle.value.trim() || linkUrl.value.trim() } };
        await call("posts.create", args, key);
        if (!repostOf) draft = { text: "", visibility: "PUBLIC" };
      }
      closeModal();
      toast(editing ? "Post updated." : repostOf ? "Repost successful." : "Post successful.");
      await onDone?.();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure?.code === "INTERNAL_SERVER_ERROR" && !editing
        ? "Something went wrong. Check your recent activity before posting again — your post may have been published."
        : describe(failure);
    }
  }));
}
