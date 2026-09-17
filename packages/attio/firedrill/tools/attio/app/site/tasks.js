// Tasks page: assigned-to-me / all / completed, grouped by due date against world virtual time.
import { icon } from "./icons.js";
import { loadNames, resolveNames, store } from "./store.js";
import { call, el } from "./ui.js";
import { errorState, nsButton, pageHeader, stateBox } from "./shell.js";
import { taskComposer, taskGroup, taskRow } from "./taskrow.js";

const PAGE = 50;
const ORDER = ["Overdue", "Today", "Upcoming", "No due date", "Completed"];
let tab = "mine";

export async function renderTasks(main, { alive }) {
  const header = pageHeader([{ label: "Tasks", leading: icon("tasks") }], [nsButton("Task settings", "Task notifications and reminders are not simulated.", { icon: "settings", iconOnly: true, class: "ghost" })]);
  const seg = el("div", { class: "at-seg", attrs: { role: "group", "aria-label": "Task view" } });
  for (const [id, label] of [["mine", "Assigned to me"], ["all", "All tasks"], ["done", "Completed"]]) {
    const b = el("button", { text: label, attrs: { type: "button", "aria-pressed": String(tab === id) } });
    b.addEventListener("click", () => { tab = id; void renderTasks(main, { alive }); });
    seg.append(b);
  }
  const viewbar = el("div", { class: "at-viewbar" }, [seg, el("span", { class: "grow" })]);
  const composer = taskComposer(() => void load());
  const body = el("div", { class: "at-page-scroll" });
  main.replaceChildren(header, viewbar, composer.form, body);

  let tasks = [];
  let offset = 0;
  let hasMore = false;

  async function fetchPage(reset) {
    if (reset) { tasks = []; offset = 0; }
    const args = { limit: PAGE, offset, sort: tab === "done" ? "completed_at:desc" : "created_at:asc", is_completed: tab === "done" };
    if (tab === "mine") args.assignee = store.self.authorized_by_workspace_member_id;
    const page = (await call("tasks.list", args)).data;
    tasks.push(...page);
    offset += page.length;
    hasMore = page.length === PAGE;
  }

  async function load(reset = true) {
    if (reset) body.replaceChildren(el("div", { class: "at-state" }, el("span", { class: "at-skel" })));
    try {
      await Promise.all([fetchPage(reset), loadNames()]);
      await resolveNames(tasks);
      if (!alive()) return;
      draw();
    } catch (error) {
      if (alive()) body.replaceChildren(errorState(error, () => void load()));
    }
  }

  function draw() {
    body.replaceChildren();
    if (tasks.length === 0) {
      body.append(stateBox({ iconName: "circleCheck", title: tab === "done" ? "No completed tasks" : "No tasks", text: tab === "done" ? "Tasks you complete will show up here." : "You're all caught up. Add a task above to keep track of your work." }));
      return;
    }
    const groups = new Map();
    for (const t of tasks) {
      const g = taskGroup(t);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    for (const name of ORDER) {
      const items = groups.get(name);
      if (!items) continue;
      if (name !== "Completed") items.sort((a, b) => String(a.deadline_at ?? "").localeCompare(String(b.deadline_at ?? "")));
      const section = el("section", { class: "at-task-group", attrs: { "aria-label": name } }, el("div", { class: "at-task-group-head" }, [el("span", { text: name }), el("span", { class: "at-col-count", text: String(items.length) })]));
      for (const t of items) section.append(taskRow(t, () => void load()));
      body.append(section);
    }
    if (hasMore) {
      const more = el("button", { class: "at-col-add", text: "Load more tasks", attrs: { type: "button" } });
      more.addEventListener("click", () => void load(false));
      body.append(more);
    }
  }

  await load();
  return { unsaved: composer.unsaved };
}
