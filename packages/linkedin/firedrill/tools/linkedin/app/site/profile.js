// Profile (/in/{id}): top card, contact info, and the Activity card with posts and drafts (own profile).
import { el, call, describe, avatar, newKey, toast, busy, relativeTime } from "./ui.js";
import { icon } from "./icons.js";
import { session, rememberPerson } from "./store.js";
import { littleTextToPlain } from "./text.js";
import { openModal, confirmDialog } from "./overlay.js";
import { openComposer } from "./composer.js";
import { footer } from "./feed.js";

const PAGE = 5;

export function renderProfile(main, personId) {
  const self = session.viewer.personUrn === `urn:li:person:${personId}`;
  const top = el("section", { class: "card profile-top", attrs: { "aria-busy": "true" } }, el("div", { class: "profile-top__loading" }, el("span", { class: "spinner", attrs: { "aria-label": "Loading profile" } })));
  const activity = el("section", { class: "card profile-activity" });
  main.replaceChildren(el("div", { class: "profile-layout" }, [el("div", { class: "profile-main" }, [top, activity]), el("aside", { class: "profile-aside" }, [
    el("div", { class: "card aside-card" }, [el("h2", { class: "aside-card__title", text: "Profile language" }), el("p", { class: "muted", text: "English" })]),
    el("div", { class: "card aside-card" }, [el("h2", { class: "aside-card__title", text: "Public profile & URL" }), el("p", { class: "muted", text: "Custom profile URLs aren't simulated." })]),
    footer(),
  ])]));

  const load = async () => {
    try {
      const person = self ? await call("profile.me") : await call("people.get", { personId });
      rememberPerson(person);
      paintTop(top, person, self);
      if (self) paintActivity(activity, person, load); else paintOther(activity, person);
    } catch (error) {
      top.removeAttribute("aria-busy");
      top.replaceChildren(el("div", { class: "state-card", attrs: { role: "alert" } }, [
        el("h1", { class: "state-card__title", text: error.code === "NOT_FOUND" ? "This profile is not available" : "Couldn't load this profile" }),
        el("p", { class: "state-card__text", text: describe(error) }),
        el("a", { class: "btn btn--secondary", text: "Go to your feed", attrs: { href: "#/feed" } }),
      ]));
      activity.hidden = true;
    }
  };
  void load();
  return { refresh: load };
}

function paintTop(top, person, self) {
  const name = `${person.localizedFirstName} ${person.localizedLastName}`.trim();
  top.removeAttribute("aria-busy");
  const actions = self
    ? [el("button", { class: "btn btn--primary btn--sm", text: "Open to", attrs: { type: "button", "data-not-simulated": "Open to work" } }), el("button", { class: "btn btn--secondary btn--sm", text: "Add profile section", attrs: { type: "button", "data-not-simulated": "Profile sections" } }), el("button", { class: "btn btn--muted btn--sm", text: "Resources", attrs: { type: "button", "data-not-simulated": "Profile resources" } })]
    : [el("button", { class: "btn btn--primary btn--sm", attrs: { type: "button", "data-not-simulated": "Messaging" } }, [icon("send"), el("span", { text: "Message" })]), el("button", { class: "btn btn--muted btn--sm", text: "More", attrs: { type: "button", "data-not-simulated": "Profile actions" } })];
  const contact = el("button", { class: "profile-top__contact", text: "Contact info", attrs: { type: "button" }, on: { click: () => showContact(name, person, self) } });
  top.replaceChildren(
    el("div", { class: "profile-top__cover", attrs: { "aria-hidden": "true" } }),
    el("div", { class: "profile-top__body" }, [
      el("div", { class: "profile-top__avatar" }, avatar(name, `urn:li:person:${person.id}`, 152)),
      self ? el("button", { class: "icon-btn profile-top__edit", title: "Edit intro", attrs: { type: "button", "aria-label": "Edit intro", "data-not-simulated": "Editing your profile intro" } }, icon("pencil")) : null,
      el("h1", { class: "profile-top__name", text: name }),
      person.localizedHeadline ? el("p", { class: "profile-top__headline", text: person.localizedHeadline }) : null,
      el("p", { class: "profile-top__meta" }, [contact]),
      el("p", { class: "profile-top__connections" }, self
        ? el("a", { text: `${session.viewer.connectionCount} connection${session.viewer.connectionCount === 1 ? "" : "s"}`, attrs: { href: "#/mynetwork" } })
        : el("span", { class: "muted", text: "1st degree connection" })),
      el("div", { class: "profile-top__actions" }, actions),
    ]),
  );
}

async function showContact(name, person, self) {
  const modal = openModal({ title: name });
  modal.body.append(el("h3", { class: "contact__title", text: "Contact Info" }), el("div", { class: "contact__row" }, [icon("nav-home"), el("div", {}, [el("div", { class: "t-bold", text: "Your Profile" }), el("span", { class: "muted", text: `linkedin.com/in/${person.vanityName}` })])]));
  if (!self) return;
  try {
    const info = await call("profile.userinfo");
    if (info.email) modal.body.append(el("div", { class: "contact__row" }, [icon("nav-messaging"), el("div", {}, [el("div", { class: "t-bold", text: "Email" }), el("span", { class: "muted", text: info.email })])]));
    else modal.body.append(el("p", { class: "muted", text: "No e-mail address is shared with this app." }));
  } catch (error) {
    modal.body.append(el("p", { class: "comments__error", attrs: { role: "alert" }, text: describe(error) }));
  }
}

function paintOther(activity, person) {
  activity.hidden = false;
  activity.replaceChildren(el("div", { class: "section-head" }, el("h2", { class: "section-head__title", text: "Activity" })), el("p", { class: "profile-activity__empty", text: `${person.localizedFirstName}'s posts appear in your feed when they share them with you.` }));
}

function paintActivity(activity, person, reload) {
  const personUrn = `urn:li:person:${person.id}`;
  let tab = "PUBLISHED";
  const list = el("div", { class: "activity-list" });
  const more = el("div", { class: "activity-more" });
  const tabButtons = [["PUBLISHED", "Posts"], ["DRAFT", "Drafts"]].map(([key, label]) => el("button", { class: "chip", text: label, attrs: { type: "button", "aria-pressed": String(key === tab) }, on: { click: () => { tab = key; tabButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === label))); void load(true); } } }));
  let start = 0;
  let collected = 0;

  const load = async (reset) => {
    if (reset) { start = 0; collected = 0; list.replaceChildren(el("span", { class: "spinner", attrs: { "aria-label": "Loading activity" } })); }
    more.replaceChildren();
    try {
      // Drafts and posts share one author listing; page until a screenful of the chosen state or the end.
      let shown = 0;
      let done = false;
      if (reset) list.replaceChildren();
      while (shown < PAGE && !done) {
        const page = await call("posts.list_by_author", { author: personUrn, viewContext: "AUTHOR", sortBy: "LAST_MODIFIED", start, count: 10 });
        start += page.elements.length;
        done = page.elements.length === 0 || !page.paging.links.some((l) => l.rel === "next");
        for (const post of page.elements.filter((p) => p.lifecycleState === tab)) { list.append(activityRow(post, reload)); shown += 1; collected += 1; }
      }
      if (collected === 0) list.append(el("p", { class: "profile-activity__empty", text: tab === "DRAFT" ? "You have no drafts." : "You haven't posted yet. Posts you share will be displayed here." }));
      if (!done) more.append(el("button", { class: "btn btn--tertiary", text: tab === "DRAFT" ? "Show more drafts" : "Show more posts", attrs: { type: "button" }, on: { click: (e) => busy(e.currentTarget, () => load(false)) } }));
    } catch (error) {
      if (reset) list.replaceChildren();
      list.append(el("p", { class: "comments__error", attrs: { role: "alert" }, text: describe(error) }));
    }
  };

  activity.hidden = false;
  activity.replaceChildren(
    el("div", { class: "section-head" }, [el("div", {}, [el("h2", { class: "section-head__title", text: "Activity" }), el("a", { class: "section-head__sub", text: `${session.viewer.connectionCount} connections`, attrs: { href: "#/mynetwork" } })]), el("button", { class: "btn btn--secondary btn--sm", text: "Create a post", attrs: { type: "button" }, on: { click: () => openComposer({ onDone: () => load(true) }) } })]),
    el("div", { class: "chips", attrs: { role: "group", "aria-label": "Activity type" } }, tabButtons),
    list, more,
  );
  void load(true);
}

function activityRow(post, reload) {
  const draft = post.lifecycleState === "DRAFT";
  const row = el("article", { class: "activity-row" }, [
    el("p", { class: "activity-row__meta" }, [el("span", { text: `${session.viewer.name} ${draft ? "saved a draft" : "posted this"} • ${relativeTime(post.lastModifiedAt)}` }), draft ? el("span", { class: "badge badge--draft", text: "Draft" }) : null]),
    el("p", { class: "activity-row__text", text: littleTextToPlain(post.commentary) || (post.content?.article?.title ?? "") }),
  ]);
  if (draft) {
    const publish = el("button", { class: "btn btn--primary btn--sm", text: "Publish", attrs: { type: "button" } });
    publish.addEventListener("click", () => busy(publish, async () => {
      if (!(await confirmDialog({ title: "Publish draft?", message: "This draft will be posted and shown to your network.", confirmLabel: "Publish" }))) return;
      try { await call("posts.update", { postUrn: post.id, lifecycleState: "PUBLISHED" }, newKey()); toast("Post successful."); await reload(); }
      catch (error) { toast(describe(error), { error: true }); }
    }));
    row.append(el("div", { class: "activity-row__actions" }, publish));
  }
  return row;
}
