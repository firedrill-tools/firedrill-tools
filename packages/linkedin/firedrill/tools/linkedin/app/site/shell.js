// Global navigation: active item, the Me menu and the search typeahead (connections + exact company page).
import { $, $$, el, call, avatar } from "./ui.js";
import { session, rememberOrganization } from "./store.js";
import { notSimulated } from "./overlay.js";

export function setActiveNav(key) {
  for (const item of $$("[data-nav]")) {
    if (item.dataset.nav === key) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
}

export function paintMe() {
  const v = session.viewer;
  const holder = $("#me-avatar");
  const fresh = avatar(v.name, v.personUrn, 24);
  fresh.id = "me-avatar";
  holder.replaceWith(fresh);
}

function closeMe() {
  $("#me-menu").hidden = true;
  $("#me-button").setAttribute("aria-expanded", "false");
}

function openMe() {
  const v = session.viewer;
  const menu = $("#me-menu");
  const personId = v.personUrn.split(":").pop();
  menu.replaceChildren(
    el("div", { class: "me-menu__head" }, [avatar(v.name, v.personUrn, 56), el("div", {}, [el("div", { class: "me-menu__name", text: v.name }), v.headline ? el("div", { class: "me-menu__headline", text: v.headline }) : null])]),
    el("div", { class: "me-menu__view" }, el("a", { class: "btn btn--secondary btn--sm", text: "View Profile", attrs: { href: `#/in/${encodeURIComponent(personId)}`, role: "menuitem" }, on: { click: closeMe } })),
    el("div", { class: "me-menu__section" }, [
      el("div", { class: "me-menu__title", text: "Account" }),
      ...["Try Premium for $0", "Settings & Privacy", "Help", "Language"].map((label) => el("button", { class: "me-menu__link", text: label, attrs: { type: "button", role: "menuitem" }, on: { click: () => { closeMe(); notSimulated(label); } } })),
    ]),
    el("div", { class: "me-menu__section" }, [
      el("div", { class: "me-menu__title", text: "Manage" }),
      el("button", { class: "me-menu__link", text: "Posts & Activity", attrs: { type: "button", role: "menuitem" }, on: { click: () => { closeMe(); location.hash = `#/in/${encodeURIComponent(personId)}`; } } }),
      ...v.pages.map((p) => el("a", { class: "me-menu__link", text: `Company: ${p.name}`, attrs: { href: `#/company/${encodeURIComponent(p.vanityName)}`, role: "menuitem" }, on: { click: closeMe } })),
      el("button", { class: "me-menu__link", text: "Job Posting Account", attrs: { type: "button", role: "menuitem" }, on: { click: () => { closeMe(); notSimulated("Job posting"); } } }),
    ]),
    el("div", { class: "me-menu__section" }, el("button", { class: "me-menu__link", text: "Sign Out", title: "Signing out is not simulated", attrs: { type: "button", role: "menuitem", disabled: true } })),
  );
  menu.hidden = false;
  $("#me-button").setAttribute("aria-expanded", "true");
  menu.querySelector("a, button:not([disabled])")?.focus();
}

export function initShell() {
  $("#me-button").addEventListener("click", () => ($("#me-menu").hidden ? openMe() : closeMe()));
  document.addEventListener("mousedown", (event) => {
    if (!$("#me-menu").hidden && !event.target.closest(".nav-me")) closeMe();
    if (!event.target.closest(".search")) hideTypeahead();
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") { closeMe(); hideTypeahead(); } });
  const input = $("#search-input");
  let timer;
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => void search(input.value), 180); });
  input.addEventListener("focus", () => { if (input.value.trim()) void search(input.value); });
  input.addEventListener("keydown", (event) => {
    const items = $$(".typeahead__item", $("#search-results"));
    if (!items.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
    event.preventDefault();
    let index = items.findIndex((i) => i.getAttribute("aria-selected") === "true");
    if (event.key === "Enter") { (items[index] ?? items[0]).click(); return; }
    index = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items.forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
  });
}

function hideTypeahead() {
  $("#search-results").hidden = true;
  $("#search-input").setAttribute("aria-expanded", "false");
}

let searchToken = 0;
async function search(raw) {
  const query = raw.trim();
  const box = $("#search-results");
  if (!query) { hideTypeahead(); return; }
  const token = ++searchToken;
  const vanity = query.toLowerCase().replace(/\s+/g, "-");
  const [people, companies] = await Promise.all([
    call("connections.list", { query, start: 0, count: 6 }).catch(() => null),
    /^[a-z0-9-]{1,100}$/.test(vanity) ? call("organizations.find_by_vanity_name", { vanityName: vanity }).catch(() => null) : Promise.resolve(null),
  ]);
  if (token !== searchToken) return;
  const go = (href) => () => { hideTypeahead(); $("#search-input").value = ""; location.hash = href; };
  box.replaceChildren();
  const orgs = companies?.elements ?? [];
  const members = people?.elements ?? [];
  if (members.length) box.append(el("div", { class: "typeahead__heading", text: "Your connections" }));
  for (const { person } of members) {
    const name = `${person.localizedFirstName} ${person.localizedLastName}`;
    box.append(el("button", { class: "typeahead__item", attrs: { type: "button", role: "option", "aria-selected": "false" }, on: { click: go(`#/in/${encodeURIComponent(person.id)}`) } }, [avatar(name, `urn:li:person:${person.id}`, 32), el("span", { class: "typeahead__text" }, [el("span", { class: "typeahead__name", text: name }), el("span", { class: "typeahead__sub", text: ` • 1st${person.localizedHeadline ? ` • ${person.localizedHeadline}` : ""}` })])]));
  }
  if (orgs.length) box.append(el("div", { class: "typeahead__heading", text: "Companies" }));
  for (const org of orgs) {
    rememberOrganization(org);
    box.append(el("button", { class: "typeahead__item", attrs: { type: "button", role: "option", "aria-selected": "false" }, on: { click: go(`#/company/${encodeURIComponent(org.vanityName)}`) } }, [avatar(org.localizedName, `urn:li:organization:${org.id}`, 32, true), el("span", { class: "typeahead__text" }, [el("span", { class: "typeahead__name", text: org.localizedName }), el("span", { class: "typeahead__sub", text: " • Company" })])]));
  }
  if (!members.length && !orgs.length) box.append(el("p", { class: "typeahead__empty", text: people === null ? "Search is unavailable right now." : `No results for "${query.slice(0, 80)}"` }));
  box.append(el("button", { class: "typeahead__footer", text: "See all results", attrs: { type: "button", "data-not-simulated": "Full search results" } }));
  box.hidden = false;
  $("#search-input").setAttribute("aria-expanded", "true");
}
