// Home: identity card and shortcuts (left), share box + paged feed (centre), pages and footer (right).
import { el, call, describe, avatar, setServerNow, busy } from "./ui.js";
import { icon } from "./icons.js";
import { session } from "./store.js";
import { renderPostCard } from "./post.js";
import { openComposer } from "./composer.js";
import { modalOpen } from "./overlay.js";

const PAGE = 10;

function skeleton() {
  return el("div", { class: "card skeleton", attrs: { "aria-hidden": "true" } }, [
    el("div", { class: "skeleton__row" }, [el("div", { class: "skeleton__circle" }), el("div", { class: "skeleton__grow" }, [el("div", { class: "skeleton__line skeleton__line--w40" }), el("div", { class: "skeleton__line skeleton__line--w60" })])]),
    el("div", { class: "skeleton__line" }), el("div", { class: "skeleton__line skeleton__line--w85" }), el("div", { class: "skeleton__line skeleton__line--w70" }),
  ]);
}

export function identityCard() {
  const v = session.viewer;
  const href = `#/in/${encodeURIComponent(v.personUrn.split(":").pop())}`;
  const pages = v.pages.slice(0, 1);
  return el("div", { class: "card identity" }, [
    el("div", { class: "identity__cover", attrs: { "aria-hidden": "true" } }),
    el("div", { class: "identity__main" }, [
      el("a", { class: "identity__avatar", attrs: { href, "aria-label": v.name, tabindex: "-1" } }, avatar(v.name, v.personUrn, 72)),
      el("a", { class: "identity__name", text: v.name, attrs: { href } }),
      v.headline ? el("p", { class: "identity__headline", text: v.headline }) : null,
      ...pages.map((p) => el("a", { class: "identity__page", attrs: { href: `#/company/${encodeURIComponent(p.vanityName)}` } }, [avatar(p.name, p.organizationUrn, 24, true), el("span", { text: p.name })])),
    ]),
    el("div", { class: "identity__rows" }, [
      el("a", { class: "identity__row", attrs: { href: "#/mynetwork" } }, [el("span", {}, [el("span", { text: "Connections" }), el("span", { class: "identity__row-sub", text: "Grow your network" })]), el("span", { class: "identity__row-value", text: String(v.connectionCount) })]),
      el("button", { class: "identity__row", attrs: { type: "button", "data-not-simulated": "Profile viewers" } }, el("span", { text: "Profile viewers" })),
      el("button", { class: "identity__row", attrs: { type: "button", "data-not-simulated": "Post impressions" } }, el("span", { text: "Post impressions" })),
    ]),
    el("button", { class: "identity__premium", attrs: { type: "button", "data-not-simulated": "Premium" } }, [el("span", { text: "Access exclusive tools & insights" }), el("strong", {}, [el("span", { class: "identity__premium-mark", attrs: { "aria-hidden": "true" } }), el("span", { text: "Try Premium for $0" })])]),
    el("button", { class: "identity__premium", attrs: { type: "button", "data-not-simulated": "Saved items" } }, el("strong", {}, [icon("bookmark"), el("span", { text: "Saved items" })])),
  ]);
}

function shortcuts() {
  return el("div", { class: "card shortcuts" }, [["group", "Groups"], ["newsletter", "Newsletters"], ["calendar", "Events"]].map(([glyph, label]) =>
    el("button", { class: "shortcuts__item", attrs: { type: "button", "data-not-simulated": label } }, [icon(glyph), el("span", { text: label })])));
}

function rightRail() {
  const pages = session.viewer.pages;
  return el("aside", { class: "rail-right" }, [
    el("div", { class: "card news" }, [
      el("div", { class: "news__head" }, [el("h2", { class: "news__title", text: "LinkedIn News" }), el("button", { class: "icon-btn icon-btn--sm", title: "About news", attrs: { type: "button", "aria-label": "About LinkedIn News", "data-not-simulated": "LinkedIn News" } }, icon("info"))]),
      el("p", { class: "news__sub", text: "Top stories" }),
      el("p", { class: "news__empty", text: "News stories aren't simulated in this environment." }),
    ]),
    pages.length ? el("div", { class: "card follow" }, [
      el("div", { class: "news__head" }, el("h2", { class: "news__title", text: "Your pages" })),
      ...pages.map((p) => el("div", { class: "follow__item" }, [avatar(p.name, p.organizationUrn, 48, true), el("div", {}, [
        el("a", { class: "follow__name", text: p.name, attrs: { href: `#/company/${encodeURIComponent(p.vanityName)}` } }),
        el("span", { class: "follow__sub", text: p.roles.map((r) => r.charAt(0) + r.slice(1).toLowerCase().replaceAll("_", " ")).join(", ") }),
        el("div", {}, el("a", { class: "btn btn--muted btn--sm", text: "View page", attrs: { href: `#/company/${encodeURIComponent(p.vanityName)}` } })),
      ])])),
    ]) : null,
    footer(),
  ]);
}

export function footer() {
  const links = ["About", "Accessibility", "Help Center", "Privacy & Terms", "Ad Choices", "Advertising", "Business Services", "Get the LinkedIn app", "More"];
  return el("footer", { class: "rail-footer" }, [
    el("div", { class: "rail-footer__links" }, links.map((label) => el("button", { text: label, attrs: { type: "button", "data-not-simulated": label } }))),
    el("div", { class: "rail-footer__brand" }, [el("img", { attrs: { src: "./assets/linkedin-wordmark.svg", alt: "LinkedIn", width: "56", height: "14" } }), el("span", { text: "Simulated in a Firedrill world" })]),
  ]);
}

export function renderHome(main) {
  const v = session.viewer;
  const list = el("div", { class: "feed-list", attrs: { "aria-busy": "true" } }, [skeleton(), skeleton()]);
  const more = el("div", { class: "feed-more" });
  const newPosts = el("div", { class: "new-posts" });
  newPosts.hidden = true;
  let loaded = 0;
  let total = 0;

  const load = async ({ reset }) => {
    const start = reset ? 0 : loaded;
    const count = reset ? Math.max(PAGE, loaded) : PAGE;
    try {
      const page = await call("feed.list", { start, count });
      setServerNow(page.serverTimeMs);
      session.viewer = page.viewer;
      if (reset) { list.replaceChildren(); loaded = 0; }
      for (const entry of page.elements) list.append(renderPostCard(entry, { onReload: () => load({ reset: true }) }));
      loaded = start + page.elements.length;
      total = page.paging.total ?? loaded;
      list.removeAttribute("aria-busy");
      more.replaceChildren();
      if (loaded === 0) list.append(el("div", { class: "card state-card" }, [el("h2", { class: "state-card__title", text: "Start a conversation" }), el("p", { class: "state-card__text", text: "Your feed is empty. Posts from you, your connections and pages you follow will show up here." }), el("button", { class: "btn btn--primary", text: "Start a post", attrs: { type: "button" }, on: { click: () => openComposer({ onDone: () => load({ reset: true }) }) } })]));
      else if (loaded < total) more.append(el("button", { class: "btn", text: "Show more feed updates", attrs: { type: "button" }, on: { click: (event) => busy(event.currentTarget, () => load({ reset: false })) } }));
      else more.append(el("p", { class: "feed-end", text: "You're all caught up." }));
    } catch (error) {
      list.removeAttribute("aria-busy");
      if (reset) list.replaceChildren();
      more.replaceChildren(el("div", { class: "card state-card state-card--error", attrs: { role: "alert" } }, [el("h2", { class: "state-card__title", text: "Couldn't load your feed" }), el("p", { class: "state-card__text", text: describe(error) }), el("button", { class: "btn btn--secondary", text: "Retry", attrs: { type: "button" }, on: { click: () => load({ reset }) } })]));
    }
  };

  const shareBox = el("div", { class: "card share-box" }, [
    el("div", { class: "share-box__top" }, [
      el("a", { attrs: { href: `#/in/${encodeURIComponent(v.personUrn.split(":").pop())}`, "aria-label": "View your profile", tabindex: "-1" } }, avatar(v.name, v.personUrn, 48)),
      el("button", { class: "share-box__trigger", text: "Start a post", attrs: { type: "button" }, on: { click: () => openComposer({ onDone: () => load({ reset: true }) }) } }),
    ]),
    el("div", { class: "share-box__actions" }, [
      el("button", { class: "share-box__action share-box__action--video", attrs: { type: "button", "data-not-simulated": "Video posts" } }, [icon("video"), el("span", { text: "Video" })]),
      el("button", { class: "share-box__action share-box__action--photo", attrs: { type: "button", "data-not-simulated": "Photo posts" } }, [icon("photo"), el("span", { text: "Photo" })]),
      el("button", { class: "share-box__action share-box__action--article", attrs: { type: "button", "data-not-simulated": "Articles" } }, [icon("article"), el("span", { text: "Write article" })]),
    ]),
  ]);
  const sortBar = el("div", { class: "sort-bar" }, [el("span", { text: "Sort by:" }), el("button", { attrs: { type: "button", "aria-label": "Sort feed: Recent", "data-not-simulated": "Feed sort options" } }, [el("strong", { text: "Recent" }), icon("caret-down")])]);
  newPosts.append(el("button", { attrs: { type: "button" }, on: { click: () => { newPosts.hidden = true; window.scrollTo({ top: 0 }); void load({ reset: true }); } } }, [icon("arrow-up"), el("span", { text: "New posts" })]));

  main.replaceChildren(el("div", { class: "home" }, [
    el("aside", { class: "rail-left" }, [identityCard(), shortcuts()]),
    el("div", { class: "feed-main" }, [shareBox, sortBar, newPosts, list, more]),
    rightRail(),
  ]));
  void load({ reset: true });

  return {
    /** World changed elsewhere: reload unless the reader has unsent work, in which case offer "New posts". */
    refresh: () => {
      const typing = [...main.querySelectorAll(".comment-box__input")].some((input) => input.value.trim()) || main.querySelector(".comment-box .btn[data-busy='true']") || modalOpen();
      if (typing) newPosts.hidden = false; else return load({ reset: true });
      return undefined;
    },
  };
}
