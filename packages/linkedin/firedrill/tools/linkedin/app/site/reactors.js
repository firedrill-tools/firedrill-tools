// Reactions modal: All / per-type tabs with counts; rows page through reactions.list (newest first).
import { el, call, describe, avatar } from "./ui.js";
import { REACTIONS, reactionBadge } from "./reactions.js";
import { openModal } from "./overlay.js";
import { resolveEntity, hrefForUrn } from "./store.js";

const PAGE = 20;

export function openReactionsModal(post, summaries = {}) {
  const modal = openModal({ title: "Reactions", className: "modal--reactors" });
  const total = Object.values(summaries).reduce((sum, s) => sum + s.count, 0);
  const tabs = el("div", { class: "reactors__tabs", attrs: { role: "tablist" } });
  const list = el("ul", { class: "reactors__list", attrs: { role: "tabpanel" } });
  const status = el("div", { class: "reactors__status", attrs: { role: "status" } });
  modal.body.append(tabs, list, status);

  const rows = []; // every loaded reaction, newest first
  let nextStart = 0;
  let done = false;
  let filter = null;

  const addTab = (type, label, count) => {
    const tab = el("button", { class: "reactors__tab", attrs: { type: "button", role: "tab", "aria-selected": String(type === filter), "aria-label": `${label} ${count}` } }, [
      type ? reactionBadge(type, 16) : null, el("span", { text: type ? String(count) : `All ${count}` }),
    ]);
    tab.addEventListener("click", () => { filter = type; for (const t of tabs.children) t.setAttribute("aria-selected", String(t === tab)); void paint(); });
    tabs.append(tab);
  };
  addTab(null, "All", total);
  for (const reaction of REACTIONS) if (summaries[reaction.type]) addTab(reaction.type, reaction.label, summaries[reaction.type].count);

  const loadPage = async () => {
    const page = await call("reactions.list", { entity: post.id, sort: "REVERSE_CHRONOLOGICAL", start: nextStart, count: PAGE });
    rows.push(...page.elements);
    nextStart += page.elements.length;
    done = page.elements.length === 0 || !page.paging.links.some((link) => link.rel === "next");
  };

  let painting = 0;
  const paint = async () => {
    const token = ++painting;
    status.replaceChildren(el("span", { class: "spinner", attrs: { "aria-label": "Loading reactions" } }));
    try {
      // A per-type tab keeps paging until it has a screenful of matches or the list ends, so nothing is hidden.
      const visible = () => rows.filter((r) => !filter || r.reactionType === filter);
      if (rows.length === 0 && !done) await loadPage();
      while (filter && !done && visible().length < PAGE) await loadPage();
      if (token !== painting) return;
      list.replaceChildren();
      for (const reaction of visible()) list.append(await renderRow(reaction));
      if (token !== painting) return;
      status.replaceChildren();
      if (visible().length === 0) status.append(el("p", { class: "muted", text: "No reactions yet." }));
      if (!done) status.append(el("button", { class: "btn btn--tertiary btn--sm", text: "Show more results", attrs: { type: "button" }, on: { click: async () => { await loadPage(); await paint(); } } }));
    } catch (error) {
      status.replaceChildren(el("p", { class: "comments__error", attrs: { role: "alert" }, text: describe(error) }));
    }
  };
  void paint();
}

async function renderRow(reaction) {
  const who = await resolveEntity(reaction.created.actor);
  return el("li", { class: "reactors__row" }, [
    el("a", { class: "reactors__avatar", attrs: { href: hrefForUrn(reaction.created.actor), "aria-label": who.name } }, [avatar(who.name, reaction.created.actor, 48, who.kind === "organization"), reactionBadge(reaction.reactionType, 16)]),
    el("div", { class: "reactors__meta" }, [
      el("a", { class: "reactors__name", text: who.name, attrs: { href: hrefForUrn(reaction.created.actor) } }),
      el("div", { class: "reactors__sub", text: who.headline ?? "" }),
    ]),
  ]);
}
