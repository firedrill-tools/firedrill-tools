// Share, Move/Copy and Version history dialogs.
import { el, button, call, newKey, describe, toast, formatDate, formatSize, parentOf, serverNow, ToolError } from "./ui.js";
import { modal, field, inlineError, confirmDialog } from "./layer.js";
import { icon, fileGlyph } from "./icons.js";
import { refresh, listAll, S } from "./state.js";
import { downloadEntry } from "./actions.js";

const tagOf = (v) => (typeof v === "string" ? v : v?.[".tag"]);

export async function shareDialog(entry) {
  const m = modal(`Share "${entry.name}"`, { wide: true });
  const invite = field("Invite people", { id: "share-invite", placeholder: "Email or name" });
  invite.input.disabled = true;
  invite.input.title = "Sharing with people is not simulated by this Tool";
  m.body.append(invite.wrap, el("p", { class: "db-modal-sub", text: "Inviting people is not simulated by this Tool. Links below are synthetic and not reachable outside this world." }));
  const section = el("div", { class: "db-share-links" }, [el("p", { class: "db-muted", text: "Loading link…" })]);
  m.body.append(el("h3", { class: "db-h3", text: "Share a link instead" }), section);
  const errors = inlineError(m.body);
  m.footer.append(button("Done", { kind: "primary", onClick: () => m.close() }));

  const render = async () => {
    errors.clear();
    let link = null;
    try {
      const page = await call("sharing.list-shared-links", { path: entry.path_display, direct_only: true });
      link = page.links.find((l) => l.path_lower === entry.path_lower) ?? null;
    } catch (error) {
      section.replaceChildren(el("p", { class: "db-muted", text: describe(error) }));
      return;
    }
    section.replaceChildren(link ? existingLink(link) : createForm());
  };

  const existingLink = (link) => {
    const expired = link.expires && Date.parse(link.expires) <= serverNow();
    const visibility = tagOf(link.link_permissions?.resolved_visibility);
    const row = el("div", { class: "db-linkrow" }, [icon(visibility === "password" ? "lock" : "globe"), el("code", { text: link.url }), expired ? el("span", { class: "db-badge", text: "Expired" }) : null]);
    const copy = button("Copy link", {
      kind: "primary",
      iconName: "link",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(link.url);
          toast("Link copied");
        } catch {
          toast("Copy the link from the field above.");
        }
      },
    });
    const facts = el("ul", { class: "db-facts" }, [
      el("li", { text: visibility === "password" ? "Only people with the password can view" : "Anyone with the link can view" }),
      el("li", { text: link.expires ? `Expires ${formatDate(link.expires)}` : "No expiration" }),
      el("li", { text: link.link_permissions?.allow_download === false ? "Downloads disabled" : "Downloads allowed" }),
    ]);
    const revoke = button("Delete link", {
      kind: "ghost",
      className: "db-danger-text",
      onClick: async () => {
        if (!(await confirmDialog("Delete link?", "People with this link will no longer be able to open it.", "Delete link", { danger: true }))) return;
        try {
          await call("sharing.revoke-shared-link", { url: link.url }, newKey());
          toast("Link deleted");
          S.linksComplete = false;
          refresh();
          render();
        } catch (error) {
          errors.show(describe(error));
        }
      },
    });
    return el("div", {}, [row, facts, el("div", { class: "db-row-gap" }, [copy, revoke])]);
  };

  const createForm = () => {
    const wrap = el("div");
    const vis = el("select", { attrs: { id: "share-visibility" } }, [el("option", { text: "Anyone with the link", attrs: { value: "public" } }), el("option", { text: "Only people with the password", attrs: { value: "password" } })]);
    const visField = el("div", { class: "db-field" }, [el("label", { text: "Who can view", attrs: { for: "share-visibility" } }), vis]);
    const pw = field("Password", { id: "share-password", type: "password" });
    pw.wrap.hidden = true;
    vis.addEventListener("change", () => (pw.wrap.hidden = vis.value !== "password"));
    const expiry = field("Link expiration (optional)", { id: "share-expiry", type: "date" });
    const noDl = el("input", { attrs: { id: "share-nodownload", type: "checkbox" } });
    const dl = el("div", { class: "db-toggle" }, [el("label", { text: "Disable downloads", attrs: { for: "share-nodownload" } }), noDl]);
    let key = newKey();
    const create = button("Create and copy link", {
      kind: "primary",
      iconName: "link",
      onClick: async () => {
        errors.clear();
        const settings = { requested_visibility: vis.value, allow_download: !noDl.checked };
        if (vis.value === "password") settings.link_password = pw.input.value;
        if (expiry.input.value) settings.expires = `${expiry.input.value}T23:59:59Z`;
        create.disabled = true;
        try {
          const link = await call("sharing.create-shared-link-with-settings", { path: entry.path_display, settings }, key);
          try {
            await navigator.clipboard.writeText(link.url);
          } catch {}
          toast("Link created");
          S.linksComplete = false;
          refresh();
          render();
        } catch (error) {
          if (error instanceof ToolError && error.is("SHARED_LINK_ALREADY_EXISTS")) return render();
          errors.show(describe(error));
          if (!(error instanceof ToolError && error.is("INTERNAL_ERROR"))) key = newKey();
        } finally {
          create.disabled = false;
        }
      },
    });
    wrap.append(visField, pw.wrap, expiry.wrap, dl, el("div", { class: "db-row-gap" }, [create]));
    return wrap;
  };
  render();
}

export function moveCopyDialog(entries, mode) {
  const verb = mode === "move" ? "Move" : "Copy";
  const m = modal(entries.length === 1 ? `${verb} "${entries[0].name}" to…` : `${verb} ${entries.length} items to…`, { wide: true });
  const crumbs = el("div", { class: "db-picker-crumbs" });
  const list = el("div", { class: "db-picker", attrs: { role: "listbox", "aria-label": "Folders" } });
  m.body.append(crumbs, list);
  const errors = inlineError(m.body);
  let current = "";
  let autorename = false;
  let key = newKey();
  const blocked = (dest) => entries.some((e) => (e[".tag"] === "folder" && (dest === e.path_lower || dest.startsWith(`${e.path_lower}/`))) || (mode === "move" && parentOf(e.path_lower) === dest));
  const go = async (path) => {
    current = path;
    errors.clear();
    const parts = path ? path.split("/").slice(1) : [];
    crumbs.replaceChildren(el("button", { class: "db-crumb small", text: "Dropbox", attrs: { type: "button" } }));
    crumbs.firstChild.addEventListener("click", () => go(""));
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      const target = acc;
      const b = el("button", { class: "db-crumb small", text: part, attrs: { type: "button" } });
      b.addEventListener("click", () => go(target));
      crumbs.append(icon("caretRight"), b);
    }
    list.replaceChildren(el("p", { class: "db-muted", text: "Loading…" }));
    try {
      const folders = (await listAll(path)).filter((e) => e[".tag"] === "folder").sort((a, b) => a.name.localeCompare(b.name));
      list.replaceChildren(...folders.map((f) => {
        const row = el("button", { class: "db-picker-row", attrs: { type: "button", role: "option" } }, [fileGlyph("folder", "", 24), el("span", { text: f.name })]);
        row.addEventListener("click", () => go(f.path_display));
        return row;
      }));
      if (!folders.length) list.append(el("p", { class: "db-muted", text: "No folders here" }));
    } catch (error) {
      list.replaceChildren(el("p", { class: "db-muted", text: describe(error) }));
    }
    submit.disabled = blocked(current.toLowerCase());
  };
  const submit = button(verb, {
    kind: "primary",
    onClick: async () => {
      errors.clear();
      submit.disabled = true;
      let done = 0;
      try {
        for (const e of entries) {
          await call(mode === "move" ? "files.move" : "files.copy", { from_path: e.path_display, to_path: `${current}/${e.name}`, autorename }, entries.length === 1 ? key : newKey());
          done += 1;
        }
        toast(`${mode === "move" ? "Moved" : "Copied"} ${entries.length === 1 ? `"${entries[0].name}"` : `${done} items`} to ${current ? current.split("/").pop() : "Dropbox"}`);
        m.close();
      } catch (error) {
        errors.show(describe(error));
        keepBoth.hidden = !(error instanceof ToolError && error.is("CONFLICT"));
        key = newKey();
        submit.disabled = false;
      } finally {
        if (done) refresh();
      }
    },
  });
  const keepBoth = button("Keep both", { onClick: () => { autorename = true; submit.click(); } });
  keepBoth.hidden = true;
  const newFolder = button("Create folder", {
    iconName: "newFolder",
    kind: "ghost",
    onClick: () => {
      if (m.body.querySelector("#picker-new-folder")) return m.body.querySelector("#picker-new-folder").focus();
      const input = el("input", { attrs: { id: "picker-new-folder", type: "text", placeholder: "Folder name", "aria-label": "New folder name" } });
      const row = el("div", { class: "db-picker-new" }, [fileGlyph("folder", "", 24), input]);
      list.prepend(row);
      input.focus();
      input.addEventListener("keydown", async (e) => {
        if (e.key === "Escape") { e.stopPropagation(); row.remove(); return; }
        if (e.key !== "Enter" || !input.value.trim()) return;
        e.preventDefault();
        try {
          await call("files.create-folder", { path: `${current}/${input.value.trim()}` }, newKey());
          go(current);
        } catch (error) {
          errors.show(describe(error));
        }
      });
    },
  });
  m.footer.append(el("span", { class: "spacer" }), newFolder, keepBoth, button("Cancel", { onClick: () => m.close() }), submit);
  newFolder.classList.add("db-foot-left");
  go("");
}

export async function versionsDialog(entry) {
  const m = modal(`Version history`, { wide: true });
  m.body.append(el("p", { class: "db-modal-sub", text: entry.path_display }));
  const list = el("ul", { class: "db-versions" }, [el("li", { class: "db-muted", text: "Loading…" })]);
  m.body.append(list);
  const errors = inlineError(m.body);
  m.footer.append(button("Close", { kind: "primary", onClick: () => m.close() }));
  try {
    const result = await call("files.list-revisions", { path: entry.path_display, limit: 100 });
    const versions = result.entries;
    list.replaceChildren(...versions.map((v, i) => {
      const actions = el("div", { class: "db-row-gap" });
      actions.append(button("Download", { kind: "ghost", onClick: () => downloadEntry(v, v.rev) }));
      if (i > 0 || result.is_deleted) {
        actions.append(button("Restore", {
          onClick: async () => {
            if (!(await confirmDialog("Restore this version?", `"${v.name}" will be restored to the version from ${formatDate(v.server_modified)}.`, "Restore"))) return;
            try {
              await call("files.restore", { path: v.path_display, rev: v.rev }, newKey());
              toast("Version restored");
              m.close();
              refresh();
            } catch (error) {
              errors.show(describe(error));
            }
          },
        }));
      }
      return el("li", {}, [el("div", {}, [el("strong", { text: formatDate(v.server_modified) }), el("span", { class: "db-muted", text: ` · ${formatSize(v.size)}` }), i === 0 && !result.is_deleted ? el("span", { class: "db-badge ok", text: "Current version" }) : null]), actions]);
    }));
  } catch (error) {
    list.replaceChildren(el("li", { class: "db-muted", text: describe(error) }));
  }
}
