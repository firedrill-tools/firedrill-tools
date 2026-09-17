// API Keys: list, create (token shown once), delete.
import { refresh, workspace } from "./app.js";
import { icon } from "./icons.js";
import { Cursor, pagerBar, table } from "./list.js";
import { badge, button, call, confirmDialog, copyButton, describe, el, emptyState, errorState, field, guard, modal, mutate, skeletonRows, timeCell, toast } from "./ui.js";

const cursor = new Cursor();
const HEAD = ["Name", "Token", "Permission", "Last used", "Created", ""];

export async function renderApiKeys(_m, view) {
  document.title = "API Keys · Resend (synthetic)";
  const head = el("div", { class: "page-head" }, [el("h1", { text: "API Keys" }), el("div", { class: "head-actions" }, [button("Docs", { iconName: "book", variant: "ghost", attrs: { "data-soon": "Docs" } }), button("Create API Key", { variant: "primary", iconName: "plus", onClick: () => void createKey() })])]);
  if (!view.querySelector(".table-wrap")) view.replaceChildren(head, table(HEAD, skeletonRows(6, 3), "API keys"));
  let list;
  try {
    list = await call("api_keys.list", { limit: 20, ...cursor.args() });
  } catch (error) {
    view.replaceChildren(head, errorState(error, () => void renderApiKeys(_m, view)));
    return;
  }
  if (list.data.length === 0 && cursor.page === 1) {
    view.replaceChildren(head, emptyState("No API keys yet", "Create an API key to authenticate requests to the API.", button("Create API Key", { variant: "primary", iconName: "plus", onClick: () => void createKey() })));
    return;
  }
  const own = workspace.value?.apiKey;
  const body = el("tbody", {}, list.data.map((key) => {
    const more = el("button", { class: "icon-btn", attrs: { type: "button", "aria-label": `Delete API key ${key.name}`, title: "Delete API key" } }, [icon("trash", 15)]);
    more.addEventListener("click", () => void removeKey(key));
    const permission = own && own.id === key.id ? own.permission : null;
    return el("tr", {}, [
      el("td", {}, [el("div", { class: "cell-main" }, [el("span", { class: "tile" }, [icon("key", 15)]), el("span", { text: key.name })])]),
      el("td", { class: "muted mono", text: "re_••••••••••••" }),
      el("td", {}, [permission ? badge(permission, permission === "full_access" ? "Full access" : "Sending access") : el("span", { class: "muted", text: "—", attrs: { title: "Permission is not part of the list response" } })]),
      el("td", { class: "muted" }, [key.last_used_at ? timeCell(key.last_used_at) : el("span", { text: "Never" })]),
      el("td", { class: "muted" }, [timeCell(key.created_at)]),
      el("td", { class: "actions" }, [more]),
    ]);
  }));
  view.replaceChildren(head, table(HEAD, body, "API keys"), pagerBar(cursor, list, () => void renderApiKeys(_m, view), "API keys"));
}

async function domainOptions() {
  const options = [];
  let after;
  for (let page = 0; page < 50; page += 1) {
    const list = await call("domains.list", { limit: 100, ...(after ? { after } : {}) });
    options.push(...list.data);
    if (!list.has_more || list.data.length === 0) break;
    after = list.data[list.data.length - 1].id;
  }
  return options;
}

async function createKey() {
  let domains = [];
  try { domains = await domainOptions(); } catch { domains = []; }
  const created = await modal("Add API Key", (close) => {
    const name = el("input", { class: "input", attrs: { id: "key-name", placeholder: "Your API Key name", maxlength: "50", autocomplete: "off" } });
    const permission = el("select", { class: "select", attrs: { id: "key-permission" } }, [el("option", { text: "Full access", attrs: { value: "full_access" } }), el("option", { text: "Sending access", attrs: { value: "sending_access" } })]);
    const domain = el("select", { class: "select", attrs: { id: "key-domain" } }, [el("option", { text: "All Domains", attrs: { value: "" } }), ...domains.map((d) => el("option", { text: d.name, attrs: { value: d.id } }))]);
    permission.style.width = domain.style.width = "100%";
    const domainField = field("Domain", domain);
    domainField.hidden = true;
    permission.addEventListener("change", () => { domainField.hidden = permission.value !== "sending_access"; });
    const error = el("p", { class: "form-error", attrs: { role: "alert" } });
    const submit = button("Add", { variant: "primary" });
    submit.type = "submit";
    const form = el("form", {}, [field("Name", name), field("Permission", permission), domainField, error, el("div", { class: "dialog-actions" }, [button("Cancel", { onClick: () => close() }), submit])]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      error.textContent = "";
      const args = { name: name.value.trim(), permission: permission.value };
      if (permission.value === "sending_access" && domain.value) args.domainId = domain.value;
      try { close({ ...(await guard(() => mutate("api_keys.create", args))), name: args.name }); } catch (e) { error.textContent = describe(e); submit.disabled = false; }
    });
    return form;
  });
  if (!created) return;
  await refresh();
  await modal("View API Key", (close) => [
    el("p", { class: "dialog-text", text: "You can only see this key once. Store it safely." }),
    el("div", { class: "token-box" }, [el("span", { class: "mono", text: created.token }), copyButton(created.token, "Copy API key")]),
    el("div", { class: "dialog-actions" }, [button("Done", { variant: "primary", onClick: () => close() })]),
  ]);
}

async function removeKey(key) {
  if (!(await confirmDialog("Delete API Key", `Are you sure you want to delete "${key.name}"? Any requests using this key will stop working.`, "Delete API Key"))) return;
  try { await guard(() => mutate("api_keys.remove", { id: key.id })); toast("API key deleted"); await refresh(); } catch (e) { toast(describe(e), { error: true }); }
}
