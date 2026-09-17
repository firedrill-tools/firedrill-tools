// Templates page: list (templates.find), template view (templates.get) and "Use Template" (templates.use).
import { icon } from "./icons.js";
import { dialog, menu, notSimulated, shortDate } from "./overlay.js";
import { pagination, skeletonRows } from "./table.js";
import { app, go, setParams } from "./state.js";
import { button, call, describe, el, newKey, run, toast } from "./ui.js";

const ROLE = { SIGNER: "Signer", APPROVER: "Approver", VIEWER: "Viewer", CC: "CC", ASSISTANT: "Assistant" };

export async function renderTemplates(main, params) {
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const perPage = [10, 20, 30, 40, 50].includes(Number(params.get("perPage"))) ? Number(params.get("perPage")) : 10;
  const ws = app.workspace;
  const host = el("div", {}, skeletonRows(["Created", "Title", "Type", "Actions"]));
  main.replaceChildren(el("div", { class: "container" }, [
    el("div", { class: "folder-row" }, [
      el("nav", { class: "breadcrumb", attrs: { "aria-label": "Folders" } }, [icon("folder"), el("span", { text: "Home" })]),
      el("div", { class: "folder-actions" }, [
        button("Create folder", { variant: "outline", iconName: "folderPlus", onClick: () => notSimulated("Folders") }),
        button("New Template", { iconName: "plus", onClick: () => notSimulated("Creating templates", "Templates are seeded in this world; creating or editing a template is not simulated by this Tool.") }),
      ]),
    ]),
    el("div", { class: "page-heading" }, [el("span", { class: "avatar", text: ws.team.name.slice(0, 1), attrs: { "aria-hidden": "true" } }), el("h1", { text: "Templates" })]),
    host,
  ]));

  async function refresh() {
    try {
      const result = await call("templates.find", { page, perPage });
      if (result.count === 0) {
        host.replaceChildren(el("div", { class: "empty" }, [icon("bird"), el("div", {}, [el("h3", { text: "We're all empty" }), el("p", { text: "You have not yet created any templates. To create a template please upload one." })])]));
        return;
      }
      const body = el("tbody");
      for (const t of result.data) {
        const more = el("button", { class: "more-btn", attrs: { type: "button", "aria-label": `Actions for ${t.title}`, "aria-haspopup": "menu", "aria-expanded": "false" } }, icon("more"));
        more.addEventListener("click", () => menu(more, [
          { heading: "Action" },
          { label: "View", iconName: "eye", onClick: () => viewTemplate(t.id) },
          { label: "Edit", iconName: "edit", onClick: () => notSimulated("Editing templates") },
          { label: "Direct link", iconName: "link", onClick: () => notSimulated("Direct template links") },
          { label: "Move to Team", iconName: "users", onClick: () => notSimulated("Moving templates") },
          { label: "Duplicate", iconName: "copy", onClick: () => notSimulated("Duplicating templates") },
          { label: "Delete", iconName: "trash", onClick: () => notSimulated("Deleting templates") },
        ], { width: 200 }));
        const pub = t.type === "PUBLIC";
        body.append(el("tr", {}, [
          el("td", { text: shortDate(t.createdAt) }),
          el("td", {}, el("button", { class: "cell-title link-like", text: t.title, title: t.title, attrs: { type: "button" }, on: { click: () => viewTemplate(t.id) } })),
          el("td", {}, el("span", { class: `type-badge ${pub ? "type-public" : "type-private"}` }, [icon(pub ? "globe" : "lock"), el("span", { text: pub ? "Public" : "Private" })])),
          el("td", {}, el("div", { class: "cell-actions" }, [button("Use Template", { iconName: "plus", onClick: () => useTemplate(t.id, refresh) }), more])),
        ]));
      }
      const head = el("thead", {}, el("tr", {}, ["Created", "Title", "Type", "Actions"].map((h) => el("th", { text: h }))));
      host.replaceChildren(el("div", { class: "table-wrap" }, el("table", { class: "data" }, [head, body])), pagination(result, (changes) => setParams(changes)));
    } catch (error) {
      if (error?.denied) return app.errorPanel(main, error);
      host.replaceChildren(el("div", { class: "table-wrap" }, el("div", { class: "table-error", attrs: { role: "alert" } }, [el("strong", { text: "Something went wrong" }), el("span", { text: describe(error) })])));
    }
  }
  await refresh();
  return { refresh };
}

async function viewTemplate(id) {
  await run(async () => {
    const t = await call("templates.get", { templateId: id });
    const d = dialog({ title: t.title, description: `${t.type === "PUBLIC" ? "Public" : "Private"} template · created ${shortDate(t.createdAt)} by ${t.user.name}`, wide: true });
    d.body.append(el("div", { class: "label", text: "Recipients" }));
    for (const r of t.recipients) d.body.append(el("div", { class: "link-row" }, [el("div", { class: "grow" }, [el("div", { text: r.email || `Placeholder recipient ${r.id}` }), el("div", { class: "url", text: `${ROLE[r.role] ?? r.role} · ${t.fields.filter((f) => f.recipientId === r.id).length} field(s)` })])]));
    d.body.append(el("pre", { class: "template-preview", text: (t.templateDocumentData.data ?? "").split("\f")[0].slice(0, 2000) }));
    d.footer.append(button("Close", { variant: "secondary", onClick: d.close }), button("Use Template", { iconName: "plus", onClick: () => useTemplate(t.id) }));
  });
}

async function useTemplate(id, onChanged) {
  let t;
  try { t = await call("templates.get", { templateId: id }); } catch (error) { toast(describe(error), { variant: "destructive", title: "Something went wrong" }); return; }
  const d = dialog({ title: "Create document from template", description: "Add the recipients to create the document with.", wide: true });
  const rows = t.recipients.map((r, index) => {
    const email = el("input", { class: "input", attrs: { id: `use-email-${r.id}`, type: "email", value: r.email, placeholder: "Email" } });
    const name = el("input", { class: "input", attrs: { id: `use-name-${r.id}`, value: r.name, placeholder: "Name" } });
    d.body.append(el("div", { class: "form-grid" }, [
      el("div", { class: "form-row" }, [el("label", { class: "label", text: `${ROLE[r.role] ?? r.role} ${index + 1} email`, attrs: { for: `use-email-${r.id}` } }), email]),
      el("div", { class: "form-row" }, [el("label", { class: "label", text: "Name", attrs: { for: `use-name-${r.id}` } }), name]),
    ]));
    return { r, email, name };
  });
  const send = el("input", { attrs: { type: "checkbox", id: "use-send" } });
  d.body.append(el("label", { class: "check", attrs: { for: "use-send" } }, [send, el("span", { text: "Send document" })]),
    el("p", { class: "hint", text: "The document will be immediately sent to recipients if this is checked. Otherwise it is created as a draft." }));
  const key = newKey();
  d.footer.append(button("Close", { variant: "secondary", onClick: d.close }), button("Create as draft", { onClick: () => run(async () => {
    const recipients = rows.map(({ r, email, name }) => ({ id: r.id, email: email.value.trim(), name: name.value.trim() }));
    const created = await call("templates.use", { templateId: t.id, recipients, distributeDocument: send.checked }, key);
    d.close();
    toast(send.checked ? "The document was created and sent to its recipients." : "Your document has been created from the template successfully.", { title: "Document created" });
    go(send.checked ? `#/documents/${created.id}` : `#/documents/${created.id}/edit`);
    await onChanged?.();
  }, { onError: (e) => d.setError(describe(e)) }) }));
  send.addEventListener("change", () => { d.footer.lastChild.lastChild.textContent = send.checked ? "Create and send" : "Create as draft"; });
}
