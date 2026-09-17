// Google Calendar Tool app: a Google Calendar-shaped browser client over the Tool's own operations.
// Every list, popover, editor and settings screen calls the same operations an agent calls through
// HTTP/MCP; nothing here is static data and nothing leaves the local Firedrill world.
import { getContext } from "/_firedrill/client.js";
import { icon, mountIcons } from "./icons.js";
import * as T from "./time.js";
import { displayColor, colorName, notSimulated, mountChrome } from "./chrome.js";
import { $, $$, el, iconButton, textButton, call, key, action, snackbar, hideSnackbar, openMenu, closeMenus, confirmDialog, watchWorld, describe, readPreference, writePreference, avatar, ToolError, isPending, onBusy } from "./ui.js";

const HOUR_PX = 48;
const VIEWS = { day: "Day", week: "Week", month: "Month", year: "Year", schedule: "Schedule", "4days": "4 days" };
const VIEW_KEYS = { day: "D", week: "W", month: "M", year: "Y", schedule: "A", "4days": "X" };
const RESPONSE_LABEL = { accepted: "Yes", declined: "No", tentative: "Maybe", needsAction: "Awaiting" };
const EVENT_TYPE_LABEL = { focusTime: "Focus time", outOfOffice: "Out of office", workingLocation: "Working location", birthday: "Birthday" };
const REMINDER_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 1440];
const ROLE_LABEL = { owner: "Owner", writer: "Make changes to events", reader: "See all event details", freeBusyReader: "See only free/busy" };
const FALLBACK_COLOR = "#039be5";

const state = {
  context: null,
  user: { email: "", name: "", primaryId: "primary" },
  settings: { timezone: "UTC", weekStart: 0, h24: false, defaultLength: 60, hideWeekends: false, locale: "en", showDeclined: true },
  showWeekends: true,
  showDeclined: true,
  now: null,
  route: { view: "week", date: null },
  calendars: [],
  colors: null,
  events: [],
  loadedRange: null,
  loading: 0,
  banner: null,
  denied: false,
  bootError: null,
  search: { query: "", items: [], nextPageToken: undefined, loading: false, error: null },
  popover: null,
  quick: null,
  editor: null,
  stale: false,
  miniMonth: null,
  scrolledOnce: false,
};

const zone = () => state.settings.timezone;
const h24 = () => state.settings.h24;
/**
 * "Today" in the user's zone, from the world's virtual time. Before it is known (or when every time-bearing read is
 * denied) the routed date or the epoch day keeps rendering deterministic; the browser clock is never consulted.
 */
const todayKey = () => state.now?.key ?? state.route.date ?? T.partsKey(T.wallOf(zone(), 0));
const locale = () => state.settings.locale;

/** The app's "now" from an RFC 3339 `serverTime` (UTC) rendered in the user's zone. */
function worldNow(serverTime) {
  const utcMs = Date.parse(String(serverTime ?? ""));
  if (Number.isNaN(utcMs)) return null;
  const parts = T.wallOf(zone(), utcMs);
  const key = T.partsKey(parts);
  const minutes = T.minutesOf(parts);
  return { key, minutes, dateTime: T.rfc3339(zone(), key, minutes), utc: serverTime };
}

const navigate = (hash) => {
  if (location.hash === hash) {
    onRoute();
    return;
  }
  location.hash = hash;
};

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
  mountIcons();
  bindHeader();
  bindSidebar();
  bindKeyboard();
  mountChrome();
  onBusy((busy) => {
    $("#loading").hidden = !(busy || state.loading > 0);
  });
  if (window.innerWidth < 900) document.getElementById("app").classList.add("sidebar-closed");
  $("#menu-toggle").setAttribute("aria-expanded", String(!document.getElementById("app").classList.contains("sidebar-closed")));
  state.showWeekends = readPreference("weekends", "") === "" ? undefined : readPreference("weekends") === "true";
  state.showDeclined = readPreference("declined", "") === "" ? undefined : readPreference("declined") === "true";
  try {
    state.context = await getContext();
  } catch (error) {
    state.bootError = error?.message ?? String(error);
    render();
    return;
  }
  window.addEventListener("hashchange", onRoute);
  watchWorld(refresh, () => state.editor === null && state.quick === null, (context) => {
    state.context = context;
  });
}

async function refresh(first) {
  if (first || state.denied) await loadIdentity();
  if (state.route.date === null) parseRoute();
  render();
  state.loadedRange = null;
  await loadForRoute();
  if (state.popover) void reloadPopover();
  if (state.route.view === "search") await runSearch(state.route.query ?? "");
  state.stale = false;
}

async function loadIdentity() {
  state.denied = false;
  state.loading += 1;
  $("#loading").hidden = false;
  let now = null;
  try {
    try {
      const settings = await call("settings.list");
      const values = Object.fromEntries(settings.items.map((item) => [item.id, item.value]));
      state.settings = {
        timezone: T.SUPPORTED_ZONES.includes(values.timezone) ? values.timezone : "UTC",
        weekStart: Number(values.weekStart ?? 0) || 0,
        h24: values.format24HourTime === "true",
        defaultLength: Number(values.defaultEventLength) || 60,
        hideWeekends: values.hideWeekends === "true",
        locale: values.locale ?? "en",
        showDeclined: values.showDeclinedEvents !== "false",
      };
      now = worldNow(settings.serverTime);
    } catch (error) {
      if (!(error instanceof ToolError && error.denied)) throw error;
    }
    if (state.showWeekends === undefined) state.showWeekends = !state.settings.hideWeekends;
    if (state.showDeclined === undefined) state.showDeclined = state.settings.showDeclined;
    try {
      const listed = await listAllCalendars();
      state.calendars = listed.calendars;
      if (now === null) now = worldNow(listed.serverTime);
    } catch (error) {
      if (error instanceof ToolError && error.denied) {
        state.denied = true;
        state.calendars = [];
      } else throw error;
    }
    const primary = state.calendars.find((calendar) => calendar.primary) ?? state.calendars[0];
    state.user = { email: primary?.id ?? `${state.context.actorId}@example.test`, name: primary?.summary ?? state.context.actorId, primaryId: primary?.id ?? "primary" };
    try {
      state.colors = await call("colors.get");
    } catch {
      state.colors = null;
    }
  } catch (error) {
    state.banner = { text: describe(error), retry: () => refresh(true) };
  } finally {
    if (now !== null) state.now = now;
    state.loading -= 1;
    $("#loading").hidden = state.loading === 0 && !isPending();
  }
  renderIdentity();
}

/** Every calendar-list entry plus the world's virtual now that the first page carries. */
async function listAllCalendars() {
  const calendars = [];
  let pageToken;
  let serverTime;
  for (let page = 0; page < 20; page += 1) {
    const result = await call("calendar-list.list", { showHidden: true, pageSize: 250, ...(pageToken ? { pageToken } : {}) });
    calendars.push(...result.calendars);
    serverTime ??= result.serverTime;
    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }
  return { calendars, serverTime };
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

const validKey = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? value : null);

/** Decode one location-hash component; a malformed escape (e.g. `%E0%A4%A`) is kept verbatim instead of throwing. */
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = hash.split("/");
  const previous = state.route;
  const route = { view: readPreference("view", "week"), date: previous.date ?? todayKey() };
  if (!VIEWS[route.view]) route.view = "week";
  switch (head) {
    case "day":
    case "week":
    case "month":
    case "year":
    case "schedule":
    case "4days":
      route.view = head;
      route.date = validKey(rest[0]) ?? todayKey();
      writePreference("view", head);
      break;
    case "search":
      route.view = "search";
      route.query = safeDecode(rest.join("/"));
      break;
    case "settings":
      route.view = "settings";
      route.section = rest.length > 0 ? safeDecode(rest.join("/")) : "general";
      break;
    case "edit":
      route.view = "edit";
      route.calendarId = safeDecode(rest[0] ?? "");
      route.eventId = safeDecode(rest[1] ?? "");
      break;
    case "new":
      route.view = "new";
      break;
    default:
      break;
  }
  if (route.view !== "edit" && route.view !== "new" && state.editor !== null) state.editor = null;
  state.route = route;
  state.miniMonth = T.firstOfMonth(route.date);
}

function onRoute() {
  parseRoute();
  closePopover();
  closeQuick();
  closeMenus();
  render();
  void loadForRoute();
  if (state.route.view === "search" && state.now !== null) void runSearch(state.route.query ?? "");
}

function calendarView() {
  return VIEWS[state.route.view] ? state.route.view : readPreference("view", "week");
}

/** [startKey, endKey) of the visible calendar range. */
function rangeOf(route = state.route) {
  const date = route.date ?? todayKey();
  switch (VIEWS[route.view] ? route.view : "week") {
    case "day":
      return { start: date, end: T.addDays(date, 1) };
    case "month": {
      const rows = T.monthGrid(date, state.settings.weekStart);
      return { start: rows[0][0], end: T.addDays(rows[5][6], 1) };
    }
    case "schedule":
      return { start: date, end: T.addDays(date, 28) };
    case "4days":
      return { start: date, end: T.addDays(date, 4) };
    case "year": {
      const start = `${T.parseKey(date).y}-01-01`;
      return { start, end: T.addMonths(start, 12) };
    }
    default: {
      const start = T.startOfWeek(date, state.settings.weekStart);
      return { start, end: T.addDays(start, 7) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Events for the visible range
// ---------------------------------------------------------------------------------------------

async function loadForRoute() {
  if (state.denied || state.context === null || state.now === null) return;
  if (!VIEWS[state.route.view] && state.route.view !== "edit" && state.route.view !== "new") return;
  if (state.route.view === "year") return; // the year view shows dates only, as the web client does
  const range = rangeOf(VIEWS[state.route.view] ? state.route : { view: calendarView(), date: state.route.date });
  const selected = state.calendars.filter((calendar) => calendar.selected && !calendar.hidden).map((calendar) => calendar.id);
  const stamp = `${range.start}|${range.end}|${selected.join(",")}`;
  if (state.loadedRange === stamp) return;
  state.loadedRange = stamp;
  state.loading += 1;
  $("#loading").hidden = false;
  const errors = [];
  const instances = [];
  const startTime = T.rfc3339(zone(), range.start, 0);
  const endTime = T.rfc3339(zone(), range.end, 0);
  await Promise.all(
    state.calendars
      .filter((calendar) => selected.includes(calendar.id))
      .map(async (calendar) => {
        try {
          if (calendar.accessRole === "freeBusyReader") {
            const result = await call("freebusy.query", { timeMin: startTime, timeMax: endTime, timeZone: zone(), items: [{ id: calendar.id }] });
            for (const block of result.calendars[calendar.id]?.busy ?? []) instances.push(busyInstance(calendar, block));
            return;
          }
          let pageToken;
          for (let page = 0; page < 40; page += 1) {
            const result = await call("events.list", { calendarId: calendar.id, startTime, endTime, singleEvents: true, orderBy: "startTime", timeZone: zone(), pageSize: 250, ...(pageToken ? { pageToken } : {}) });
            for (const event of result.events) instances.push(...instancesOf(event, calendar));
            pageToken = result.nextPageToken;
            if (!pageToken) break;
          }
        } catch (error) {
          if (error instanceof ToolError && (error.is("REQUIRED_ACCESS_LEVEL") || error.is("NOT_FOUND"))) return;
          errors.push({ calendar, error });
        }
      }),
  );
  if (state.loadedRange !== stamp) {
    state.loading -= 1;
    return;
  }
  state.events = instances;
  if (errors.length > 0) {
    const first = errors[0].error;
    state.banner = {
      text: first instanceof ToolError && first.denied ? "This account can't read events (no events.list grant). Showing an empty calendar." : describe(first),
      retry: () => {
        state.loadedRange = null;
        return loadForRoute();
      },
    };
  } else state.banner = null;
  state.loading -= 1;
  $("#loading").hidden = state.loading === 0 && !isPending();
  render();
}

function colorOf(event, calendar) {
  if (event?.colorId && state.colors?.event?.[event.colorId]) return displayColor(state.colors.event[event.colorId].background);
  return displayColor(calendar?.backgroundColor ?? FALLBACK_COLOR);
}

/** Grid instances for one listed event (already expanded by the Tool). Multi-day timed events go to the all-day row. */
function instancesOf(event, calendar) {
  if (event.status === "cancelled") return [];
  const self = (event.attendees ?? []).find((attendee) => attendee.self === true);
  const base = {
    id: event.id,
    calendarId: calendar.id,
    calendar,
    event,
    title: event.summary || "(No title)",
    color: colorOf(event, calendar),
    response: self?.responseStatus,
    free: event.transparency === "transparent",
    type: event.eventType ?? "default",
  };
  if (event.start.date !== undefined) {
    return [{ ...base, allDay: true, allDayRow: true, startKey: event.start.date, endKey: event.end.date ?? T.addDays(event.start.date, 1) }];
  }
  const start = T.parseWall(event.start.dateTime);
  const end = T.parseWall(event.end.dateTime) ?? start;
  if (start === null) return [];
  const startKey = T.partsKey(start);
  let endKey = T.partsKey(end);
  let endMin = T.minutesOf(end);
  const days = T.diffDays(startKey, endKey);
  if (days >= 1 && !(days === 1 && endMin === 0)) {
    return [{ ...base, allDay: false, allDayRow: true, startKey, endKey: endMin === 0 ? endKey : T.addDays(endKey, 1), startMin: T.minutesOf(start), endMin }];
  }
  if (days === 1 && endMin === 0) {
    endKey = startKey;
    endMin = 1440;
  }
  return [{ ...base, allDay: false, allDayRow: false, startKey, endKey: startKey, startMin: T.minutesOf(start), endMin: Math.max(endMin, T.minutesOf(start)) }];
}

/** A "Busy" block from a free/busy-only calendar (start/end are UTC instants). */
function busyInstance(calendar, block) {
  const start = T.wallOf(zone(), Date.parse(block.start));
  const end = T.wallOf(zone(), Date.parse(block.end));
  const startKey = T.partsKey(start);
  const endKey = T.partsKey(end);
  const endMin = T.minutesOf(end);
  const days = T.diffDays(startKey, endKey);
  if (days >= 1 && !(days === 1 && endMin === 0)) return { id: `busy-${block.start}`, calendarId: calendar.id, calendar, busyOnly: true, title: "Busy", color: displayColor(calendar.backgroundColor), allDay: true, allDayRow: true, startKey, endKey: endMin === 0 ? endKey : T.addDays(endKey, 1) };
  return { id: `busy-${block.start}`, calendarId: calendar.id, calendar, busyOnly: true, title: "Busy", color: displayColor(calendar.backgroundColor), allDay: false, allDayRow: false, startKey, endKey: startKey, startMin: T.minutesOf(start), endMin: days === 1 ? 1440 : endMin };
}

const visibleInstances = () => state.events.filter((instance) => state.showDeclined || instance.response !== "declined");

// ---------------------------------------------------------------------------------------------
// Rendering: shell
// ---------------------------------------------------------------------------------------------

function render() {
  renderHeader();
  renderSidebar();
  const view = $("#view");
  const banner = $("#banner");
  banner.hidden = state.banner === null;
  if (state.banner) $("#banner-text").textContent = state.banner.text;
  if (state.bootError) {
    view.replaceChildren(deniedCard("Couldn't connect to the local calendar", state.bootError));
    return;
  }
  if (state.denied && state.context !== null) {
    view.replaceChildren(deniedCard("You don't have access to this calendar", `The actor "${state.context.actorId}" has no grant for calendar-list.list, so Google Calendar can't show any calendar for it. Grant the operations in the world's actor definition and reload.`));
    return;
  }
  if (state.context === null || state.now === null) {
    view.replaceChildren(skeleton());
    return;
  }
  switch (state.route.view) {
    case "search":
      renderSearch();
      break;
    case "settings":
      renderSettings();
      break;
    case "edit":
    case "new":
      renderEditor();
      break;
    case "day":
      renderWeekGrid([state.route.date]);
      break;
    case "month":
      renderMonth();
      break;
    case "schedule":
      renderSchedule();
      break;
    case "year":
      renderYear();
      break;
    case "4days":
      renderWeekGrid(Array.from({ length: 4 }, (_, index) => T.addDays(state.route.date, index)));
      break;
    default:
      renderWeekGrid(weekDays(state.route.date));
  }
}

function weekDays(date) {
  const start = T.startOfWeek(date, state.settings.weekStart);
  const days = Array.from({ length: 7 }, (_, index) => T.addDays(start, index));
  return state.showWeekends ? days : days.filter((key) => ![0, 6].includes(T.weekday(key)));
}

function skeleton() {
  const box = el("div", { class: "gc-skeleton", attrs: { "aria-label": "Loading" } });
  for (const width of ["30%", "80%", "60%", "70%", "45%"]) {
    const line = el("span");
    line.style.width = width;
    box.append(line);
  }
  return box;
}

function deniedCard(title, text) {
  const card = el("div", { class: "gc-denied-card" }, [icon("lock"), el("h2", { text: title }), el("p", { text })]);
  if (state.context) card.append(el("p", {}, [el("code", { text: `actor ${state.context.actorId} · world ${state.context.worldInstanceId}` })]));
  return el("div", { class: "gc-denied" }, [card]);
}

function renderHeader() {
  const route = state.route;
  const isCalendar = Boolean(VIEWS[route.view]);
  $("#header-nav").hidden = !isCalendar && route.view !== "search";
  $("#view-btn").hidden = !isCalendar;
  const view = isCalendar ? route.view : calendarView();
  const range = rangeOf(isCalendar ? route : { view, date: route.date });
  const monthTitle = () => {
    const { y, m } = T.parseKey(route.date ?? todayKey());
    return `${T.MONTHS[m - 1]} ${y}`;
  };
  $("#range-title").textContent = route.view === "search" ? "Search results" : view === "year" ? String(T.parseKey(route.date ?? todayKey()).y) : view === "month" || view === "schedule" ? monthTitle() : T.fmtRangeTitle(range.start, view === "day" ? range.start : T.addDays(range.end, -1), locale());
  $("#view-label").textContent = VIEWS[calendarView()] ?? "Week";
  $("#today-btn").title = state.now ? T.fmtLongDate(todayKey(), locale(), 0) : "";
  $("#header").classList.toggle("is-searching", route.view === "search");
  $("#search-form").hidden = route.view !== "search";
  if (route.view === "search" && $("#search").value !== (route.query ?? "")) $("#search").value = route.query ?? "";
}

function renderIdentity() {
  const avatarNode = $("#account-avatar");
  avatarNode.textContent = (state.user.name || "?").charAt(0).toUpperCase();
  avatarNode.style.background = state.user.email ? avatar(state.user.name, state.user.email).style.background : "";
  document.title = `${state.user.name ? `${state.user.name} - ` : ""}Google Calendar (synthetic)`;
}

// ---------------------------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------------------------

function renderSidebar() {
  renderMini();
  const mine = state.calendars.filter((calendar) => !calendar.hidden && (calendar.accessRole === "owner" || calendar.primary));
  const other = state.calendars.filter((calendar) => !calendar.hidden && !(calendar.accessRole === "owner" || calendar.primary));
  renderCalendarList($("#my-calendar-list"), mine, "No calendars");
  renderCalendarList($("#other-calendar-list"), other, "No other calendars");
}

function renderMini() {
  const host = $("#mini");
  const month = state.miniMonth ?? T.firstOfMonth(todayKey());
  const { y, m } = T.parseKey(month);
  const head = el("div", { class: "gc-mini-head" });
  head.append(el("span", { class: "gc-mini-title", text: `${T.MONTHS[m - 1]} ${y}` }));
  head.append(
    iconButton("chevron_left", "Previous month", {
      onClick: () => {
        state.miniMonth = T.addMonths(month, -1);
        renderMini();
      },
    }),
    iconButton("chevron_right", "Next month", {
      onClick: () => {
        state.miniMonth = T.addMonths(month, 1);
        renderMini();
      },
    }),
  );
  const grid = el("div", { class: "gc-mini-grid", attrs: { role: "grid" } });
  for (let index = 0; index < 7; index += 1) {
    const day = (state.settings.weekStart + index) % 7;
    grid.append(el("span", { class: "gc-mini-dow", text: T.WEEKDAYS[day].charAt(0), attrs: { "aria-label": T.WEEKDAYS[day] } }));
  }
  const selected = state.route.date;
  const range = VIEWS[state.route.view] ? rangeOf() : null;
  for (const row of T.monthGrid(month, state.settings.weekStart)) {
    for (const key of row) {
      const other = T.parseKey(key).m !== m;
      const inRange = range && state.route.view === "week" && key >= range.start && key < range.end;
      const button = el("button", {
        class: `gc-mini-day ${other ? "is-other" : ""} ${key === todayKey() ? "is-today" : ""} ${key === selected || inRange ? "is-selected" : ""}`.replace(/\s+/g, " ").trim(),
        text: String(T.parseKey(key).d),
        attrs: { type: "button", "aria-label": T.fmtLongDate(key, locale(), 0) },
      });
      button.addEventListener("click", () => navigate(`#${calendarView()}/${key}`));
      grid.append(button);
    }
  }
  host.replaceChildren(head, grid);
}

function renderCalendarList(host, calendars, emptyText) {
  host.replaceChildren();
  if (calendars.length === 0) {
    host.append(el("li", { class: "gc-cal-empty", text: emptyText }));
    return;
  }
  for (const calendar of calendars) {
    const item = el("li", { class: `gc-cal-item ${calendar.selected ? "is-selected" : ""}`.trim() });
    item.style.setProperty("--cal-color", displayColor(calendar.backgroundColor));
    const check = el("button", { class: "gc-cal-check", attrs: { type: "button", role: "checkbox", "aria-checked": String(Boolean(calendar.selected)), "aria-label": `Show ${calendar.summary}` } });
    check.append(el("span", { class: "gc-cal-box" }, [icon("check")]));
    check.addEventListener("click", () => toggleCalendar(calendar));
    const name = el("button", { class: "gc-cal-name", text: calendar.summary, title: calendar.summary, attrs: { type: "button" } });
    name.addEventListener("click", () => toggleCalendar(calendar));
    const actions = el("span", { class: "gc-cal-actions" });
    actions.append(
      iconButton("more_vert", `Options for ${calendar.summary}`, {
        onClick: (event) => openCalendarMenu(event.currentTarget, calendar),
        attrs: { "aria-expanded": "false", "aria-haspopup": "menu" },
      }),
    );
    item.append(check, name, actions);
    host.append(item);
  }
}

function toggleCalendar(calendar) {
  void action(async () => {
    await call("calendar-list.patch", { calendarId: calendar.id, selected: !calendar.selected }, key());
    calendar.selected = !calendar.selected;
    renderSidebar();
    state.loadedRange = null;
    await loadForRoute();
  });
}

function openCalendarMenu(anchor, calendar) {
  const items = [
    {
      label: "Display this only",
      onSelect: () =>
        action(async () => {
          for (const other of state.calendars) {
            if (other.hidden) continue;
            const wanted = other.id === calendar.id;
            if (Boolean(other.selected) !== wanted) {
              await call("calendar-list.patch", { calendarId: other.id, selected: wanted }, key());
              other.selected = wanted;
            }
          }
          renderSidebar();
          state.loadedRange = null;
          await loadForRoute();
        }),
    },
    {
      label: "Hide from list",
      onSelect: () =>
        action(async () => {
          await call("calendar-list.patch", { calendarId: calendar.id, hidden: true }, key());
          calendar.hidden = true;
          renderSidebar();
          state.loadedRange = null;
          await loadForRoute();
          snackbar(`${calendar.summary} hidden. Show it again from Settings.`);
        }),
    },
    { label: "Settings and sharing", icon: "settings", onSelect: () => navigate(`#settings/${encodeURIComponent(calendar.id)}`) },
    "divider",
  ];
  const menu = openMenu(anchor, items, { header: calendar.summary });
  menu.append(paletteElement(state.colors?.calendar ?? {}, calendar.colorId, (colorId) => action(async () => {
    const entry = await call("calendar-list.patch", { calendarId: calendar.id, colorId }, key());
    Object.assign(calendar, entry);
    renderSidebar();
    state.loadedRange = null;
    await loadForRoute();
  })));
}

function paletteElement(palette, currentId, onPick) {
  const grid = el("div", { class: "gc-menu-palette", attrs: { role: "group", "aria-label": "Colour" } });
  for (const [id, colour] of Object.entries(palette)) {
    const swatch = el("button", { class: "gc-swatch-btn", title: colorName(colour.background), attrs: { type: "button", "aria-label": colorName(colour.background), "aria-pressed": String(id === currentId) } });
    swatch.style.background = displayColor(colour.background);
    if (id === currentId) swatch.append(icon("check"));
    swatch.addEventListener("click", () => {
      closeMenus();
      void onPick(id);
    });
    grid.append(swatch);
  }
  return grid;
}

// ---------------------------------------------------------------------------------------------
// Week / day grid
// ---------------------------------------------------------------------------------------------

function chipClasses(instance) {
  const classes = [];
  if (instance.busyOnly) classes.push("is-busy-only");
  if (instance.response === "needsAction") classes.push("is-needs-action");
  if (instance.response === "tentative") classes.push("is-tentative");
  if (instance.response === "declined") classes.push("is-declined");
  if (instance.free && !instance.busyOnly) classes.push("is-free");
  if (instance.type === "outOfOffice") classes.push("is-ooo");
  return classes.join(" ");
}

function applyChipColour(node, instance) {
  node.style.setProperty("--chip-bg", instance.color);
  node.style.setProperty("--chip-fg", T.isLight(instance.color) ? "#1d1d1d" : "#ffffff");
}

function chipTimeText(instance) {
  if (instance.allDay) return "All day";
  return T.fmtRange(instance.startMin, instance.endMin, h24());
}

function renderWeekGrid(days) {
  const view = $("#view");
  const scrollTop = view.querySelector(".gc-week-body")?.scrollTop;
  const instances = visibleInstances();
  const grid = el("div", { class: "gc-week", attrs: { role: "grid", "aria-label": `${VIEWS[state.route.view] ?? "Week"} view` } });

  // Day headers
  const head = el("div", { class: "gc-week-head" });
  head.append(el("div", { class: "gc-gutter-cell", text: T.gutterLabel(zone(), days[0]) }));
  const heads = el("div", { class: "gc-day-heads" });
  for (const key of days) {
    const cell = el("div", { class: `gc-day-head ${key === todayKey() ? "is-today" : ""}`.trim() });
    cell.append(el("span", { class: "gc-dow", text: T.WEEKDAYS_SHORT[T.weekday(key)] }));
    const number = el("button", { class: "gc-dnum", text: String(T.parseKey(key).d), attrs: { type: "button", "aria-label": T.fmtLongDate(key, locale(), 0) } });
    number.addEventListener("click", () => navigate(`#day/${key}`));
    cell.append(number);
    heads.append(cell);
  }
  head.append(heads);

  // All-day row
  const allday = el("div", { class: "gc-allday" });
  allday.append(el("div", { class: "gc-gutter-cell" }));
  const alldayCols = el("div", { class: "gc-allday-cols" });
  for (const key of days) {
    const column = el("div", { class: "gc-col-bg" });
    column.addEventListener("click", (event) => {
      if (event.target === column) openQuick({ key, allDay: true, anchor: column });
    });
    alldayCols.append(column);
  }
  const first = days[0];
  const last = T.addDays(days[days.length - 1], 1);
  const bars = instances.filter((instance) => instance.allDayRow && instance.startKey < last && instance.endKey > first);
  bars.sort((a, b) => (a.startKey < b.startKey ? -1 : a.startKey > b.startKey ? 1 : T.diffDays(a.startKey, a.endKey) < T.diffDays(b.startKey, b.endKey) ? 1 : -1));
  const lanes = [];
  for (const bar of bars) {
    const startIndex = Math.max(0, days.indexOf(bar.startKey) === -1 ? days.findIndex((key) => key >= bar.startKey) : days.indexOf(bar.startKey));
    let endIndex = days.findIndex((key) => key >= bar.endKey);
    if (endIndex === -1) endIndex = days.length;
    if (endIndex <= startIndex) continue;
    let lane = lanes.findIndex((occupied) => occupied.every(([s, e]) => e <= startIndex || s >= endIndex));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane].push([startIndex, endIndex]);
    const chip = el("button", { class: `gc-allday-chip ${chipClasses(bar)}`.trim(), text: bar.title, title: bar.title, attrs: { type: "button" } });
    applyChipColour(chip, bar);
    chip.style.left = `calc(${(startIndex / days.length) * 100}% + 2px)`;
    chip.style.width = `calc(${((endIndex - startIndex) / days.length) * 100}% - 4px)`;
    chip.style.top = `${2 + lane * 24}px`;
    if (!bar.busyOnly) chip.addEventListener("click", () => openPopover(bar, chip));
    else chip.disabled = true;
    alldayCols.append(chip);
  }
  alldayCols.style.minHeight = `${Math.max(1, lanes.length) * 24 + 4}px`;
  allday.append(alldayCols);

  // Scrolling body
  const body = el("div", { class: "gc-week-body" });
  const gutter = el("div", { class: "gc-gutter" });
  for (let hour = 1; hour < 24; hour += 1) {
    const label = el("span", { class: "gc-hour-label", text: T.fmtHourLabel(hour, h24()) });
    label.style.top = `${hour * HOUR_PX}px`;
    gutter.append(label);
  }
  const cols = el("div", { class: "gc-cols" });
  for (const key of days) {
    const column = el("div", { class: `gc-col ${[0, 6].includes(T.weekday(key)) ? "is-weekend" : ""}`.trim(), attrs: { role: "gridcell", "aria-label": T.fmtLongDate(key, locale(), 0) } });
    for (let slot = 0; slot < 48; slot += 1) {
      const button = el("div", { class: "gc-slot", attrs: { role: "button", tabindex: "-1", "aria-label": `${T.fmtLongDate(key, locale(), 0)} ${T.fmtTime(slot * 30, h24())}` } });
      button.style.top = `${slot * (HOUR_PX / 2)}px`;
      button.addEventListener("pointerdown", (down) => startDragCreate(down, column, key, slot));
      column.append(button);
    }
    const timed = instances.filter((instance) => !instance.allDayRow && instance.startKey === key).map((instance) => ({ ...instance }));
    layoutColumn(timed);
    for (const instance of timed) {
      const chip = el("button", { class: `gc-chip ${chipClasses(instance)}`.trim(), attrs: { type: "button", "aria-label": `${instance.title}, ${chipTimeText(instance)}` } });
      applyChipColour(chip, instance);
      const height = Math.max(12, ((instance.endMin - instance.startMin) / 60) * HOUR_PX - 1);
      chip.style.top = `${(instance.startMin / 60) * HOUR_PX}px`;
      chip.style.height = `${height}px`;
      chip.style.left = `calc(${(instance.lane / instance.lanes) * 100}% + ${instance.lane === 0 ? 0 : 2}px)`;
      chip.style.width = `calc(${(1 / instance.lanes) * 100}% - ${instance.lanes === 1 ? 6 : 4}px)`;
      chip.style.zIndex = String(2 + instance.lane);
      if (height < 36) {
        // Short events: one line "Title, 9:30am", sized to the chip the way the web client does it.
        chip.classList.add("is-short");
        chip.style.lineHeight = `${Math.max(10, Math.min(16, height - 2))}px`;
        if (height < 22) chip.style.fontSize = "11px";
        chip.append(el("span", { class: "gc-chip-title", text: `${instance.title}, ${T.fmtTime(instance.startMin, h24(), { compact: true })}` }));
      } else {
        const title = el("span", { class: "gc-chip-title" });
        if (instance.type === "focusTime") title.append(icon("do_not_disturb"));
        title.append(document.createTextNode(instance.title));
        chip.append(title, el("span", { class: "gc-chip-time", text: chipTimeText(instance) }));
      }
      if (instance.busyOnly) chip.disabled = true;
      else chip.addEventListener("click", () => openPopover(instance, chip));
      column.append(chip);
    }
    if (key === todayKey() && state.now) {
      const line = el("div", { class: "gc-now-line", attrs: { "aria-hidden": "true" } });
      line.style.top = `${(state.now.minutes / 60) * HOUR_PX}px`;
      column.append(line);
    }
    cols.append(column);
  }
  if (days.includes(todayKey()) && state.now) {
    const marker = el("span", { class: "gc-now-gutter", text: T.fmtTime(state.now.minutes, h24()) });
    marker.style.top = `${(state.now.minutes / 60) * HOUR_PX}px`;
    gutter.append(marker);
  }
  body.append(gutter, cols);
  grid.append(head, allday, body);
  view.replaceChildren(grid);
  if (scrollTop !== undefined) body.scrollTop = scrollTop;
  else {
    const anchorMinutes = days.includes(todayKey()) && state.now ? Math.max(0, state.now.minutes - 90) : 7 * 60 + 30;
    body.scrollTop = (anchorMinutes / 60) * HOUR_PX;
  }
}

/** Assign overlapping timed chips to side-by-side lanes (mutates `lane`/`lanes` on each item). */
function layoutColumn(items) {
  items.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const clusters = [];
  let cluster = null;
  let clusterEnd = -1;
  for (const item of items) {
    const end = Math.max(item.endMin, item.startMin + 15);
    if (cluster && item.startMin < clusterEnd) {
      cluster.push(item);
      clusterEnd = Math.max(clusterEnd, end);
    } else {
      cluster = [item];
      clusters.push(cluster);
      clusterEnd = end;
    }
  }
  for (const group of clusters) {
    const lanes = [];
    for (const item of group) {
      let lane = lanes.findIndex((end) => end <= item.startMin);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(0);
      }
      lanes[lane] = Math.max(item.endMin, item.startMin + 15);
      item.lane = lane;
    }
    for (const item of group) item.lanes = lanes.length;
  }
}

// ---------------------------------------------------------------------------------------------
// Month view
// ---------------------------------------------------------------------------------------------

function renderMonth() {
  const view = $("#view");
  const rows = T.monthGrid(state.route.date, state.settings.weekStart);
  const month = T.parseKey(state.route.date).m;
  const instances = visibleInstances();
  const grid = el("div", { class: "gc-month", attrs: { role: "grid", "aria-label": "Month view" } });
  const dows = el("div", { class: "gc-month-dows" });
  for (let index = 0; index < 7; index += 1) {
    const day = (state.settings.weekStart + index) % 7;
    if (!state.showWeekends && (day === 0 || day === 6)) continue;
    dows.append(el("span", { class: "gc-month-dow", text: T.WEEKDAYS_SHORT[day] }));
  }
  grid.append(dows);
  for (const row of rows) {
    const rowNode = el("div", { class: "gc-month-row" });
    for (const key of row) {
      if (!state.showWeekends && [0, 6].includes(T.weekday(key))) continue;
      const { d } = T.parseKey(key);
      const cell = el("div", { class: `gc-month-cell ${T.parseKey(key).m !== month ? "is-other" : ""} ${key === todayKey() ? "is-today" : ""}`.replace(/\s+/g, " ").trim(), attrs: { role: "gridcell" } });
      const number = el("button", { class: "gc-month-daynum", text: d === 1 ? `${d} ${T.MONTHS_SHORT[T.parseKey(key).m - 1]}` : String(d), attrs: { type: "button", "aria-label": T.fmtLongDate(key, locale(), 0) } });
      number.addEventListener("click", (event) => {
        event.stopPropagation();
        navigate(`#day/${key}`);
      });
      cell.append(number);
      cell.addEventListener("click", (event) => {
        if (event.target === cell) openQuick({ key, allDay: false, startMin: 9 * 60, anchor: cell });
      });
      const dayInstances = instances.filter((instance) => (instance.allDayRow ? instance.startKey <= key && instance.endKey > key : instance.startKey === key));
      dayInstances.sort((a, b) => Number(b.allDayRow) - Number(a.allDayRow) || (a.startMin ?? 0) - (b.startMin ?? 0));
      const limit = 3;
      dayInstances.slice(0, dayInstances.length > limit ? limit - 1 : limit).forEach((instance) => cell.append(monthChip(instance)));
      if (dayInstances.length > limit) {
        const more = el("button", { class: "gc-month-more", text: `${dayInstances.length - (limit - 1)} more`, attrs: { type: "button" } });
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          navigate(`#day/${key}`);
        });
        cell.append(more);
      }
      rowNode.append(cell);
    }
    grid.append(rowNode);
  }
  view.replaceChildren(grid);
}

function monthChip(instance) {
  const chip = el("button", { class: `gc-month-chip ${instance.allDayRow ? "is-allday" : ""} ${instance.response === "declined" ? "is-declined" : ""}`.replace(/\s+/g, " ").trim(), attrs: { type: "button", "aria-label": `${instance.title}, ${chipTimeText(instance)}` } });
  applyChipColour(chip, instance);
  if (!instance.allDayRow) {
    chip.append(el("span", { class: "gc-dot" }), el("span", { class: "gc-month-time", text: T.fmtTime(instance.startMin, h24(), { compact: true }) }));
  }
  chip.append(el("span", { class: "gc-month-title", text: instance.title }));
  if (instance.busyOnly) chip.disabled = true;
  else
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      openPopover(instance, chip);
    });
  return chip;
}

// ---------------------------------------------------------------------------------------------
// Schedule view and search results (same row shape)
// ---------------------------------------------------------------------------------------------

function groupByDay(instances, { startKey, endKey } = {}) {
  const groups = new Map();
  for (const instance of instances) {
    let key = instance.startKey;
    if (startKey && key < startKey) key = startKey;
    if (endKey && key >= endKey) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(instance);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}

function scheduleDay(key, instances) {
  const day = el("div", { class: `gc-sched-day ${key === todayKey() ? "is-today" : ""}`.trim() });
  const date = el("div", { class: "gc-sched-date" });
  const number = el("button", { class: "gc-sched-num", text: String(T.parseKey(key).d), attrs: { type: "button", "aria-label": T.fmtLongDate(key, locale(), 0) } });
  number.addEventListener("click", () => navigate(`#day/${key}`));
  date.append(number, el("span", { class: "gc-sched-mon", text: `${T.MONTHS_SHORT[T.parseKey(key).m - 1]}, ${T.WEEKDAYS_SHORT[T.weekday(key)]}` }));
  const list = el("div", { class: "gc-sched-list" });
  instances.sort((a, b) => Number(b.allDayRow) - Number(a.allDayRow) || (a.startMin ?? 0) - (b.startMin ?? 0));
  for (const instance of instances) list.append(scheduleRow(instance));
  day.append(date, list);
  return day;
}

function scheduleRow(instance) {
  const row = el("button", { class: `gc-sched-row ${chipClasses(instance)}`.trim(), attrs: { type: "button" } });
  applyChipColour(row, instance);
  row.append(el("span", { class: "gc-dot" }));
  const timeText = instance.allDayRow ? (instance.allDay && T.diffDays(instance.startKey, instance.endKey) === 1 ? "All day" : `${T.fmtShortDate(instance.startKey, locale())} – ${T.fmtShortDate(T.addDays(instance.endKey, -1), locale())}`) : chipTimeText(instance);
  row.append(el("span", { class: "gc-sched-time", text: timeText }));
  row.append(el("span", { class: "gc-sched-title", text: instance.title }));
  const meta = [...new Set([instance.calendar.summary, instance.event?.location].filter(Boolean))].join(" · ");
  if (meta) row.append(el("span", { class: "gc-sched-meta", text: meta }));
  if (instance.busyOnly) row.disabled = true;
  else row.addEventListener("click", () => openPopover(instance, row));
  return row;
}

function renderSchedule() {
  const view = $("#view");
  const range = rangeOf();
  const groups = groupByDay(visibleInstances(), { startKey: range.start, endKey: range.end });
  const host = el("div", { class: "gc-schedule", attrs: { role: "list", "aria-label": "Schedule" } });
  if (groups.length === 0 && state.loading === 0) {
    host.append(el("div", { class: "gc-empty" }, [icon("event"), el("h2", { text: "Nothing planned" }), el("p", { text: `No events between ${T.fmtShortDate(range.start, locale())} and ${T.fmtShortDate(T.addDays(range.end, -1), locale())} on your selected calendars.` })]));
  }
  for (const [key, instances] of groups) host.append(scheduleDay(key, instances));
  view.replaceChildren(host);
}

async function runSearch(query, { append = false } = {}) {
  const trimmed = query.trim();
  state.search.query = trimmed;
  state.search.error = null;
  if (trimmed === "") {
    state.search.items = [];
    state.search.nextPageToken = undefined;
    renderSearch();
    return;
  }
  state.search.loading = true;
  renderSearch();
  try {
    const result = await call("events.search", { query: trimmed, pageSize: 25, timeZone: zone(), ...(append && state.search.nextPageToken ? { pageToken: state.search.nextPageToken } : {}) });
    const items = result.events.flatMap((event) => {
      const calendar = state.calendars.find((entry) => entry.id === event.calendarId) ?? { id: event.calendarId ?? "primary", summary: event.calendarId ?? "", backgroundColor: FALLBACK_COLOR, accessRole: "reader" };
      // The Tool searches every readable calendar; the client, like the web app, leaves out calendars hidden from the list.
      if (calendar.hidden) return [];
      return instancesOf(event, calendar);
    });
    state.search.items = append ? [...state.search.items, ...items] : items;
    state.search.nextPageToken = result.nextPageToken;
  } catch (error) {
    state.search.error = describe(error);
    if (!append) state.search.items = [];
  } finally {
    state.search.loading = false;
    renderSearch();
  }
}

function renderSearch() {
  const view = $("#view");
  const search = state.search;
  const host = el("div", { class: "gc-schedule", attrs: { role: "list", "aria-label": "Search results" } });
  if (search.query === "") {
    host.append(el("div", { class: "gc-empty" }, [icon("search"), el("h2", { text: "Search your calendars" }), el("p", { text: "Type words from a title, description, location or guest and press Enter. Search is a case-insensitive match across every calendar you can read." })]));
  } else if (search.error) {
    host.append(el("div", { class: "gc-empty" }, [icon("error_outline"), el("h2", { text: "Search didn't work" }), el("p", { text: search.error })]));
  } else if (search.items.length === 0 && !search.loading) {
    host.append(el("div", { class: "gc-empty" }, [icon("search"), el("h2", { text: "No results found" }), el("p", { text: `Nothing matches "${search.query}" in the last 30 days or the next year.` })]));
  } else {
    host.append(el("div", { class: "gc-results-head", text: `${search.items.length}${search.nextPageToken ? "+" : ""} result${search.items.length === 1 ? "" : "s"} for "${search.query}" · 30 days back to a year ahead` }));
    for (const [key, instances] of groupByDay(search.items)) host.append(scheduleDay(key, instances));
    if (search.nextPageToken) {
      const more = textButton(search.loading ? "Loading…" : "More results", { onClick: () => runSearch(search.query, { append: true }) });
      more.disabled = search.loading;
      host.append(el("div", { class: "gc-more-row" }, [more]));
    }
  }
  view.replaceChildren(host);
}

// ---------------------------------------------------------------------------------------------
// Event popover
// ---------------------------------------------------------------------------------------------

function closePopover() {
  state.popover = null;
  const host = $("#popover");
  host.hidden = true;
  host.replaceChildren();
}

function openPopover(instance, anchor) {
  closeQuick();
  closeMenus();
  state.popover = { calendarId: instance.calendarId, eventId: instance.id, instance, event: instance.event, anchorRect: anchor.getBoundingClientRect(), loading: true, error: null, master: null };
  renderPopover();
  void reloadPopover();
}

async function reloadPopover() {
  const popover = state.popover;
  if (!popover) return;
  try {
    const event = await call("events.get", { calendarId: popover.calendarId, eventId: popover.eventId, timeZone: zone() });
    if (state.popover !== popover) return;
    popover.event = event;
    popover.loading = false;
    popover.error = event.status === "cancelled" ? "This event was deleted." : null;
    if (event.recurringEventId && !event.recurrence) {
      try {
        popover.master = await call("events.get", { calendarId: popover.calendarId, eventId: event.recurringEventId, timeZone: zone() });
      } catch {
        popover.master = null;
      }
    }
  } catch (error) {
    if (state.popover !== popover) return;
    popover.loading = false;
    popover.error = describe(error);
  }
  renderPopover();
}

function responseSummary(attendees) {
  const counts = { accepted: 0, declined: 0, tentative: 0, needsAction: 0 };
  for (const attendee of attendees) counts[attendee.responseStatus ?? "needsAction"] += 1;
  return [
    counts.accepted > 0 ? `${counts.accepted} yes` : null,
    counts.declined > 0 ? `${counts.declined} no` : null,
    counts.tentative > 0 ? `${counts.tentative} maybe` : null,
    counts.needsAction > 0 ? `${counts.needsAction} awaiting` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function guestRow(attendee, { organizerEmail } = {}) {
  const row = el("div", { class: "gc-guest" });
  const wrap = el("span", { class: "gc-guest-avatar" }, [avatar(attendee.displayName, attendee.email, "small")]);
  const status = attendee.responseStatus ?? "needsAction";
  if (status !== "needsAction") wrap.append(el("span", { class: `gc-guest-badge ${status}`, attrs: { "aria-hidden": "true" } }, [icon(status === "accepted" ? "check" : status === "declined" ? "close" : "help")]));
  const body = el("div", { class: "gc-guest-body" });
  const isOrganizer = attendee.organizer === true || (organizerEmail && attendee.email === organizerEmail);
  body.append(el("div", { class: "gc-guest-name", text: attendee.displayName || attendee.email }));
  const subs = [isOrganizer ? "Organiser" : null, attendee.resource ? "Room" : null, attendee.optional ? "Optional" : null, attendee.displayName ? attendee.email : null].filter(Boolean);
  if (subs.length > 0) body.append(el("div", { class: "gc-guest-sub", text: subs.join(" · ") }));
  if (attendee.comment) body.append(el("div", { class: "gc-guest-sub", text: `“${attendee.comment}”` }));
  row.append(wrap, body);
  return row;
}

function eventDateText(event) {
  if (event.start.date !== undefined) {
    const endKey = T.addDays(event.end.date ?? T.addDays(event.start.date, 1), -1);
    return event.start.date === endKey ? T.fmtLongDate(event.start.date, locale(), T.parseKey(todayKey()).y) : `${T.fmtLongDate(event.start.date, locale(), T.parseKey(todayKey()).y)} – ${T.fmtLongDate(endKey, locale(), T.parseKey(todayKey()).y)}`;
  }
  const start = T.parseWall(event.start.dateTime);
  const end = T.parseWall(event.end.dateTime) ?? start;
  const startKey = T.partsKey(start);
  const endKey = T.partsKey(end);
  const year = T.parseKey(todayKey()).y;
  if (startKey === endKey || (T.diffDays(startKey, endKey) === 1 && T.minutesOf(end) === 0)) return `${T.fmtLongDate(startKey, locale(), year)} ⋅ ${T.fmtRange(T.minutesOf(start), startKey === endKey ? T.minutesOf(end) : 1440, h24())}`;
  return `${T.fmtLongDate(startKey, locale(), year)}, ${T.fmtTime(T.minutesOf(start), h24())} – ${T.fmtLongDate(endKey, locale(), year)}, ${T.fmtTime(T.minutesOf(end), h24())}`;
}

function renderPopover() {
  const host = $("#popover");
  const popover = state.popover;
  if (!popover) return;
  const event = popover.event;
  const calendar = state.calendars.find((entry) => entry.id === popover.calendarId) ?? popover.instance.calendar;
  const canWrite = ["writer", "owner"].includes(calendar.accessRole);
  const self = (event.attendees ?? []).find((attendee) => attendee.self === true);
  const isOrganizer = event.organizer?.self === true || event.organizer?.email === calendar.id;
  host.replaceChildren();

  const actions = el("div", { class: "gc-pop-actions" });
  if (canWrite) {
    actions.append(iconButton("edit", "Edit event", { onClick: () => editFromPopover() }));
    actions.append(iconButton("delete", isOrganizer ? "Delete event" : "Remove from this calendar", { onClick: () => deleteFromPopover() }));
  }
  if ((event.attendees ?? []).length > 0) actions.append(iconButton("mail", "Email event guests", { onClick: (click) => notSimulated(click.currentTarget, "Email event guests", "E-mail is not simulated by this Tool; no message leaves this Firedrill world.") }));
  actions.append(
    iconButton("more_vert", "Options", {
      attrs: { "aria-expanded": "false", "aria-haspopup": "menu" },
      onClick: (click) => openPopoverMenu(click.currentTarget, canWrite, isOrganizer),
    }),
  );
  actions.append(iconButton("close", "Close", { onClick: closePopover }));
  host.append(actions);

  const body = el("div", { class: "gc-pop-body" });
  const swatch = el("span", { class: "gc-pop-swatch" });
  swatch.style.background = colorOf(event, calendar);
  const titleBlock = el("div");
  titleBlock.append(el("h2", { class: "gc-pop-title", text: event.summary || "(No title)" }));
  titleBlock.append(el("div", { class: "gc-pop-date", text: eventDateText(event) }));
  const recurrenceText = T.describeRecurrence(event.recurrence ?? popover.master?.recurrence, event.start.date ?? T.partsKey(T.parseWall(event.start.dateTime)));
  if (recurrenceText) titleBlock.append(el("div", { class: "gc-pop-sub", text: recurrenceText }));
  else if (event.recurringEventId) titleBlock.append(el("div", { class: "gc-pop-sub", text: "Repeats" }));
  if (event.start.timeZone && event.start.timeZone !== zone() && event.start.dateTime) titleBlock.append(el("div", { class: "gc-pop-sub", text: `Time zone: ${event.start.timeZone}` }));
  body.append(el("div", { class: "gc-pop-title-row" }, [swatch, titleBlock]));

  const row = (iconName, ...children) => el("div", { class: "gc-pop-row" }, [icon(iconName), el("div", { class: "gc-pop-row-body" }, children)]);
  if (event.eventType && event.eventType !== "default" && EVENT_TYPE_LABEL[event.eventType]) body.append(row(event.eventType === "focusTime" ? "do_not_disturb" : "event_busy", el("div", { text: EVENT_TYPE_LABEL[event.eventType] })));
  if (event.location) body.append(row("location_on", el("div", { text: event.location })));
  if (event.hangoutLink) {
    const join = el("button", { class: "gc-filled-btn", text: "Join with Google Meet", attrs: { type: "button" } });
    join.addEventListener("click", () => snackbar("This is a synthetic Meet link — no call is started outside this Firedrill world."));
    body.append(row("videocam", join, el("div", { class: "gc-pop-link", text: event.hangoutLink.replace(/^https?:\/\//, "") })));
  }
  const attendees = event.attendees ?? [];
  if (attendees.length > 0) {
    const guests = el("div");
    guests.append(el("div", { text: `${attendees.length} guest${attendees.length === 1 ? "" : "s"}` }));
    guests.append(el("div", { class: "gc-guest-sub", text: responseSummary(attendees) }));
    const list = el("div", { class: "gc-guest-list" });
    const sorted = [...attendees].sort((a, b) => Number(b.organizer === true || b.email === event.organizer?.email) - Number(a.organizer === true || a.email === event.organizer?.email));
    for (const attendee of sorted) list.append(guestRow(attendee, { organizerEmail: event.organizer?.email }));
    guests.append(list);
    body.append(row("people", guests));
  }
  if (event.description) body.append(row("notes", el("div", { class: "gc-pop-desc", text: event.description })));
  const reminders = event.reminders?.useDefault ? (calendar.defaultReminders ?? []) : (event.reminders?.overrides ?? []);
  if (reminders.length > 0) body.append(row("notifications", el("div", { text: reminders.map((reminder) => `${reminderLabel(reminder.minutes)}${reminder.method === "email" ? " (email)" : ""}`).join(", ") })));
  const calendarRow = el("div");
  calendarRow.append(el("div", { text: calendar.summary }));
  const creator = event.organizer?.displayName || event.organizer?.email;
  if (creator && !isOrganizer) calendarRow.append(el("div", { class: "gc-guest-sub", text: `Organised by ${creator}` }));
  if (event.visibility && event.visibility !== "default") calendarRow.append(el("div", { class: "gc-guest-sub", text: `${event.visibility.charAt(0).toUpperCase()}${event.visibility.slice(1)} · ${event.transparency === "transparent" ? "Free" : "Busy"}` }));
  body.append(row("calendar_today", calendarRow));
  host.append(body);
  if (popover.error) host.append(el("div", { class: "gc-pop-error", text: popover.error }));

  if (self && event.status !== "cancelled") {
    const footer = el("div", { class: "gc-pop-footer" });
    footer.append(el("span", { text: "Going?" }));
    const rsvp = el("div", { class: "gc-rsvp", attrs: { role: "group", "aria-label": "Respond" } });
    for (const [status, label] of [["accepted", "Yes"], ["declined", "No"], ["tentative", "Maybe"]]) {
      const button = el("button", { class: `gc-rsvp-btn ${self.responseStatus === status ? "is-selected" : ""}`.trim(), text: label, attrs: { type: "button", "aria-pressed": String(self.responseStatus === status) } });
      button.addEventListener("click", () => respondFromPopover(status));
      rsvp.append(button);
    }
    footer.append(rsvp);
    host.append(footer);
  }

  host.hidden = false;
  positionCard(host, popover.anchorRect);
}

function reminderLabel(minutes) {
  if (minutes === 0) return "At time of event";
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"} before`;
  return `${minutes} minutes before`;
}

function positionCard(card, rect) {
  if (window.innerWidth <= 768) return;
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  let left = rect.right + 8;
  if (left + width > window.innerWidth - 8) left = rect.left - width - 8;
  if (left < 8) left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.top;
  if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function openPopoverMenu(anchor, canWrite, isOrganizer) {
  const popover = state.popover;
  const event = popover.event;
  const items = [];
  if (canWrite) items.push({ label: "Duplicate", icon: "content_copy", onSelect: () => duplicateFromPopover() });
  items.push({ label: "Change colour", icon: "palette", keepOpen: true, onSelect: () => openColourMenu(anchor) });
  const destinations = state.calendars.filter((calendar) => ["writer", "owner"].includes(calendar.accessRole) && calendar.id !== popover.calendarId && !calendar.hidden);
  if (canWrite && isOrganizer && !event.recurringEventId && destinations.length > 0) items.push({ label: "Move to calendar", icon: "swap_horiz", keepOpen: true, onSelect: () => openMoveMenu(anchor, destinations) });
  items.push("divider", { label: "Copy event id", icon: "link", onSelect: () => navigator.clipboard?.writeText(event.id).then(() => snackbar("Event id copied"), () => snackbar(event.id)) });
  openMenu(anchor, items, { align: "end" });
}

function openColourMenu(anchor) {
  const popover = state.popover;
  const menu = openMenu(anchor, [], { align: "end", header: "Event colour" });
  menu.append(
    paletteElement(state.colors?.event ?? {}, popover.event.colorId, (colorId) =>
      action(async () => {
        popover.event = await call("events.patch", { calendarId: popover.calendarId, eventId: popover.eventId, colorId }, key());
        renderPopover();
        state.loadedRange = null;
        await loadForRoute();
      }),
    ),
  );
}

function openMoveMenu(anchor, destinations) {
  const popover = state.popover;
  openMenu(
    anchor,
    destinations.map((calendar) => ({
      label: calendar.summary,
      swatch: displayColor(calendar.backgroundColor),
      onSelect: () =>
        action(async () => {
          await call("events.move", { calendarId: popover.calendarId, eventId: popover.eventId, destination: calendar.id }, key());
          closePopover();
          snackbar(`Moved to ${calendar.summary}`);
          state.loadedRange = null;
          await loadForRoute();
        }),
    })),
    { align: "end", header: "Move to calendar" },
  );
}

async function pickRecurringScope(title, verb) {
  return confirmDialog(title, `This is a repeating event. ${verb} only this occurrence or every event in the series?`, {
    choices: [
      { value: "this", label: "This event" },
      { value: "all", label: "All events" },
    ],
  });
}

function editFromPopover() {
  const popover = state.popover;
  void action(async () => {
    let eventId = popover.eventId;
    if (popover.event.recurringEventId) {
      const scope = await pickRecurringScope("Edit recurring event", "Edit");
      if (scope === "cancel") return;
      if (scope === "all") eventId = popover.event.recurringEventId;
    }
    closePopover();
    navigate(`#edit/${encodeURIComponent(popover.calendarId)}/${encodeURIComponent(eventId)}`);
  });
}

function duplicateFromPopover() {
  const popover = state.popover;
  const event = popover.event;
  const form = formFromEvent(event, popover.calendarId);
  form.recurrence = [];
  closePopover();
  state.editor = { mode: "new", calendarId: popover.calendarId, form, tab: "details", fat: null, error: null, idemKey: key() };
  navigate("#new");
}

function deleteFromPopover() {
  const popover = state.popover;
  void action(async () => {
    let eventId = popover.eventId;
    const isOrganizer = popover.event.organizer?.self === true;
    if (popover.event.recurringEventId) {
      const scope = await pickRecurringScope("Delete recurring event", "Delete");
      if (scope === "cancel") return;
      if (scope === "all") eventId = popover.event.recurringEventId;
    } else {
      const guests = (popover.event.attendees ?? []).filter((attendee) => attendee.self !== true).length;
      const choice = await confirmDialog(
        isOrganizer ? "Delete event?" : "Remove from your calendar?",
        isOrganizer ? (guests > 0 ? `“${popover.event.summary || "(No title)"}” will be cancelled for ${guests} guest${guests === 1 ? "" : "s"}. Nothing is e-mailed outside this synthetic world.` : `“${popover.event.summary || "(No title)"}” will be deleted.`) : "You'll be marked as declined on the organiser's event.",
        { okLabel: isOrganizer ? "Delete" : "Remove" },
      );
      if (choice !== "ok") return;
    }
    await call("events.delete", { calendarId: popover.calendarId, eventId, notificationLevel: "ALL" }, key());
    closePopover();
    snackbar(isOrganizer ? "Event deleted" : "Removed from your calendar");
    state.loadedRange = null;
    await loadForRoute();
  });
}

function respondFromPopover(responseStatus) {
  const popover = state.popover;
  void action(async () => {
    let eventId = popover.eventId;
    if (popover.event.recurringEventId) {
      const scope = await pickRecurringScope("Respond to recurring event", "Respond to");
      if (scope === "cancel") return;
      if (scope === "all") eventId = popover.event.recurringEventId;
    }
    const updated = await call("events.respond", { calendarId: popover.calendarId, eventId, responseStatus, notificationLevel: "ALL" }, key());
    if (state.popover === popover) {
      if (eventId === popover.eventId) popover.event = updated;
      else await reloadPopover();
      renderPopover();
    }
    snackbar(`Responded “${RESPONSE_LABEL[responseStatus]}”`);
    state.loadedRange = null;
    await loadForRoute();
  });
}

// ---------------------------------------------------------------------------------------------
// Forms shared by the quick-create card and the full editor
// ---------------------------------------------------------------------------------------------

function writableCalendars() {
  return state.calendars.filter((calendar) => ["writer", "owner"].includes(calendar.accessRole) && !calendar.hidden);
}

function defaultForm({ key: dayKey = todayKey(), startMin, allDay = false, calendarId } = {}) {
  const start = startMin ?? Math.max(0, Math.ceil((state.now?.minutes ?? 540) / 30) * 30);
  const length = state.settings.defaultLength || 60;
  return {
    title: "",
    type: "DEFAULT",
    allDay,
    startKey: dayKey,
    endKey: allDay ? dayKey : Math.min(start + length, 1440) === 1440 ? dayKey : dayKey,
    startMin: start,
    endMin: Math.min(start + length, 1440),
    timeZone: zone(),
    recurrence: [],
    meet: false,
    existingMeet: null,
    location: "",
    description: "",
    calendarId: calendarId ?? writableCalendars().find((calendar) => calendar.primary)?.id ?? writableCalendars()[0]?.id ?? state.user.primaryId,
    colorId: "",
    availability: "AVAILABILITY_BUSY",
    visibility: "default",
    guests: [],
    guestsCanModify: false,
    guestsCanInviteOthers: true,
    guestsCanSeeOtherGuests: true,
    reminders: null,
  };
}

function formFromEvent(event, calendarId) {
  const form = defaultForm({ calendarId });
  form.title = event.summary ?? "";
  form.type = { focusTime: "FOCUS_TIME", outOfOffice: "OUT_OF_OFFICE" }[event.eventType] ?? "DEFAULT";
  if (event.start.date !== undefined) {
    form.allDay = true;
    form.startKey = event.start.date;
    form.endKey = T.addDays(event.end.date ?? T.addDays(event.start.date, 1), -1);
    form.startMin = 9 * 60;
    form.endMin = 10 * 60;
  } else {
    const start = T.parseWall(event.start.dateTime);
    const end = T.parseWall(event.end.dateTime) ?? start;
    form.allDay = false;
    form.startKey = T.partsKey(start);
    form.endKey = T.partsKey(end);
    form.startMin = T.minutesOf(start);
    form.endMin = T.minutesOf(end);
    if (form.endKey !== form.startKey && form.endMin === 0 && T.diffDays(form.startKey, form.endKey) === 1) {
      form.endKey = form.startKey;
      form.endMin = 1440;
    }
    form.timeZone = T.SUPPORTED_ZONES.includes(event.start.timeZone) ? event.start.timeZone : zone();
  }
  form.recurrence = event.recurrence ?? [];
  form.existingMeet = event.hangoutLink ?? null;
  form.meet = Boolean(event.hangoutLink);
  form.location = event.location ?? "";
  form.description = event.description ?? "";
  form.colorId = event.colorId ?? "";
  form.availability = event.transparency === "transparent" ? "AVAILABILITY_FREE" : "AVAILABILITY_BUSY";
  form.visibility = event.visibility ?? "default";
  form.guests = (event.attendees ?? []).filter((attendee) => !(attendee.self === true && (attendee.organizer === true || attendee.email === event.organizer?.email))).map((attendee) => ({ email: attendee.email, displayName: attendee.displayName, optional: attendee.optional === true, resource: attendee.resource === true, responseStatus: attendee.responseStatus }));
  form.guestsCanModify = event.guestsCanModify === true;
  form.guestsCanInviteOthers = event.guestsCanInviteOthers !== false;
  form.guestsCanSeeOtherGuests = event.guestsCanSeeOtherGuests !== false;
  form.reminders = event.reminders?.useDefault === false ? (event.reminders.overrides ?? []) : null;
  return form;
}

function timeSelect(value, onChange, { label }) {
  const select = el("select", { class: "gc-field-input gc-time-select", attrs: { "aria-label": label } });
  const values = [];
  for (let minutes = 0; minutes < 1440; minutes += 15) values.push(minutes);
  if (!values.includes(value)) values.push(value);
  values.sort((a, b) => a - b);
  for (const minutes of values) select.append(el("option", { text: minutes === 1440 ? (h24() ? "24:00" : "12:00am (next day)") : T.fmtTime(minutes, h24()), attrs: { value: String(minutes), selected: minutes === value ? "" : undefined } }));
  select.addEventListener("change", () => onChange(Number(select.value)));
  return select;
}

function dateInput(value, onChange, { label }) {
  const input = el("input", { class: "gc-field-input", attrs: { type: "date", value, "aria-label": label } });
  input.addEventListener("change", () => {
    if (validKey(input.value)) onChange(input.value);
  });
  return input;
}

/** Build the canonical arguments for events.insert from a form. */
function insertArguments(form) {
  const args = { calendarId: form.calendarId, allDay: form.allDay };
  if (form.title.trim()) args.summary = form.title.trim();
  if (form.allDay) {
    args.startTime = form.startKey;
    args.endTime = T.addDays(form.endKey, 1);
  } else {
    args.startTime = T.rfc3339(form.timeZone, form.startKey, form.startMin);
    args.endTime = form.endMin === 1440 ? T.rfc3339(form.timeZone, T.addDays(form.endKey, 1), 0) : T.rfc3339(form.timeZone, form.endKey, form.endMin);
    args.timeZone = form.timeZone;
  }
  if (form.type !== "DEFAULT") args.eventType = form.type;
  if (form.location.trim()) args.location = form.location.trim();
  if (form.description.trim()) args.description = form.description.trim();
  if (form.recurrence.length > 0) args.recurrenceData = form.recurrence;
  if (form.guests.length > 0) args.attendees = form.guests.map((guest) => ({ email: guest.email, ...(guest.optional ? { optionalAttendee: true } : {}) }));
  if (form.meet) args.addGoogleMeetUrl = true;
  if (form.colorId) args.colorId = form.colorId;
  if (form.availability === "AVAILABILITY_FREE") args.availability = "AVAILABILITY_FREE";
  if (form.visibility !== "default") args.visibility = form.visibility;
  if (form.reminders !== null) args.overrideReminders = form.reminders;
  args.guestPermissions = { guestsCanModify: form.guestsCanModify, guestsCanInviteOthers: form.guestsCanInviteOthers, guestsCanSeeGuests: form.guestsCanSeeOtherGuests };
  return args;
}

/** Canonical arguments for events.patch: only what changed against the original form. */
function patchArguments(form, original, calendarId, eventId, etag) {
  const args = { calendarId, eventId, etag };
  const changed = (field) => JSON.stringify(form[field]) !== JSON.stringify(original[field]);
  if (changed("title")) args.summary = form.title.trim();
  if (changed("location")) args.location = form.location.trim();
  if (changed("description")) args.description = form.description.trim();
  if (["allDay", "startKey", "endKey", "startMin", "endMin", "timeZone"].some(changed)) {
    const times = insertArguments(form);
    args.allDay = form.allDay;
    args.startTime = times.startTime;
    args.endTime = times.endTime;
    if (!form.allDay) args.timeZone = form.timeZone;
  }
  if (changed("type")) args.eventType = form.type;
  if (changed("recurrence")) args.recurrenceData = form.recurrence;
  if (changed("guests")) {
    const before = new Map(original.guests.map((guest) => [guest.email.toLowerCase(), guest]));
    const after = new Map(form.guests.map((guest) => [guest.email.toLowerCase(), guest]));
    const added = form.guests.filter((guest) => !before.has(guest.email.toLowerCase()) || before.get(guest.email.toLowerCase()).optional !== guest.optional);
    const removed = original.guests.filter((guest) => !after.has(guest.email.toLowerCase()));
    if (added.length > 0) args.addedAttendees = added.map((guest) => ({ email: guest.email, ...(guest.optional ? { optionalAttendee: true } : {}) }));
    if (removed.length > 0) args.removedAttendeeEmails = removed.map((guest) => guest.email);
  }
  if (changed("meet")) {
    if (form.meet) args.addGoogleMeetUrl = true;
    else args.removeConference = true;
  }
  if (changed("colorId") && form.colorId) args.colorId = form.colorId;
  if (changed("availability")) args.availability = form.availability;
  if (changed("visibility")) args.visibility = form.visibility;
  if (changed("reminders")) {
    if (form.reminders === null) args.useDefaultReminders = true;
    else args.overrideReminders = form.reminders;
  }
  if (["guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeOtherGuests"].some(changed)) {
    args.guestPermissions = { guestsCanModify: form.guestsCanModify, guestsCanInviteOthers: form.guestsCanInviteOthers, guestsCanSeeGuests: form.guestsCanSeeOtherGuests };
  }
  return args;
}

function validateForm(form) {
  if (form.allDay) {
    if (form.endKey < form.startKey) return "The end date must not be before the start date.";
    return null;
  }
  const startMs = T.wallToUtc(form.timeZone, form.startKey, form.startMin);
  const endMs = form.endMin === 1440 ? T.wallToUtc(form.timeZone, T.addDays(form.endKey, 1), 0) : T.wallToUtc(form.timeZone, form.endKey, form.endMin);
  if (endMs <= startMs) return "The end must be after the start.";
  return null;
}

async function askNotification(form, original) {
  const others = form.guests.filter((guest) => guest.email.toLowerCase() !== state.user.email.toLowerCase());
  const previous = original?.guests?.length ?? 0;
  if (others.length === 0 && previous === 0) return "NONE";
  const choice = await confirmDialog("Send invitation e-mails to guests?", "In this synthetic calendar the choice is only recorded on the emitted event — nothing is e-mailed anywhere.", {
    choices: [
      { value: "NONE", label: "Don't send" },
      { value: "ALL", label: "Send" },
    ],
  });
  return choice === "cancel" ? null : choice;
}

const isEmail = (text) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);

function guestInput(form, rerender) {
  const input = el("input", { class: "gc-field-input wide", attrs: { type: "text", placeholder: "Add guests", autocomplete: "off", "aria-label": "Add guests" } });
  const commit = () => {
    const candidates = input.value.split(/[,\s;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
    let added = false;
    for (const email of candidates) {
      if (!isEmail(email)) {
        snackbar(`“${email}” is not an e-mail address.`, { error: true });
        continue;
      }
      if (form.guests.some((guest) => guest.email.toLowerCase() === email)) continue;
      const known = state.calendars.find((calendar) => calendar.id.toLowerCase() === email);
      form.guests.push({ email, displayName: known?.summary, optional: false, resource: email.endsWith("@resource.calendar.google.com") });
      added = true;
    }
    input.value = "";
    if (added) rerender();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit();
    }
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) commit();
  });
  return input;
}

function guestChips(form, rerender) {
  const chips = el("div", { class: "gc-guest-chips" });
  for (const guest of form.guests) {
    const chip = el("span", { class: `gc-guest-chip ${guest.optional ? "is-optional" : ""}`.trim() });
    chip.append(avatar(guest.displayName, guest.email, "tiny"), el("span", { class: "gc-guest-chip-name", text: guest.displayName || guest.email, title: guest.email }));
    chip.append(
      iconButton("close", `Remove ${guest.email}`, {
        onClick: () => {
          form.guests = form.guests.filter((item) => item !== guest);
          rerender();
        },
      }),
    );
    chips.append(chip);
  }
  return chips;
}

function calendarSelect(form, onChange) {
  const wrap = el("div", { class: "gc-cal-row-select" });
  const calendars = writableCalendars();
  const swatch = el("span", { class: "gc-cal-swatch" });
  const select = el("select", { class: "gc-field-input", attrs: { "aria-label": "Calendar" } });
  for (const calendar of calendars) select.append(el("option", { text: calendar.summary, attrs: { value: calendar.id, selected: calendar.id === form.calendarId ? "" : undefined } }));
  const paint = () => {
    swatch.style.background = displayColor(calendars.find((calendar) => calendar.id === select.value)?.backgroundColor ?? FALLBACK_COLOR);
  };
  paint();
  select.addEventListener("change", () => {
    paint();
    onChange(select.value);
  });
  wrap.append(swatch, select);
  return wrap;
}

function meetControl(form, rerender) {
  if (form.meet) {
    const wrap = el("div", { class: "gc-form-row-body" });
    wrap.append(el("span", { text: form.existingMeet ? form.existingMeet.replace(/^https?:\/\//, "") : "Google Meet video conferencing will be added (synthetic link)" }));
    wrap.append(
      iconButton("close", "Remove Google Meet", {
        onClick: () => {
          form.meet = false;
          rerender();
        },
      }),
    );
    return wrap;
  }
  const button = el("button", { class: "gc-tonal-btn", text: "Add Google Meet video conferencing", attrs: { type: "button" } });
  button.addEventListener("click", () => {
    form.meet = true;
    rerender();
  });
  return button;
}

function dateTimeFields(form, rerender, { compact = false } = {}) {
  const body = el("div", { class: "gc-form-row-body" });
  body.append(
    dateInput(form.startKey, (value) => {
      const shift = T.diffDays(form.startKey, value);
      form.startKey = value;
      form.endKey = T.addDays(form.endKey, shift);
      if (form.endKey < form.startKey) form.endKey = form.startKey;
      rerender();
    }, { label: "Start date" }),
  );
  if (!form.allDay) {
    body.append(
      timeSelect(form.startMin, (value) => {
        const duration = form.endMin - form.startMin + T.diffDays(form.startKey, form.endKey) * 1440;
        form.startMin = value;
        const total = value + Math.max(15, duration);
        form.endKey = T.addDays(form.startKey, Math.floor(total / 1440));
        form.endMin = total % 1440;
        if (form.endMin === 0 && total > 0) {
          form.endKey = T.addDays(form.endKey, -1);
          form.endMin = 1440;
        }
        rerender();
      }, { label: "Start time" }),
      el("span", { class: "gc-dash", text: "–" }),
      timeSelect(form.endMin, (value) => {
        form.endMin = value;
        rerender();
      }, { label: "End time" }),
    );
  } else body.append(el("span", { class: "gc-dash", text: "–" }));
  if (form.allDay || form.endKey !== form.startKey || !compact) {
    body.append(
      dateInput(form.endKey, (value) => {
        form.endKey = value;
        if (form.endKey < form.startKey) form.startKey = form.endKey;
        rerender();
      }, { label: "End date" }),
    );
  }
  const allDay = el("label", { class: "gc-check" });
  const box = el("input", { attrs: { type: "checkbox" } });
  box.checked = form.allDay;
  box.addEventListener("change", () => {
    form.allDay = box.checked;
    if (!form.allDay && form.endKey !== form.startKey && form.endMin <= form.startMin) form.endKey = form.startKey;
    rerender();
  });
  allDay.append(box, el("span", { text: "All day" }));
  body.append(allDay);
  if (!form.allDay) {
    const zoneSelect = el("select", { class: "gc-field-input flat", attrs: { "aria-label": "Time zone" } });
    for (const name of T.SUPPORTED_ZONES) zoneSelect.append(el("option", { text: name, attrs: { value: name, selected: name === form.timeZone ? "" : undefined } }));
    zoneSelect.addEventListener("change", () => {
      form.timeZone = zoneSelect.value;
    });
    body.append(zoneSelect);
  }
  return body;
}

function recurrenceSelect(form, rerender) {
  const presets = T.recurrencePresets(form.startKey);
  const select = el("select", { class: "gc-field-input flat", attrs: { "aria-label": "Repeat" } });
  const current = JSON.stringify(form.recurrence);
  let matched = false;
  for (const preset of presets) {
    const selected = JSON.stringify(preset.lines) === current;
    matched = matched || selected;
    select.append(el("option", { text: preset.label, attrs: { value: preset.id, selected: selected ? "" : undefined } }));
  }
  if (!matched && form.recurrence.length > 0) select.append(el("option", { text: `Custom: ${T.describeRecurrence(form.recurrence, form.startKey) ?? form.recurrence.join(" ")}`, attrs: { value: "custom", selected: "" } }));
  select.append(el("option", { text: "Custom RRULE…", attrs: { value: "prompt" } }));
  select.addEventListener("change", () => {
    if (select.value === "prompt") {
      const line = window.prompt("RRULE line (for example RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10):", form.recurrence[0] ?? "RRULE:FREQ=WEEKLY");
      if (line && line.trim()) form.recurrence = [line.trim()];
      rerender();
      return;
    }
    if (select.value === "custom") return;
    form.recurrence = presets.find((preset) => preset.id === select.value)?.lines ?? [];
    rerender();
  });
  return select;
}

function typeTabs(form, rerender) {
  const tabs = el("div", { class: "gc-tabs", attrs: { role: "tablist" } });
  for (const [value, label] of [["DEFAULT", "Event"], ["FOCUS_TIME", "Focus time"], ["OUT_OF_OFFICE", "Out of office"]]) {
    const tab = el("button", { class: `gc-tab-chip ${form.type === value ? "is-selected" : ""}`.trim(), text: label, attrs: { type: "button", role: "tab", "aria-selected": String(form.type === value) } });
    tab.addEventListener("click", () => {
      form.type = value;
      if (value === "OUT_OF_OFFICE") form.allDay = true;
      if (!form.title && value !== "DEFAULT") form.title = label;
      rerender();
    });
    tabs.append(tab);
  }
  return tabs;
}

// ---------------------------------------------------------------------------------------------
// Quick create card
// ---------------------------------------------------------------------------------------------

function closeQuick() {
  state.quick = null;
  const host = $("#quick");
  host.hidden = true;
  host.replaceChildren();
  if (state.stale) void refresh(false);
}

function openQuick({ key: dayKey, startMin, allDay = false, anchor }) {
  if (writableCalendars().length === 0) {
    snackbar("You can't create events: none of your calendars allows changes.", { error: true });
    return;
  }
  closePopover();
  closeMenus();
  state.quick = { form: defaultForm({ key: dayKey, startMin, allDay }), anchorRect: anchor.getBoundingClientRect(), error: null, idemKey: key() };
  renderQuick();
  $("#quick .gc-title-input")?.focus();
}

function renderQuick() {
  const host = $("#quick");
  const quick = state.quick;
  if (!quick) return;
  const form = quick.form;
  const rerender = () => renderQuick();
  host.replaceChildren();
  const head = el("div", { class: "gc-quick-head" });
  head.append(el("span", { class: "gc-drag" }, [icon("drag_handle")]), iconButton("close", "Close", { onClick: closeQuick }));
  host.append(head);
  const body = el("div", { class: "gc-quick-body" });
  const title = el("input", { class: "gc-title-input", attrs: { type: "text", placeholder: "Add title", value: form.title, "aria-label": "Title", maxlength: "1024" } });
  title.addEventListener("input", () => {
    form.title = title.value;
  });
  title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveQuick();
    }
  });
  body.append(title, typeTabs(form, rerender));
  body.append(el("div", { class: "gc-form-row" }, [icon("schedule"), dateTimeFields(form, rerender, { compact: true })]));
  body.append(el("div", { class: "gc-form-row" }, [icon("repeat"), el("div", { class: "gc-form-row-body" }, [recurrenceSelect(form, rerender)])]));
  if (form.type === "DEFAULT") {
    body.append(el("div", { class: "gc-form-row" }, [icon("people"), el("div", { class: "gc-form-row-body" }, [guestInput(form, rerender), guestChips(form, rerender)])]));
    body.append(el("div", { class: "gc-form-row" }, [icon("videocam"), el("div", { class: "gc-form-row-body" }, [meetControl(form, rerender)])]));
    const location = el("input", { class: "gc-field-input wide", attrs: { type: "text", placeholder: "Add location", value: form.location, "aria-label": "Location" } });
    location.addEventListener("input", () => {
      form.location = location.value;
    });
    body.append(el("div", { class: "gc-form-row" }, [icon("location_on"), el("div", { class: "gc-form-row-body" }, [location])]));
  }
  const description = el("textarea", { class: "gc-field-input", attrs: { placeholder: "Add description", "aria-label": "Description", rows: "2" } });
  description.value = form.description;
  description.addEventListener("input", () => {
    form.description = description.value;
  });
  body.append(el("div", { class: "gc-form-row" }, [icon("notes"), el("div", { class: "gc-form-row-body" }, [description])]));
  const calendarRow = el("div", { class: "gc-form-row-body" });
  calendarRow.append(
    calendarSelect(form, (value) => {
      form.calendarId = value;
    }),
  );
  const reminders = state.calendars.find((calendar) => calendar.id === form.calendarId)?.defaultReminders ?? [];
  calendarRow.append(el("span", { class: "gc-inline-note", text: `${form.availability === "AVAILABILITY_FREE" ? "Free" : "Busy"} · Default visibility · ${reminders.length > 0 ? `Notify ${reminderLabel(reminders[0].minutes).toLowerCase()}` : "No notification"}` }));
  body.append(el("div", { class: "gc-form-row" }, [avatar(state.user.name, state.user.email, "tiny"), calendarRow]));
  if (quick.error) body.append(el("p", { class: "gc-form-error", text: quick.error, attrs: { role: "alert" } }));
  host.append(body);
  const footer = el("div", { class: "gc-quick-footer" });
  footer.append(
    textButton("More options", {
      onClick: () => {
        state.editor = { mode: "new", calendarId: form.calendarId, form, tab: "details", fat: null, error: null, idemKey: quick.idemKey };
        state.quick = null;
        $("#quick").hidden = true;
        navigate("#new");
      },
    }),
  );
  const save = el("button", { class: "gc-filled-btn", text: "Save", attrs: { type: "button" } });
  save.addEventListener("click", () => void saveQuick());
  footer.append(save);
  host.append(footer);
  host.hidden = false;
  positionCard(host, quick.anchorRect);
}

async function saveQuick() {
  const quick = state.quick;
  if (!quick) return;
  const problem = validateForm(quick.form);
  if (problem) {
    quick.error = problem;
    renderQuick();
    return;
  }
  await action(
    async () => {
      const level = await askNotification(quick.form);
      if (level === null) return;
      const event = await call("events.insert", { ...insertArguments(quick.form), notificationLevel: level }, quick.idemKey);
      closeQuick();
      snackbar("Event saved", { actionLabel: "View", onAction: () => navigate(`#day/${event.start.date ?? T.partsKey(T.parseWall(event.start.dateTime))}`) });
      state.loadedRange = null;
      await loadForRoute();
    },
    {
      onError: (error) => {
        if (state.quick === quick) {
          quick.error = describe(error);
          if (error instanceof ToolError && !error.is("RATE_LIMITED") && !error.is("BACKEND_ERROR")) quick.idemKey = key();
          renderQuick();
        } else snackbar(describe(error), { error: true });
      },
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Full editor
// ---------------------------------------------------------------------------------------------

async function ensureEditor() {
  const route = state.route;
  if (state.editor && (state.editor.mode === "new" ? route.view === "new" : route.view === "edit" && state.editor.eventId === route.eventId && state.editor.calendarId === route.calendarId)) return;
  if (route.view === "new") {
    state.editor = { mode: "new", calendarId: undefined, form: defaultForm({}), tab: "details", fat: null, error: null, idemKey: key() };
    return;
  }
  state.editor = { mode: "edit", calendarId: route.calendarId, eventId: route.eventId, form: null, original: null, etag: null, tab: "details", fat: null, error: null, idemKey: key(), loading: true };
  renderEditor();
  try {
    const event = await call("events.get", { calendarId: route.calendarId, eventId: route.eventId, timeZone: zone() });
    if (state.editor?.eventId !== route.eventId) return;
    if (event.status === "cancelled") throw new ToolError("tool_error", "tool.GONE", "This event was deleted.");
    state.editor.event = event;
    state.editor.form = formFromEvent(event, route.calendarId);
    state.editor.original = JSON.parse(JSON.stringify(state.editor.form));
    state.editor.etag = event.etag;
    state.editor.loading = false;
  } catch (error) {
    state.editor.loading = false;
    state.editor.error = describe(error);
    state.editor.fatal = true;
  }
  renderEditor();
}

function closeEditor() {
  state.editor = null;
  const date = state.route.date ?? todayKey();
  navigate(`#${calendarView()}/${date}`);
  if (state.stale) void refresh(false);
}

function renderEditor() {
  const view = $("#view");
  const editor = state.editor;
  if (!editor || (editor.mode === "edit" && editor.eventId !== state.route.eventId)) {
    void ensureEditor();
    if (!state.editor) return;
  }
  const current = state.editor;
  const page = el("div", { class: "gc-editor" });
  const head = el("div", { class: "gc-editor-head" });
  head.append(iconButton("close", "Close editor", { onClick: closeEditor }));
  if (current.loading) {
    head.append(el("h2", { class: "gc-range-title", text: "Loading event…" }));
    page.append(head, skeleton());
    view.replaceChildren(page);
    return;
  }
  if (current.fatal) {
    head.append(el("h2", { class: "gc-range-title", text: "Event unavailable" }));
    page.append(head, el("div", { class: "gc-empty" }, [icon("error_outline"), el("h2", { text: "Can't open this event" }), el("p", { text: current.error })]));
    view.replaceChildren(page);
    return;
  }
  const form = current.form;
  const rerender = () => renderEditor();
  const title = el("input", { class: "gc-title-input", attrs: { type: "text", placeholder: "Add title", value: form.title, "aria-label": "Title", maxlength: "1024" } });
  title.addEventListener("input", () => {
    form.title = title.value;
  });
  head.append(title);
  const save = el("button", { class: "gc-filled-btn", text: "Save", attrs: { type: "button" } });
  save.addEventListener("click", () => void saveEditor());
  const more = el("button", { class: "gc-outlined-btn gc-editor-more", text: "More actions", attrs: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" } });
  more.append(icon("arrow_drop_down"));
  more.addEventListener("click", () => openMenu(more, [{ label: "Print", icon: "print", onSelect: () => notSimulated(more, "Print", "Printing is not simulated by this Tool.") }, { label: "Publish event", icon: "public", onSelect: () => notSimulated(more, "Publish event", "Publishing an event embed is not simulated by this Tool.") }], { align: "end" }));
  head.append(save, more);
  page.append(head);

  const body = el("div", { class: "gc-editor-body" });
  const main = el("div", { class: "gc-editor-main" });
  if (current.mode === "new") main.append(typeTabs(form, rerender));
  main.append(el("div", { class: "gc-form-row" }, [icon("schedule"), dateTimeFields(form, rerender)]));
  main.append(el("div", { class: "gc-form-row" }, [icon("repeat"), el("div", { class: "gc-form-row-body" }, [recurrenceSelect(form, rerender)])]));

  const tabs = el("div", { class: "gc-tabs-underline", attrs: { role: "tablist" } });
  for (const [id, label] of [["details", "Event details"], ["findtime", "Find a time"]]) {
    const tab = el("button", { class: `gc-tab-text ${current.tab === id ? "is-selected" : ""}`.trim(), text: label, attrs: { type: "button", role: "tab", "aria-selected": String(current.tab === id) } });
    tab.addEventListener("click", () => {
      current.tab = id;
      if (id === "findtime") void loadFindTime();
      rerender();
    });
    tabs.append(tab);
  }
  main.append(tabs);

  if (current.tab === "details") {
    if (form.type === "DEFAULT") main.append(el("div", { class: "gc-form-row" }, [icon("videocam"), el("div", { class: "gc-form-row-body" }, [meetControl(form, rerender)])]));
    const location = el("input", { class: "gc-field-input wide", attrs: { type: "text", placeholder: "Add location", value: form.location, "aria-label": "Location" } });
    location.addEventListener("input", () => {
      form.location = location.value;
    });
    main.append(el("div", { class: "gc-form-row" }, [icon("location_on"), el("div", { class: "gc-form-row-body" }, [location])]));

    const reminderBody = el("div", { class: "gc-form-row-body" });
    const reminderSelect = el("select", { class: "gc-field-input flat", attrs: { "aria-label": "Notification" } });
    reminderSelect.append(el("option", { text: "Calendar default notification", attrs: { value: "default", selected: form.reminders === null ? "" : undefined } }));
    for (const minutes of REMINDER_OPTIONS) reminderSelect.append(el("option", { text: `${reminderLabel(minutes)}`, attrs: { value: String(minutes), selected: form.reminders?.[0]?.minutes === minutes && form.reminders.length === 1 ? "" : undefined } }));
    reminderSelect.append(el("option", { text: "No notification", attrs: { value: "none", selected: form.reminders !== null && form.reminders.length === 0 ? "" : undefined } }));
    reminderSelect.addEventListener("change", () => {
      form.reminders = reminderSelect.value === "default" ? null : reminderSelect.value === "none" ? [] : [{ method: "popup", minutes: Number(reminderSelect.value) }];
    });
    reminderBody.append(reminderSelect);
    main.append(el("div", { class: "gc-form-row" }, [icon("notifications"), reminderBody]));

    const calendarBody = el("div", { class: "gc-form-row-body" });
    if (current.mode === "new") {
      calendarBody.append(
        calendarSelect(form, (value) => {
          form.calendarId = value;
        }),
      );
    } else {
      const owning = state.calendars.find((calendar) => calendar.id === current.calendarId) ?? (current.calendarId === "primary" ? state.calendars.find((calendar) => calendar.primary) : undefined);
      const dot = el("span", { class: "gc-cal-swatch" });
      dot.style.background = displayColor(owning?.backgroundColor ?? FALLBACK_COLOR);
      calendarBody.append(el("span", { class: "gc-cal-row-select gc-cal-fixed" }, [dot, el("span", { text: owning?.summary ?? current.calendarId })]));
    }
    const colourSelect = el("select", { class: "gc-field-input flat", attrs: { "aria-label": "Event colour" } });
    colourSelect.append(el("option", { text: "Calendar colour", attrs: { value: "", selected: form.colorId === "" ? "" : undefined } }));
    for (const [id] of Object.entries(state.colors?.event ?? {})) colourSelect.append(el("option", { text: colorName(state.colors.event[id].background), attrs: { value: id, selected: form.colorId === id ? "" : undefined } }));
    colourSelect.addEventListener("change", () => {
      form.colorId = colourSelect.value;
    });
    calendarBody.append(colourSelect);
    main.append(el("div", { class: "gc-form-row" }, [icon("calendar_today"), calendarBody]));

    const statusBody = el("div", { class: "gc-form-row-body" });
    const availability = el("select", { class: "gc-field-input flat", attrs: { "aria-label": "Availability" } });
    availability.append(el("option", { text: "Busy", attrs: { value: "AVAILABILITY_BUSY", selected: form.availability !== "AVAILABILITY_FREE" ? "" : undefined } }), el("option", { text: "Free", attrs: { value: "AVAILABILITY_FREE", selected: form.availability === "AVAILABILITY_FREE" ? "" : undefined } }));
    availability.addEventListener("change", () => {
      form.availability = availability.value;
    });
    const visibility = el("select", { class: "gc-field-input flat", attrs: { "aria-label": "Visibility" } });
    for (const [value, label] of [["default", "Default visibility"], ["public", "Public"], ["private", "Private"]]) visibility.append(el("option", { text: label, attrs: { value, selected: form.visibility === value ? "" : undefined } }));
    visibility.addEventListener("change", () => {
      form.visibility = visibility.value;
    });
    statusBody.append(availability, visibility);
    main.append(el("div", { class: "gc-form-row" }, [icon("work"), statusBody]));

    const description = el("textarea", { class: "gc-field-input", attrs: { placeholder: "Add description", "aria-label": "Description", rows: "5" } });
    description.value = form.description;
    description.addEventListener("input", () => {
      form.description = description.value;
    });
    const toolbar = el("div", { class: "gc-desc-toolbar", attrs: { role: "toolbar", "aria-label": "Description formatting" } });
    for (const [glyph, label] of [["format_bold", "Bold"], ["format_italic", "Italic"], ["format_underlined", "Underline"], ["format_list_numbered", "Numbered list"], ["format_list_bulleted", "Bulleted list"], ["link", "Link"], ["format_clear", "Remove formatting"]]) {
      toolbar.append(iconButton(glyph, `${label} (rich text not simulated: descriptions are stored as plain text)`, { class: "small", attrs: { disabled: "" } }));
    }
    main.append(el("div", { class: "gc-form-row" }, [icon("notes"), el("div", { class: "gc-form-row-body gc-desc" }, [toolbar, description])]));
  } else main.append(renderFindTime(current, rerender));

  if (current.error) main.append(el("p", { class: "gc-form-error", text: current.error, attrs: { role: "alert" } }));
  body.append(main);

  const side = el("div", { class: "gc-editor-side" });
  const panel = el("div", { class: "gc-panel" });
  const guestTabs = el("div", { class: "gc-tabs-underline gc-guest-tabs", attrs: { role: "tablist" } });
  guestTabs.append(el("button", { class: "gc-tab-text is-selected", text: "Guests", attrs: { type: "button", role: "tab", "aria-selected": "true" } }));
  const roomsTab = el("button", { class: "gc-tab-text", text: "Rooms", attrs: { type: "button", role: "tab", "aria-selected": "false" } });
  roomsTab.addEventListener("click", () => notSimulated(roomsTab, "Rooms", "Room booking from the directory is not simulated. A room already on an event shows as a resource guest."));
  guestTabs.append(roomsTab);
  panel.append(guestTabs);
  if (form.type === "DEFAULT") {
    panel.append(guestInput(form, rerender));
    const list = el("div", { class: "gc-guest-list" });
    const organizerEmail = current.mode === "edit" ? current.event?.organizer?.email : state.user.email;
    const organizerName = current.mode === "edit" ? current.event?.organizer?.displayName : state.user.name;
    const organizerRow = el("div", { class: "gc-guest" }, [el("span", { class: "gc-guest-avatar" }, [avatar(organizerName, organizerEmail, "small")]), el("div", { class: "gc-guest-body" }, [el("div", { class: "gc-guest-name", text: organizerName || organizerEmail }), el("div", { class: "gc-guest-sub", text: `Organiser · ${organizerEmail}` })])]);
    list.append(organizerRow);
    for (const guest of form.guests) {
      const rowNode = guestRow({ email: guest.email, displayName: guest.displayName, optional: guest.optional, resource: guest.resource, responseStatus: guest.responseStatus ?? "needsAction" });
      const controls = el("span", { class: "gc-guest-actions" });
      controls.append(
        iconButton("people", guest.optional ? "Mark as required" : "Mark as optional", {
          class: guest.optional ? "" : "is-on",
          onClick: () => {
            guest.optional = !guest.optional;
            rerender();
          },
        }),
        iconButton("close", `Remove ${guest.email}`, {
          onClick: () => {
            form.guests = form.guests.filter((item) => item !== guest);
            rerender();
          },
        }),
      );
      rowNode.append(controls);
      list.append(rowNode);
    }
    panel.append(list);
    panel.append(el("h4", { text: "Guest permissions" }));
    const permissions = el("div", { class: "gc-permissions" });
    for (const [field, label] of [["guestsCanModify", "Modify event"], ["guestsCanInviteOthers", "Invite others"], ["guestsCanSeeOtherGuests", "See guest list"]]) {
      const check = el("label", { class: "gc-check" });
      const box = el("input", { attrs: { type: "checkbox" } });
      box.checked = form[field];
      box.addEventListener("change", () => {
        form[field] = box.checked;
      });
      check.append(box, el("span", { text: label }));
      permissions.append(check);
    }
    panel.append(permissions);
  } else panel.append(el("p", { class: "gc-inline-note", text: `${form.type === "FOCUS_TIME" ? "Focus time" : "Out of office"} events have no guests.` }));
  side.append(panel);
  body.append(side);
  page.append(body);
  view.replaceChildren(page);
}

async function loadFindTime() {
  const editor = state.editor;
  if (!editor) return;
  const form = editor.form;
  const day = editor.fat?.date ?? form.startKey;
  const people = [state.user.email, ...form.guests.map((guest) => guest.email)];
  editor.fat = { date: day, loading: true, busy: {}, suggestions: [], error: null };
  renderEditor();
  try {
    const timeMin = T.rfc3339(zone(), day, 0);
    const timeMax = T.rfc3339(zone(), T.addDays(day, 1), 0);
    const [freebusy, suggested] = await Promise.all([
      call("freebusy.query", { timeMin, timeMax, timeZone: zone(), items: people.map((id) => ({ id })) }),
      call("time.suggest", { attendeeEmails: people, startTime: timeMin, endTime: T.rfc3339(zone(), T.addDays(day, 7), 0), timeZone: zone(), durationMinutes: Math.max(15, form.allDay ? 60 : form.endMin - form.startMin), preferences: { excludeWeekends: true, pageSize: 6 } }),
    ]);
    if (state.editor !== editor) return;
    editor.fat.busy = Object.fromEntries(
      people.map((id) => [
        id,
        (freebusy.calendars[id]?.busy ?? []).map((block) => {
          const start = T.wallOf(zone(), Date.parse(block.start));
          const end = T.wallOf(zone(), Date.parse(block.end));
          const startMin = T.partsKey(start) < day ? 0 : T.minutesOf(start);
          const endMin = T.partsKey(end) > day ? 1440 : T.minutesOf(end);
          return { startMin, endMin };
        }),
      ]),
    );
    editor.fat.unknown = people.filter((id) => freebusy.calendars[id]?.errors);
    editor.fat.suggestions = suggested.timeSlots;
    editor.fat.unresolved = suggested.unresolvedAttendees;
    editor.fat.loading = false;
  } catch (error) {
    if (state.editor !== editor) return;
    editor.fat.loading = false;
    editor.fat.error = describe(error);
  }
  renderEditor();
}

function renderFindTime(editor, rerender) {
  const fat = editor.fat ?? { date: editor.form.startKey, loading: true, busy: {}, suggestions: [] };
  const form = editor.form;
  const host = el("div", { class: "gc-fat" });
  const nav = el("div", { class: "gc-fat-nav" });
  nav.append(
    iconButton("chevron_left", "Previous day", {
      onClick: () => {
        editor.fat = { ...fat, date: T.addDays(fat.date, -1) };
        void loadFindTime();
      },
    }),
    iconButton("chevron_right", "Next day", {
      onClick: () => {
        editor.fat = { ...fat, date: T.addDays(fat.date, 1) };
        void loadFindTime();
      },
    }),
    el("h3", { text: T.fmtLongDate(fat.date, locale(), T.parseKey(todayKey()).y) }),
  );
  host.append(nav);
  if (fat.error) host.append(el("p", { class: "gc-form-error", text: fat.error }));
  const people = [state.user.email, ...form.guests.map((guest) => guest.email)];
  const grid = el("div", { class: "gc-fat-grid" });
  grid.style.setProperty("--fat-cols", String(people.length));
  grid.append(el("div", { class: "gc-fat-head" }));
  for (const id of people) {
    const calendar = state.calendars.find((entry) => entry.id === id);
    const name = id === state.user.email ? state.user.name : form.guests.find((guest) => guest.email === id)?.displayName || calendar?.summary || id;
    const cell = el("div", { class: "gc-fat-head" }, [avatar(name, id, "tiny"), el("span", { text: name, title: id })]);
    if (fat.unknown?.includes(id)) cell.append(el("span", { class: "gc-inline-note", text: "no calendar" }));
    grid.append(cell);
  }
  const scroll = el("div", { class: "gc-fat-scroll" });
  const inner = el("div", { class: "gc-fat-grid" });
  inner.style.setProperty("--fat-cols", String(people.length));
  inner.style.border = "0";
  const gutter = el("div", { class: "gc-fat-gutter" });
  for (let hour = 1; hour < 24; hour += 1) {
    const label = el("span", { text: T.fmtHourLabel(hour, h24()) });
    label.style.top = `${hour * 24}px`;
    gutter.append(label);
  }
  inner.append(gutter);
  for (const id of people) {
    const column = el("div", { class: "gc-fat-col" });
    for (const block of fat.busy[id] ?? []) {
      const bar = el("div", { class: "gc-fat-busy", title: `Busy ${T.fmtRange(block.startMin, block.endMin, h24())}` });
      bar.style.top = `${(block.startMin / 60) * 24}px`;
      bar.style.height = `${Math.max(4, ((block.endMin - block.startMin) / 60) * 24)}px`;
      column.append(bar);
    }
    if (!form.allDay && form.startKey === fat.date) {
      const proposal = el("div", { class: "gc-fat-proposal", title: "Proposed time" });
      proposal.style.top = `${(form.startMin / 60) * 24}px`;
      proposal.style.height = `${Math.max(6, ((form.endMin - form.startMin) / 60) * 24)}px`;
      column.append(proposal);
    }
    inner.append(column);
  }
  scroll.append(inner);
  host.append(grid, scroll);
  if (fat.loading) host.append(el("p", { class: "gc-inline-note", text: "Checking availability…" }));
  const suggestions = el("div", { class: "gc-suggestions" });
  suggestions.append(el("h3", { text: "Suggested times" }));
  if (!fat.loading && fat.suggestions.length === 0) suggestions.append(el("p", { class: "gc-inline-note", text: "No free slot for everyone in the next week (09:00–17:00, weekdays)." }));
  for (const slot of fat.suggestions) {
    const start = T.parseWall(slot.start.dateTime);
    const end = T.parseWall(slot.end.dateTime);
    const button = el("button", { class: "gc-suggestion", attrs: { type: "button" } });
    button.append(icon("schedule"), el("span", { text: `${T.fmtLongDate(T.partsKey(start), locale(), T.parseKey(todayKey()).y)} · ${T.fmtRange(T.minutesOf(start), T.minutesOf(end), h24())}` }));
    button.addEventListener("click", () => {
      form.allDay = false;
      form.startKey = T.partsKey(start);
      form.endKey = T.partsKey(end);
      form.startMin = T.minutesOf(start);
      form.endMin = T.minutesOf(end);
      editor.tab = "details";
      rerender();
    });
    suggestions.append(button);
  }
  if (fat.unresolved?.length > 0) suggestions.append(el("p", { class: "gc-inline-note", text: `No calendar in this world for ${fat.unresolved.join(", ")}; they count as free.` }));
  host.append(suggestions);
  scroll.scrollTop = 7 * 24;
  return host;
}

async function saveEditor() {
  const editor = state.editor;
  if (!editor || editor.loading || editor.fatal) return;
  const problem = validateForm(editor.form);
  if (problem) {
    editor.error = problem;
    renderEditor();
    return;
  }
  await action(
    async () => {
      const level = await askNotification(editor.form, editor.original);
      if (level === null) return;
      let event;
      if (editor.mode === "new") {
        event = await call("events.insert", { ...insertArguments(editor.form), notificationLevel: level }, editor.idemKey);
      } else {
        const args = patchArguments(editor.form, editor.original, editor.calendarId, editor.eventId, editor.etag);
        if (Object.keys(args).length <= 3) {
          closeEditor();
          return;
        }
        event = await call("events.patch", { ...args, notificationLevel: level }, editor.idemKey);
      }
      state.editor = null;
      snackbar(editor.mode === "new" ? "Event saved" : "Event updated");
      navigate(`#${calendarView()}/${event.start.date ?? T.partsKey(T.parseWall(event.start.dateTime))}`);
      state.loadedRange = null;
      await loadForRoute();
    },
    {
      onError: (error) => {
        if (state.editor === editor) {
          editor.error = describe(error);
          if (error instanceof ToolError && error.is("CONDITION_NOT_MET")) editor.error += " Close the editor and open the event again.";
          if (error instanceof ToolError && !error.is("RATE_LIMITED") && !error.is("BACKEND_ERROR")) editor.idemKey = key();
          renderEditor();
        } else snackbar(describe(error), { error: true });
      },
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

function renderSettings() {
  const view = $("#view");
  const section = state.route.section ?? "general";
  const page = el("div", { class: "gc-settings" });
  const head = el("div", { class: "gc-settings-head" });
  head.append(iconButton("arrow_back", "Back to calendar", { onClick: () => navigate(`#${calendarView()}/${state.route.date ?? todayKey()}`) }), el("h2", { text: "Settings" }));
  page.append(head);
  const body = el("div", { class: "gc-settings-body" });
  const nav = el("nav", { class: "gc-settings-nav", attrs: { "aria-label": "Settings sections" } });
  const navButton = (id, label, swatch) => {
    const button = el("button", { class: id === section ? "is-selected" : "", attrs: { type: "button", "aria-current": id === section ? "page" : undefined } });
    if (swatch) {
      const dot = el("span", { class: "gc-cal-swatch" });
      dot.style.background = displayColor(swatch);
      button.append(dot);
    }
    button.append(el("span", { text: label }));
    button.addEventListener("click", () => navigate(`#settings/${encodeURIComponent(id)}`));
    return button;
  };
  nav.append(el("h3", { text: "General" }), navButton("general", "Language and region"), navButton("create", "Add calendar"));
  const mine = state.calendars.filter((calendar) => calendar.accessRole === "owner" || calendar.primary);
  const other = state.calendars.filter((calendar) => !(calendar.accessRole === "owner" || calendar.primary));
  nav.append(el("h3", { text: "Settings for my calendars" }));
  for (const calendar of mine) nav.append(navButton(calendar.id, calendar.summary, calendar.backgroundColor));
  if (other.length > 0) nav.append(el("h3", { text: "Settings for other calendars" }));
  for (const calendar of other) nav.append(navButton(calendar.id, calendar.summary, calendar.backgroundColor));
  body.append(nav);
  const content = el("div", { class: "gc-settings-content" });
  if (section === "general") content.append(generalSettings());
  else if (section === "create") content.append(createCalendarSection());
  else {
    const calendar = state.calendars.find((entry) => entry.id === section);
    if (calendar) content.append(calendarSettings(calendar));
    else content.append(el("div", { class: "gc-empty" }, [icon("error_outline"), el("h2", { text: "Calendar not found" }), el("p", { text: "This calendar is not on your list." })]));
  }
  body.append(content);
  page.append(body);
  view.replaceChildren(page);
}

function settingsField(label, control) {
  const field = el("div", { class: "gc-settings-field" });
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  field.append(el("label", { text: label, attrs: { for: id } }), control);
  return field;
}

function generalSettings() {
  const host = el("div");
  const s = state.settings;
  const section = el("section", { class: "gc-settings-section" });
  section.append(el("h2", { text: "Language and region" }));
  section.append(el("p", { text: "These values come from the synthetic user's settings and are read-only in this Tool (Google's settings.patch is not implemented)." }));
  const readOnly = (value) => {
    const input = el("input", { class: "gc-field-input", attrs: { type: "text", value, disabled: "" } });
    return input;
  };
  section.append(settingsField("Language", readOnly(s.locale.replace("_", "-"))));
  section.append(settingsField("Time zone", readOnly(`(${T.gutterLabel(s.timezone, todayKey())}) ${s.timezone}`)));
  section.append(settingsField("Time format", readOnly(s.h24 ? "13:00" : "1:00pm")));
  section.append(settingsField("Week starts on", readOnly(T.WEEKDAYS[s.weekStart] ?? "Sunday")));
  host.append(section);
  const events = el("section", { class: "gc-settings-section" });
  events.append(el("h2", { text: "Event settings" }));
  events.append(settingsField("Default duration", readOnly(`${s.defaultLength} minutes`)));
  events.append(settingsField("Show weekends", readOnly(s.hideWeekends ? "No" : "Yes")));
  events.append(settingsField("Show declined events", readOnly(s.showDeclined ? "Yes" : "No")));
  host.append(events);
  const account = el("section", { class: "gc-settings-section" });
  account.append(el("h2", { text: "Account" }));
  account.append(settingsField("Signed in as", readOnly(`${state.user.name} <${state.user.email}>`)));
  account.append(settingsField("Firedrill actor", readOnly(`${state.context?.actorId} · world ${state.context?.worldInstanceId}`)));
  account.append(settingsField("Current virtual time", readOnly(state.now ? `${state.now.dateTime} (world time ${state.now.utc}; the browser clock is never used)` : "unavailable: settings.list and calendar-list.list are both denied")));
  host.append(account);
  return host;
}

function createCalendarSection() {
  const section = el("section", { class: "gc-settings-section" });
  section.append(el("h2", { text: "Create new calendar" }));
  const name = el("input", { class: "gc-field-input", attrs: { type: "text", placeholder: "Name", maxlength: "200" } });
  const description = el("textarea", { class: "gc-field-input", attrs: { placeholder: "Description", rows: "3" } });
  const zoneSelect = el("select", { class: "gc-field-input" });
  for (const zoneName of T.SUPPORTED_ZONES) zoneSelect.append(el("option", { text: zoneName, attrs: { value: zoneName, selected: zoneName === zone() ? "" : undefined } }));
  section.append(settingsField("Name", name), settingsField("Description", description), settingsField("Time zone", zoneSelect));
  const error = el("p", { class: "gc-form-error", attrs: { role: "alert" }, text: "" });
  error.hidden = true;
  section.append(error);
  const actions = el("div", { class: "gc-settings-actions" });
  const create = el("button", { class: "gc-filled-btn", text: "Create calendar", attrs: { type: "button" } });
  let idemKey = key();
  create.addEventListener("click", () =>
    action(
      async () => {
        if (!name.value.trim()) {
          error.textContent = "Enter a name for the calendar.";
          error.hidden = false;
          return;
        }
        const calendar = await call("calendars.insert", { summary: name.value.trim(), ...(description.value.trim() ? { description: description.value.trim() } : {}), timeZone: zoneSelect.value }, idemKey);
        idemKey = key();
        state.calendars = await listAllCalendars();
        snackbar(`Calendar “${calendar.summary}” created`);
        navigate(`#settings/${encodeURIComponent(calendar.id)}`);
      },
      {
        onError: (failure) => {
          error.textContent = describe(failure);
          error.hidden = false;
          if (!(failure instanceof ToolError && (failure.is("RATE_LIMITED") || failure.is("BACKEND_ERROR")))) idemKey = key();
        },
      },
    ),
  );
  actions.append(create);
  section.append(actions);
  return section;
}

function calendarSettings(calendar) {
  const host = el("div");
  const owner = calendar.accessRole === "owner";
  const section = el("section", { class: "gc-settings-section" });
  section.append(el("h2", { text: "Calendar settings" }));
  section.append(el("p", {}, [el("span", { class: "gc-role-pill", text: ROLE_LABEL[calendar.accessRole] ?? calendar.accessRole }), document.createTextNode(calendar.primary ? "  Your primary calendar" : "")]));
  const name = el("input", { class: "gc-field-input", attrs: { type: "text", value: calendar.summary, maxlength: "200", disabled: owner ? undefined : "" } });
  const description = el("textarea", { class: "gc-field-input", attrs: { rows: "3", disabled: owner ? undefined : "" } });
  description.value = calendar.description ?? "";
  const zoneSelect = el("select", { class: "gc-field-input", attrs: { disabled: owner ? undefined : "" } });
  for (const zoneName of T.SUPPORTED_ZONES) zoneSelect.append(el("option", { text: zoneName, attrs: { value: zoneName, selected: zoneName === calendar.timeZone ? "" : undefined } }));
  section.append(settingsField("Name", name), settingsField("Description", description), settingsField("Time zone", zoneSelect), settingsField("Calendar id", el("input", { class: "gc-field-input", attrs: { type: "text", value: calendar.id, disabled: "" } })));
  const error = el("p", { class: "gc-form-error", attrs: { role: "alert" } });
  error.hidden = true;
  section.append(error);
  if (owner) {
    const actions = el("div", { class: "gc-settings-actions" });
    const save = el("button", { class: "gc-filled-btn", text: "Save", attrs: { type: "button" } });
    save.addEventListener("click", () =>
      action(
        async () => {
          const args = { calendarId: calendar.id, etag: calendar.etag };
          if (name.value.trim() !== calendar.summary) args.summary = name.value.trim();
          if ((description.value.trim() || "") !== (calendar.description ?? "")) args.description = description.value.trim();
          if (zoneSelect.value !== calendar.timeZone) args.timeZone = zoneSelect.value;
          if (Object.keys(args).length === 2) {
            snackbar("Nothing to save");
            return;
          }
          await call("calendars.patch", args, key());
          state.calendars = await listAllCalendars();
          snackbar("Calendar settings saved");
          renderSettings();
          renderSidebar();
        },
        {
          onError: (failure) => {
            error.textContent = describe(failure);
            error.hidden = false;
          },
        },
      ),
    );
    actions.append(save);
    section.append(actions);
  }
  host.append(section);

  const colour = el("section", { class: "gc-settings-section" });
  colour.append(el("h2", { text: "Colour" }), el("p", { text: "Only you see this colour; it is stored on your calendar-list entry." }));
  const palette = el("div", { class: "gc-palette", attrs: { role: "group", "aria-label": "Calendar colour" } });
  for (const [id, entry] of Object.entries(state.colors?.calendar ?? {})) {
    const swatch = el("button", { class: "gc-swatch-btn", title: colorName(entry.background), attrs: { type: "button", "aria-label": colorName(entry.background), "aria-pressed": String(id === calendar.colorId) } });
    swatch.style.background = displayColor(entry.background);
    if (id === calendar.colorId) swatch.append(icon("check"));
    swatch.addEventListener("click", () =>
      action(async () => {
        const updated = await call("calendar-list.patch", { calendarId: calendar.id, colorId: id }, key());
        Object.assign(calendar, updated);
        renderSettings();
        renderSidebar();
        state.loadedRange = null;
        await loadForRoute();
      }),
    );
    palette.append(swatch);
  }
  colour.append(palette);
  host.append(colour);

  const listing = el("section", { class: "gc-settings-section" });
  listing.append(el("h2", { text: "Remove calendar" }));
  const listingActions = el("div", { class: "gc-settings-actions" });
  const hide = el("button", { class: "gc-outlined-btn", text: calendar.hidden ? "Show in list" : "Hide from list", attrs: { type: "button" } });
  hide.addEventListener("click", () =>
    action(async () => {
      const updated = await call("calendar-list.patch", { calendarId: calendar.id, hidden: !calendar.hidden }, key());
      Object.assign(calendar, updated, { hidden: updated.hidden === true });
      renderSettings();
      renderSidebar();
      state.loadedRange = null;
      await loadForRoute();
    }),
  );
  listingActions.append(hide);
  if (owner && !calendar.primary) {
    const remove = el("button", { class: "gc-outlined-btn gc-text-btn-danger", text: "Delete", attrs: { type: "button" } });
    remove.addEventListener("click", () =>
      action(async () => {
        const choice = await confirmDialog("Delete calendar?", `“${calendar.summary}” and all of its events will be deleted permanently for everyone it is shared with. Guests keep cancelled copies.`, { okLabel: "Permanently delete" });
        if (choice !== "ok") return;
        await call("calendars.delete", { calendarId: calendar.id }, key());
        state.calendars = await listAllCalendars();
        snackbar(`Calendar “${calendar.summary}” deleted`);
        navigate("#settings/general");
        renderSidebar();
        state.loadedRange = null;
        await loadForRoute();
      }),
    );
    listingActions.append(remove);
    listing.append(el("p", { text: "You own this calendar. Deleting it removes it for every subscriber." }));
  } else listing.append(el("p", { text: calendar.primary ? "Your primary calendar can't be deleted or unsubscribed." : "You don't own this calendar, so you can only hide it from your list." }));
  listing.append(listingActions);
  host.append(listing);
  return host;
}

// ---------------------------------------------------------------------------------------------
// Header, sidebar and keyboard bindings
// ---------------------------------------------------------------------------------------------

function step(direction) {
  const view = calendarView();
  const date = state.route.date ?? todayKey();
  const next = view === "year" ? T.addMonths(T.firstOfMonth(date), 12 * direction) : view === "4days" ? T.addDays(date, 4 * direction) : view === "day" ? T.addDays(date, direction) : view === "week" ? T.addDays(date, 7 * direction) : view === "month" ? T.addMonths(T.firstOfMonth(date), direction) : T.addDays(date, 28 * direction);
  navigate(`#${view}/${next}`);
}

function bindHeader() {
  $("#menu-toggle").addEventListener("click", () => {
    const app = document.getElementById("app");
    app.classList.toggle("sidebar-closed");
    $("#menu-toggle").setAttribute("aria-expanded", String(!app.classList.contains("sidebar-closed")));
  });
  $("#scrim").hidden = false;
  $("#scrim").addEventListener("click", () => {
    document.getElementById("app").classList.add("sidebar-closed");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  });
  $("#logo-link").addEventListener("click", (event) => {
    event.preventDefault();
    navigate(`#${calendarView()}/${todayKey()}`);
  });
  $("#today-btn").addEventListener("click", () => navigate(`#${calendarView()}/${todayKey()}`));
  $("#prev-btn").addEventListener("click", () => step(-1));
  $("#next-btn").addEventListener("click", () => step(1));
  $("#search-toggle").addEventListener("click", () => {
    navigate("#search/");
    setTimeout(() => $("#search").focus(), 0);
  });
  $("#search-back").addEventListener("click", () => navigate(`#${calendarView()}/${state.route.date ?? todayKey()}`));
  $("#search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const query = $("#search").value.trim();
    if (query) navigate(`#search/${encodeURIComponent(query)}`);
  });
  $("#search").addEventListener("input", () => {
    $("#search-clear").hidden = $("#search").value === "";
  });
  $("#search-clear").addEventListener("click", () => {
    $("#search").value = "";
    $("#search-clear").hidden = true;
    $("#search").focus();
  });
  $("#help-btn").addEventListener("click", () => $("#help-dialog").showModal());
  $("#settings-btn").addEventListener("click", (event) =>
    openMenu(
      event.currentTarget,
      [
        { label: "Settings", icon: "settings", onSelect: () => navigate("#settings/general") },
        { label: "Refresh", icon: "refresh", onSelect: () => refresh(true) },
        "divider",
        { label: "Keyboard shortcuts", icon: "keyboard", onSelect: () => $("#help-dialog").showModal() },
      ],
      { align: "end" },
    ),
  );
  $("#view-btn").addEventListener("click", (event) => {
    const items = Object.entries(VIEWS).map(([id, label]) => ({ label, hint: VIEW_KEYS[id], radio: calendarView() === id, onSelect: () => navigate(`#${id}/${state.route.date ?? todayKey()}`) }));
    items.push(
      "divider",
      {
        label: "Show weekends",
        checked: state.showWeekends,
        onSelect: () => {
          state.showWeekends = !state.showWeekends;
          writePreference("weekends", String(state.showWeekends));
          render();
        },
      },
      {
        label: "Show declined events",
        checked: state.showDeclined,
        onSelect: () => {
          state.showDeclined = !state.showDeclined;
          writePreference("declined", String(state.showDeclined));
          render();
        },
      },
    );
    openMenu(event.currentTarget, items, { align: "end" });
  });
  $("#account-btn").addEventListener("click", (event) => {
    const card = el("div", { class: "gc-menu-account" }, [avatar(state.user.name, state.user.email), el("div", { class: "gc-menu-account-text" }, [el("strong", { text: state.user.name || state.context?.actorId || "" }), el("span", { text: state.user.email }), el("span", { text: `Synthetic account · Firedrill actor ${state.context?.actorId ?? "?"}` })])]);
    openMenu(event.currentTarget, card, { align: "end", className: "gc-menu-wide" });
  });
  $("#banner-retry").addEventListener("click", () => {
    if (state.banner?.retry) void action(() => state.banner.retry(), { exclusive: false });
  });
}

function bindSidebar() {
  $("#create-btn").addEventListener("click", (event) => {
    openMenu(event.currentTarget, [
      { label: "Event", onSelect: () => openQuick({ key: state.route.date ?? todayKey(), anchor: $("#create-btn") }) },
      { label: "Task", onSelect: () => notSimulated($("#create-btn"), "Task", "Google Tasks are not simulated by this Tool. Focus time and Out of office are available as event types in the event editor.") },
      { label: "Appointment schedule", onSelect: () => notSimulated($("#create-btn"), "Appointment schedule", "Appointment schedules and booking pages are not simulated by this Tool.") },
    ], { className: "gc-create-menu" });
  });
  for (const head of $$(".gc-group-head")) {
    head.addEventListener("click", () => {
      head.setAttribute("aria-expanded", String(head.getAttribute("aria-expanded") !== "true"));
    });
  }
  $("#add-calendar-btn").addEventListener("click", (event) => {
    openMenu(event.currentTarget, [
      { label: "Create new calendar", icon: "add", onSelect: () => navigate("#settings/create") },
      { label: "Browse hidden calendars", icon: "visibility_off", disabled: !state.calendars.some((calendar) => calendar.hidden), onSelect: () => openMenu($("#add-calendar-btn"), state.calendars.filter((calendar) => calendar.hidden).map((calendar) => ({ label: calendar.summary, swatch: displayColor(calendar.backgroundColor), onSelect: () => navigate(`#settings/${encodeURIComponent(calendar.id)}`) })), { header: "Hidden calendars" }), keepOpen: true },
    ]);
  });
}

function bindKeyboard() {
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches("input, textarea, select, [contenteditable]") || target.closest("dialog[open]"));
    if (event.key === "Escape") {
      if (state.popover) closePopover();
      else if (state.quick) closeQuick();
      else if (state.route.view === "search") navigate(`#${calendarView()}/${state.route.date ?? todayKey()}`);
      return;
    }
    if (typing) return;
    if (state.editor || state.quick) return;
    switch (event.key) {
      case "t":
        navigate(`#${calendarView()}/${todayKey()}`);
        break;
      case "j":
      case "n":
        step(1);
        break;
      case "k":
      case "p":
        step(-1);
        break;
      case "d":
      case "w":
      case "m":
      case "a":
      case "y":
      case "x": {
        const view = { d: "day", w: "week", m: "month", a: "schedule", y: "year", x: "4days" }[event.key];
        navigate(`#${view}/${state.route.date ?? todayKey()}`);
        break;
      }
      case "c":
        openQuick({ key: state.route.date ?? todayKey(), anchor: $("#create-btn") });
        break;
      case "/":
        event.preventDefault();
        navigate("#search/");
        setTimeout(() => $("#search").focus(), 0);
        break;
      default:
        return;
    }
  });
}

document.addEventListener("pointerdown", (event) => {
  if (state.popover && !$("#popover").contains(event.target) && !event.target.closest(".gc-menu, dialog")) closePopover();
});

let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  const narrow = window.innerWidth <= 768;
  if (narrow && lastWidth > 768) {
    document.getElementById("app").classList.add("sidebar-closed");
    $("#menu-toggle").setAttribute("aria-expanded", "false");
  }
  lastWidth = window.innerWidth;
});

void boot();

// ---------------------------------------------------------------------------------------------
// Drag to create and the year view
// ---------------------------------------------------------------------------------------------

/** Press on an empty slot and drag to size a new event; a plain click opens quick create for 30-minute steps. */
function startDragCreate(down, column, key, slot) {
  if (down.button !== 0) return;
  down.preventDefault();
  const rect = column.getBoundingClientRect();
  const slotAt = (clientY) => Math.max(0, Math.min(47, Math.floor((clientY - rect.top) / (HOUR_PX / 2))));
  let end = slot;
  const ghost = el("div", { class: "gc-chip gc-drag-ghost", attrs: { "aria-hidden": "true" } });
  const paint = () => {
    const from = Math.min(slot, end);
    const to = Math.max(slot, end) + 1;
    ghost.style.top = `${from * (HOUR_PX / 2)}px`;
    ghost.style.height = `${(to - from) * (HOUR_PX / 2) - 1}px`;
    ghost.replaceChildren(el("span", { class: "gc-chip-title", text: "(No title)" }), el("span", { class: "gc-chip-time", text: T.fmtRange(from * 30, to * 30, h24()) }));
  };
  paint();
  column.append(ghost);
  const move = (event) => {
    end = slotAt(event.clientY);
    paint();
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    const from = Math.min(slot, end);
    const to = Math.max(slot, end) + 1;
    openQuick({ key, startMin: from * 30, anchor: ghost });
    ghost.remove();
    if (state.quick && to - from > 1) {
      state.quick.form.endMin = to * 30;
      renderQuick();
    }
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function renderYear() {
  const view = $("#view");
  const year = T.parseKey(state.route.date ?? todayKey()).y;
  const grid = el("div", { class: "gc-year", attrs: { "aria-label": `Year ${year}` } });
  for (let month = 1; month <= 12; month += 1) {
    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    const card = el("section", { class: "gc-year-month", attrs: { "aria-label": `${T.MONTHS[month - 1]} ${year}` } });
    card.append(el("h2", { class: "gc-year-title", text: T.MONTHS[month - 1] }));
    const days = el("div", { class: "gc-mini-grid", attrs: { role: "grid" } });
    for (let index = 0; index < 7; index += 1) {
      const day = (state.settings.weekStart + index) % 7;
      days.append(el("span", { class: "gc-mini-dow", text: T.WEEKDAYS[day].charAt(0), attrs: { "aria-label": T.WEEKDAYS[day] } }));
    }
    for (const row of T.monthGrid(first, state.settings.weekStart)) {
      for (const dayKey of row) {
        const other = T.parseKey(dayKey).m !== month;
        const button = el("button", { class: `gc-mini-day ${other ? "is-other" : ""} ${dayKey === todayKey() ? "is-today" : ""}`.replace(/\s+/g, " ").trim(), text: String(T.parseKey(dayKey).d), attrs: { type: "button", "aria-label": T.fmtLongDate(dayKey, locale(), 0) } });
        button.addEventListener("click", () => navigate(`#day/${dayKey}`));
        days.append(button);
      }
    }
    card.append(days);
    grid.append(card);
  }
  view.replaceChildren(grid);
}
