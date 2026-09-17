// Workplaces: the company's addresses, which decide the state taxes applied to an earning line.
import { btn, call, describe, el, newKey, openModal, toast } from "./ui.js";
import { addressLine, day, field, input, pill, select, showFieldError, stamp } from "./fmt.js";
import { banner, emptyState, listPage, skeletonCard, state } from "./store.js";
import { go, render, setTitle } from "./app.js";

const STATES = ["CA", "NY", "OR"];

export async function renderWorkplaces(host, route, { isCurrent }) {
  setTitle("Workplaces");
  const cursor = route.params.cursor;
  host.replaceChildren(el("div", { class: "page-inner" }, [head(), skeletonCard(4)]));
  let page;
  try {
    page = await listPage("workplaces.list", state.company ? { company: state.company } : {}, cursor, 25);
  } catch (error) {
    if (!isCurrent()) return;
    host.replaceChildren(el("div", { class: "page-inner" }, [head(), banner("error", describe(error), btn("Retry", "secondary", { small: true, onClick: () => void render() }))]));
    return;
  }
  if (!isCurrent()) return;
  const body = [head()];
  if (page.rows.length === 0) {
    body.push(emptyState("No workplaces", "A company needs at least one workplace before employees can be paid from it.",
      btn("Add workplace", "primary", { icon: "plus", onClick: () => workplaceDialog() })));
  } else {
    body.push(el("div", { class: "card" }, el("div", { class: "table-wrap" }, el("table", { class: "tbl" }, [
      el("thead", {}, el("tr", {}, [
        el("th", { text: "Workplace" }), el("th", { text: "Address" }), el("th", { text: "State" }),
        el("th", { text: "Added" }), el("th", { text: "Status" }),
      ])),
      el("tbody", {}, page.rows.map((workplace) => el("tr", {}, [
        el("td", {}, [el("span", { class: "strong", text: workplace.name || workplace.id }), el("span", { class: "sub mono", text: workplace.id })]),
        el("td", { text: addressLine(workplace.address) }),
        el("td", { text: workplace.address?.state ?? "—" }),
        el("td", { text: workplace.created_at ? stamp(workplace.created_at, { time: false }) : "—" }),
        el("td", {}, pill(workplace.active ? "active" : "inactive", workplace.active ? "Active" : "Inactive")),
      ]))),
    ]))));
    body.push(el("div", { class: "card-foot card-foot-attached" }, [
      el("span", { class: "pager-info", text: `${page.rows.length} on this page` }),
      el("div", { class: "pager" }, [
        btn("Previous", "secondary", { small: true, icon: "chevronLeft", disabled: !cursor, onClick: () => go("workplaces") }),
        btn("Next", "secondary", { small: true, disabled: !page.next, onClick: () => go("workplaces", undefined, { cursor: page.next }) }),
      ]),
    ]));
  }
  host.replaceChildren(el("div", { class: "page-inner" }, body));
}

function head() {
  return el("div", { class: "page-head" }, [
    el("div", {}, [
      el("h2", { text: "Workplaces" }),
      el("p", { text: "Each earning line is attributed to a workplace, which decides the state taxes withheld." }),
    ]),
    el("div", { class: "spacer" }),
    el("div", { class: "head-actions" }, btn("Add workplace", "primary", { icon: "plus", disabled: !state.company, onClick: () => workplaceDialog() })),
  ]);
}

function workplaceDialog() {
  const form = el("form", { class: "form-grid", attrs: { novalidate: "" } });
  const name = input("name", "", { maxlength: "80" });
  const line1 = input("line1", "", { maxlength: "120" });
  const line2 = input("line2", "", { maxlength: "120" });
  const city = input("city", "", { maxlength: "60" });
  const stateSel = select("state", STATES.map((s) => [s, s]), "CA");
  const postal = input("postal_code", "", { maxlength: "10", inputmode: "numeric" });
  form.append(
    field("Workplace name", name, { name: "name", full: true }),
    field("Street address", line1, { name: "line1", full: true }),
    field("Suite, floor", line2, { name: "line2", full: true }),
    field("City", city, { name: "city" }),
    field("State", stateSel, { name: "state", hint: "This Tool models California, New York and Oregon." }),
    field("ZIP code", postal, { name: "postal_code" }),
  );
  const save = btn("Add workplace", "primary", { onClick: () => void submit() });
  const modal = openModal({
    title: "New workplace",
    subtitle: "Workplaces belong to the company selected in the sidebar.",
    body: form,
    wide: true,
    actions: [btn("Cancel", "secondary", { onClick: () => modal.close() }), save],
    onClose: () => { state.editing = Math.max(0, state.editing - 1); },
  });
  state.editing += 1;

  async function submit() {
    if (name.value.trim() === "") { showFieldError(form, "name", "Required."); return; }
    save.disabled = true;
    try {
      await call("workplaces.create", {
        company: state.company,
        name: name.value.trim(),
        address: {
          line1: line1.value.trim(),
          line2: line2.value.trim() === "" ? null : line2.value.trim(),
          city: city.value.trim(),
          state: stateSel.value,
          postal_code: postal.value.trim(),
          country: "US",
        },
      }, newKey());
      modal.close();
      toast("Workplace added.");
      await render();
    } catch (error) {
      if (!showFieldError(form, error, describe(error))) toast(describe(error), { error: true });
    } finally {
      save.disabled = false;
    }
  }
}
