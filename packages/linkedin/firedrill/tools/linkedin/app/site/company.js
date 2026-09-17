// Company page (/company/{vanity}): header, admin view (About, Admins) when the viewer administers it, and page posts.
import { el, call, describe, avatar, relativeTime, busy } from "./ui.js";
import { icon } from "./icons.js";
import { session, rememberOrganization, resolveEntity, hrefForUrn } from "./store.js";
import { littleTextToPlain } from "./text.js";
import { openComposer } from "./composer.js";
import { footer } from "./feed.js";

const SIZES = { SIZE_1: "1 employee", SIZE_2_TO_10: "2-10 employees", SIZE_11_TO_50: "11-50 employees", SIZE_51_TO_200: "51-200 employees", SIZE_201_TO_500: "201-500 employees", SIZE_501_TO_1000: "501-1,000 employees", SIZE_1001_TO_5000: "1,001-5,000 employees", SIZE_5001_TO_10000: "5,001-10,000 employees", SIZE_10001_OR_MORE: "10,001+ employees" };
const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function renderCompany(main, vanity) {
  const host = el("div", { class: "company-main" }, el("section", { class: "card state-card" }, el("span", { class: "spinner", attrs: { "aria-label": "Loading page" } })));
  main.replaceChildren(el("div", { class: "profile-layout" }, [host, el("aside", { class: "profile-aside" }, footer())]));

  const load = async () => {
    try {
      const found = await call("organizations.find_by_vanity_name", { vanityName: vanity });
      const org = found.elements[0];
      if (!org) throw Object.assign(new Error("This page doesn't exist"), { code: "NOT_FOUND" });
      rememberOrganization(org);
      const urn = `urn:li:organization:${org.id}`;
      const role = session.viewer.pages.find((p) => p.organizationUrn === urn);
      let admin = null;
      if (role?.roles.includes("ADMINISTRATOR")) admin = await call("organizations.get", { organizationId: String(org.id) }).catch(() => null);
      const followers = await call("network_sizes.get", { entity: urn, edgeType: "COMPANY_FOLLOWED_BY_MEMBER" }).then((r) => r.firstDegreeSize).catch(() => null);
      paint(host, { org, admin, urn, followers, role });
    } catch (error) {
      host.replaceChildren(el("section", { class: "card state-card", attrs: { role: "alert" } }, [
        el("h1", { class: "state-card__title", text: error.code === "NOT_FOUND" ? "This page doesn't exist" : "Couldn't load this page" }),
        el("p", { class: "state-card__text", text: error.code === "NOT_FOUND" ? "Please check your URL or return to your feed." : describe(error) }),
        el("a", { class: "btn btn--secondary", text: "Go to your feed", attrs: { href: "#/feed" } }),
      ]));
    }
  };
  void load();
  return { refresh: load };
}

function paint(host, { org, admin, urn, followers, role }) {
  const location = org.locations?.[0]?.address;
  const where = location ? [location.city, location.geographicArea].filter(Boolean).join(", ") : "";
  const facts = [where, followers === null ? null : `${fmt(followers)} followers`, admin?.staffCountRange ? SIZES[admin.staffCountRange] : null].filter(Boolean).join(" · ");
  const canPost = role?.roles.some((r) => ["ADMINISTRATOR", "CONTENT_ADMINISTRATOR", "DIRECT_SPONSORED_CONTENT_POSTER"].includes(r));
  const posts = el("div", { class: "activity-list" });
  const more = el("div", { class: "activity-more" });
  const top = el("section", { class: "card profile-top" }, [
    el("div", { class: "profile-top__cover profile-top__cover--company", attrs: { "aria-hidden": "true" } }),
    el("div", { class: "profile-top__body" }, [
      el("div", { class: "profile-top__avatar" }, avatar(org.localizedName, urn, 152, true)),
      el("h1", { class: "profile-top__name", text: org.localizedName }),
      admin?.localizedDescription ? el("p", { class: "profile-top__headline", text: admin.localizedDescription }) : null,
      el("p", { class: "profile-top__meta muted", text: facts }),
      el("div", { class: "profile-top__actions" }, admin
        ? [el("button", { class: "btn btn--primary btn--sm", attrs: { type: "button" }, on: { click: () => openComposer({ onDone: () => loadPosts(true) }) } }, [icon("pencil"), el("span", { text: "Create" })]), el("button", { class: "btn btn--secondary btn--sm", text: "Edit page", attrs: { type: "button", "data-not-simulated": "Editing page details" } })]
        : [el("button", { class: "btn btn--primary btn--sm", attrs: { type: "button", "data-not-simulated": "Following pages" } }, [icon("plus"), el("span", { text: "Follow" })]), el("button", { class: "btn btn--secondary btn--sm", text: "Message", attrs: { type: "button", "data-not-simulated": "Messaging pages" } })]),
    ]),
    role && !admin ? el("p", { class: "company-note", text: "You don't have access to this page's admin view." }) : null,
  ]);
  const sections = [top];
  if (admin) {
    sections.push(el("section", { class: "card company-about" }, [
      el("h2", { class: "section-head__title", text: "About" }),
      admin.localizedDescription ? el("p", { class: "company-about__text", text: admin.localizedDescription }) : null,
      el("dl", { class: "company-about__facts" }, [
        ["Website", admin.localizedWebsite], ["Company size", SIZES[admin.staffCountRange]], ["Headquarters", where], ["Founded", admin.foundedOn?.year ? String(admin.foundedOn.year) : null],
      ].filter(([, value]) => value).flatMap(([label, value]) => [el("dt", { text: label }), el("dd", { text: value })])),
    ]));
    const admins = el("ul", { class: "company-admins" });
    sections.push(el("section", { class: "card company-about" }, [el("h2", { class: "section-head__title", text: "Page admins" }), admins]));
    void loadAdmins(admins, urn);
  }
  sections.push(el("section", { class: "card profile-activity" }, [
    el("div", { class: "section-head" }, [el("h2", { class: "section-head__title", text: "Page posts" }), canPost ? el("button", { class: "btn btn--secondary btn--sm", text: "Start a post", attrs: { type: "button" }, on: { click: () => openComposer({ onDone: () => loadPosts(true) }) } }) : null]),
    posts, more,
  ]));
  host.replaceChildren(...sections);

  let start = 0;
  const loadPosts = async (reset) => {
    if (reset) { start = 0; posts.replaceChildren(); }
    more.replaceChildren();
    try {
      const page = await call("posts.list_by_author", { author: urn, sortBy: "CREATED", start, count: 5, ...(admin ? { viewContext: "AUTHOR" } : {}) });
      for (const post of page.elements) posts.append(el("article", { class: "activity-row" }, [
        el("p", { class: "activity-row__meta" }, [el("span", { text: `${org.localizedName} • ${relativeTime(post.publishedAt ?? post.createdAt)}` }), post.lifecycleState === "DRAFT" ? el("span", { class: "badge badge--draft", text: "Draft" }) : null]),
        el("p", { class: "activity-row__text", text: littleTextToPlain(post.commentary) || (post.content?.article?.title ?? "") }),
      ]));
      start += page.elements.length;
      if (start === 0) posts.append(el("p", { class: "profile-activity__empty", text: "This page hasn't posted yet." }));
      if (page.paging.links.some((l) => l.rel === "next")) more.append(el("button", { class: "btn btn--tertiary", text: "Show more posts", attrs: { type: "button" }, on: { click: (e) => busy(e.currentTarget, () => loadPosts(false)) } }));
    } catch (error) {
      posts.append(el("p", { class: "comments__error", attrs: { role: "alert" }, text: describe(error) }));
    }
  };
  void loadPosts(true);
}

async function loadAdmins(list, urn) {
  let start = 0;
  try {
    for (;;) {
      const page = await call("organization_acls.list", { q: "organization", organization: urn, state: "APPROVED", start, count: 20 });
      for (const acl of page.elements) {
        const who = await resolveEntity(acl.roleAssignee);
        list.append(el("li", { class: "company-admins__row" }, [avatar(who.name, acl.roleAssignee, 40), el("div", {}, [el("a", { class: "t-bold link-quiet", text: who.name, attrs: { href: hrefForUrn(acl.roleAssignee) } }), el("div", { class: "muted t-12", text: acl.role.charAt(0) + acl.role.slice(1).toLowerCase().replaceAll("_", " ") })])]));
      }
      start += page.elements.length;
      if (page.elements.length === 0 || !page.paging.links.some((l) => l.rel === "next")) break;
    }
    if (start === 0) list.append(el("li", { class: "muted", text: "No approved admins." }));
  } catch (error) {
    list.append(el("li", { class: "comments__error", attrs: { role: "alert" }, text: describe(error) }));
  }
}
