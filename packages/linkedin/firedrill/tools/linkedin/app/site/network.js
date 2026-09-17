// My Network > Connections: count header, search, "Recently added" list with paging.
import { el, call, describe, avatar, longDate, busy } from "./ui.js";
import { icon } from "./icons.js";
import { footer } from "./feed.js";

const PAGE = 10;

export function renderNetwork(main) {
  const header = el("h1", { class: "network__count", text: "Connections" });
  const input = el("input", { class: "network__search-input", attrs: { id: "network-search", type: "search", placeholder: "Search by name", autocomplete: "off" } });
  const list = el("ul", { class: "network__list", attrs: { "aria-live": "polite" } });
  const more = el("div", { class: "network__more" });
  let query = "";
  let loaded = 0;
  let token = 0;

  const load = async (reset) => {
    const mine = ++token;
    if (reset) { loaded = 0; list.replaceChildren(el("li", { class: "network__loading" }, el("span", { class: "spinner", attrs: { "aria-label": "Loading connections" } }))); }
    more.replaceChildren();
    try {
      const page = await call("connections.list", { query, start: loaded, count: PAGE });
      if (mine !== token) return;
      if (reset) list.replaceChildren();
      const total = page.paging.total ?? 0;
      if (!query) header.textContent = `${total} Connection${total === 1 ? "" : "s"}`;
      for (const { person, connectedAt } of page.elements) {
        const name = `${person.localizedFirstName} ${person.localizedLastName}`.trim();
        const href = `#/in/${encodeURIComponent(person.id)}`;
        list.append(el("li", { class: "network__row" }, [
          el("a", { attrs: { href, tabindex: "-1", "aria-hidden": "true" } }, avatar(name, `urn:li:person:${person.id}`, 72)),
          el("div", { class: "network__meta" }, [
            el("a", { class: "network__name", text: name, attrs: { href } }),
            person.localizedHeadline ? el("span", { class: "network__headline", text: person.localizedHeadline }) : null,
            el("span", { class: "network__date", text: `Connected on ${longDate(connectedAt)}` }),
          ]),
          el("div", { class: "network__actions" }, [
            el("button", { class: "btn btn--secondary btn--sm", text: "Message", attrs: { type: "button", "data-not-simulated": "Messaging" } }),
            el("button", { class: "icon-btn", title: "More actions", attrs: { type: "button", "aria-label": `More actions for ${name}`, "data-not-simulated": "Removing connections" } }, icon("ellipsis")),
          ]),
        ]));
      }
      loaded += page.elements.length;
      if (loaded === 0) list.append(el("li", { class: "network__empty" }, query
        ? [el("p", { class: "t-bold", text: "No results found" }), el("p", { class: "muted", text: "Try searching for a different name." })]
        : [el("p", { class: "t-bold", text: "You don't have any connections yet" }), el("p", { class: "muted", text: "Connections you make will appear here." })]));
      if (loaded < total) more.append(el("button", { class: "btn btn--tertiary", text: "Show more results", attrs: { type: "button" }, on: { click: (e) => busy(e.currentTarget, () => load(false)) } }));
    } catch (error) {
      if (mine !== token) return;
      list.replaceChildren(el("li", { class: "network__empty", attrs: { role: "alert" } }, [el("p", { class: "t-bold", text: "Couldn't load your connections" }), el("p", { class: "muted", text: describe(error) }), el("button", { class: "btn btn--secondary btn--sm", text: "Retry", attrs: { type: "button" }, on: { click: () => load(true) } })]));
    }
  };

  let timer;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { query = input.value.trim().slice(0, 200); void load(true); }, 200); });

  const manage = el("nav", { class: "card network-manage", attrs: { "aria-label": "Manage my network" } }, [
    el("h2", { class: "network-manage__title", text: "Manage my network" }),
    el("a", { class: "network-manage__item network-manage__item--active", attrs: { href: "#/mynetwork", "aria-current": "page" } }, [icon("nav-network"), el("span", { text: "Connections" })]),
    ...[["people", "Following & followers"], ["group", "Groups"], ["calendar", "Events"], ["nav-grid", "Pages"], ["newsletter", "Newsletters"]].map(([glyph, label]) =>
      el("button", { class: "network-manage__item", attrs: { type: "button", "data-not-simulated": label } }, [icon(glyph), el("span", { text: label })])),
  ]);

  main.replaceChildren(el("div", { class: "network-layout" }, [
    el("aside", {}, [manage, footer()]),
    el("section", { class: "card network" }, [
      header,
      el("div", { class: "network__toolbar" }, [
        el("span", { class: "network__sort" }, [el("span", { class: "muted", text: "Sort by: " }), el("button", { class: "network__sort-btn", attrs: { type: "button", "data-not-simulated": "Other connection sort orders" } }, [el("span", { text: "Recently added" }), icon("caret-down")])]),
        el("div", { class: "network__search" }, [icon("search"), el("label", { class: "visually-hidden", text: "Search connections by name", attrs: { for: "network-search" } }), input]),
      ]),
      list, more,
    ]),
  ]));
  void load(true);
  return { refresh: () => load(true) };
}
