// Email detail: header, meta, event timeline, Preview / Plain Text / HTML tabs, cancel and reschedule for scheduled emails.
import { refresh } from "./app.js";
import { icon } from "./icons.js";
import { metaItem } from "./view-domains.js";
import { badge, button, call, clock, confirmDialog, copyButton, describe, el, errorState, field, formatDate, guard, labelFor, modal, mutate, toast } from "./ui.js";

const ALLOWED = new Set(["P", "BR", "A", "STRONG", "B", "EM", "I", "U", "H1", "H2", "H3", "H4", "UL", "OL", "LI", "TABLE", "TBODY", "THEAD", "TR", "TD", "TH", "DIV", "SPAN", "SMALL", "HR", "BLOCKQUOTE", "CODE", "PRE"]);

/** Rebuilds an allowlisted, attribute-free DOM from the email HTML; links keep their text and never navigate. */
function previewHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walk = (source, target, depth) => {
    if (depth > 64) return;
    for (const node of source.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) target.append(document.createTextNode(node.textContent));
      else if (node.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED.has(node.tagName)) { if (!["SCRIPT", "STYLE", "HEAD", "TITLE"].includes(node.tagName)) walk(node, target, depth + 1); continue; }
        const copy = document.createElement(node.tagName === "A" ? "span" : node.tagName.toLowerCase());
        if (node.tagName === "A") { copy.className = "fake-link"; copy.title = node.getAttribute("href") ?? ""; }
        walk(node, copy, depth + 1);
        target.append(copy);
      }
    }
  };
  const root = el("div", { class: "email-preview" });
  walk(doc.body, root, 0);
  return root;
}

function timeline(email) {
  const steps = [{ name: "Sent", at: email.created_at, tone: "sent" }];
  if (email.scheduled_at) steps.unshift({ name: "Scheduled", at: email.created_at, tone: "scheduled" }), (steps[1].at = email.scheduled_at);
  const last = email.last_event;
  if (last === "scheduled") steps.pop();
  else if (last === "canceled") steps[steps.length - 1] = { name: "Canceled", at: null, tone: "canceled" };
  else if (last !== "sent" && last !== "queued") steps.push({ name: labelFor(last), at: steps[steps.length - 1].at, tone: last });
  const list = el("ol", { class: "timeline" });
  steps.forEach((s, i) => {
    list.append(el("li", {}, [
      el("span", { class: `dot tone-${s.tone === "delivered" ? "green" : s.tone === "bounced" ? "red" : s.tone === "scheduled" ? "blue" : "gray"}` }, [icon(s.tone === "bounced" ? "alert" : s.tone === "scheduled" ? "clock" : s.tone === "canceled" ? "ban" : s.tone === "delivered" ? "check" : "send", 13)]),
      el("div", {}, [el("strong", { text: s.name }), el("p", { class: "muted", text: s.at ? formatDate(s.at) : "—" })]),
    ]));
    if (i < steps.length - 1) list.append(el("li", { class: "line", attrs: { "aria-hidden": "true" } }));
  });
  return list;
}

export async function renderEmailDetail(id, view) {
  document.title = "Email · Resend (synthetic)";
  const back = el("a", { class: "back", attrs: { href: "#/emails" } }, [icon("chevronLeft", 14), el("span", { text: "Emails" })]);
  let email;
  try {
    email = await call("emails.get", { id });
  } catch (error) {
    view.replaceChildren(back, errorState(error, () => void renderEmailDetail(id, view)));
    return;
  }
  const actions = el("div", { class: "head-actions" });
  if (email.last_event === "scheduled") {
    actions.append(
      button("Cancel", { iconName: "ban", onClick: async () => {
        if (!(await confirmDialog("Cancel scheduled email", "This email will not be sent. You can't undo this action.", "Cancel email"))) return;
        try { await guard(() => mutate("emails.cancel", { id })); toast("Email canceled"); await refresh(); } catch (e) { toast(describe(e), { error: true }); }
      } }),
      button("Reschedule", { iconName: "calendar", variant: "primary", onClick: () => void reschedule(email) }),
    );
  }
  const list = (values) => (values && values.length ? values.join(", ") : "—");
  const meta = el("div", { class: "meta-grid" }, [
    metaItem("From", el("span", { text: email.from })),
    metaItem("Subject", el("span", { text: email.subject })),
    metaItem("To", el("span", { text: list(email.to) })),
    metaItem("ID", el("span", { class: "cell-main" }, [el("span", { class: "mono", text: email.id }), copyButton(email.id, "Copy email ID")])),
  ]);
  const extra = [];
  if (email.cc?.length) extra.push(metaItem("Cc", el("span", { text: list(email.cc) })));
  if (email.bcc?.length) extra.push(metaItem("Bcc", el("span", { text: list(email.bcc) })));
  if (email.reply_to?.length) extra.push(metaItem("Reply-To", el("span", { text: list(email.reply_to) })));
  if (email.tags?.length) extra.push(metaItem("Tags", el("span", { class: "tags" }, email.tags.map((t) => badge("queued", `${t.name}: ${t.value}`)))));
  const panels = {
    preview: () => (email.html ? previewHtml(email.html) : el("pre", { class: "plain", text: email.text ?? "" })),
    text: () => el("pre", { class: "plain", text: email.text ?? "This email has no plain text version." }),
    html: () => el("pre", { class: "plain mono", text: email.html ?? "This email has no HTML version." }),
  };
  const body = el("div", { class: "content-panel" });
  const tabs = el("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Email content" } });
  const select = (name) => {
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    body.replaceChildren(panels[name]());
  };
  for (const [name, label] of [["preview", "Preview"], ["text", "Plain Text"], ["html", "HTML"]]) {
    tabs.append(el("button", { text: label, attrs: { type: "button", role: "tab", "data-tab": name }, on: { click: () => select(name) } }));
  }
  tabs.append(el("button", { text: "Insights", attrs: { type: "button", role: "tab", "aria-selected": "false", "data-soon": "Insights" } }));
  select("preview");
  view.replaceChildren(...[
    back,
    el("div", { class: "detail-head" }, [el("span", { class: "tile lg" }, [icon("mail", 26)]), el("div", { class: "detail-title" }, [el("p", { class: "eyebrow", text: "Email" }), el("h1", { text: email.to[0] ?? "—" })]), actions]),
    meta,
    extra.length ? el("div", { class: "meta-grid" }, extra) : null,
    el("section", { class: "section" }, [el("h2", { text: "Email Events" }), timeline(email)]),
    el("section", { class: "section" }, [tabs, body]),
  ].filter(Boolean));
}

async function reschedule(email) {
  const base = new Date(Math.max(clock.nowMs, Date.parse((email.scheduled_at ?? "").replace(" ", "T").replace(/\+00$/, "Z")) || 0));
  const done = await modal("Reschedule email", (close) => {
    const input = el("input", { class: "input", attrs: { id: "reschedule-at", type: "datetime-local", step: "60" } });
    input.value = base.toISOString().slice(0, 16);
    const error = el("p", { class: "form-error", attrs: { role: "alert" } });
    const submit = button("Reschedule", { variant: "primary" });
    submit.type = "submit";
    const form = el("form", {}, [field("Send at (UTC)", input, "Up to 30 days in the future."), error, el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close() }), submit])]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      try {
        await guard(() => mutate("emails.update", { id: email.id, scheduledAt: `${input.value}:00Z` }));
        close(true);
      } catch (e) { error.textContent = describe(e); submit.disabled = false; }
    });
    return form;
  });
  if (done) { toast("Email rescheduled"); await refresh(); }
}
