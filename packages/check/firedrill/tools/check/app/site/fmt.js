// Formatting, form controls and small presentational pieces shared by the Console screens.
// Dates are formatted in UTC from world virtual time only; the browser clock is never read.
import { el } from "./ui.js";

let fieldSeq = 0;
export function field(label, control, { hint, full = false, name } = {}) {
  fieldSeq += 1;
  const id = `fld-${fieldSeq}`;
  control.id = id;
  return el("div", { class: `field${full ? " field-full" : ""}`, attrs: { "data-field": name || control.name || undefined } }, [
    el("label", { text: label, attrs: { for: id } }),
    control,
    hint ? el("div", { class: "field-hint", text: hint }) : null,
    el("div", { class: "field-error", attrs: { "aria-live": "polite" } }),
  ]);
}
export function input(name, value = "", attrs = {}) {
  return el("input", { class: "input", attrs: { name, value: value ?? "", type: "text", ...attrs } });
}
export function select(name, options, value) {
  return el("select", { class: "input" , attrs: { name } }, options.map(([v, label]) => el("option", { text: label, attrs: { value: v, selected: String(v) === String(value) } })));
}
export function showFieldError(form, error, message) {
  for (const slot of form.querySelectorAll(".field-error")) slot.textContent = "";
  const name = typeof error === "string" ? error : error?.field;
  const text = message ?? error?.message ?? "";
  const leaf = name ? String(name).split(/[.[\]]/).filter(Boolean).pop() : undefined;
  const target = name && (form.querySelector(`[data-field="${CSS.escape(name)}"] .field-error`) ?? (leaf ? form.querySelector(`[data-field="${CSS.escape(leaf)}"] .field-error`) : null));
  if (target) target.textContent = text;
  return Boolean(target);
}

/** Check money values are decimal strings such as "1234.56"; render them as US dollars. */
export function money(amount, { blank = "—", sign = false } = {}) {
  if (amount === "" || amount === null || amount === undefined) return blank;
  const raw = String(amount);
  const negative = raw.startsWith("-");
  const [whole, frac = "00"] = raw.replace("-", "").split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const prefix = negative ? "-$" : sign ? "+$" : "$";
  return `${prefix}${grouped}.${frac.padEnd(2, "0").slice(0, 2)}`;
}
export function hours(value) {
  if (value === null || value === undefined || value === "") return "—";
  return `${String(value)} h`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** `2026-09-25` → `Sep 25, 2026`. Parsed as UTC so the host time zone cannot change the result. */
export function day(iso, { weekday = false, year = true } = {}) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "—";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "—";
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ""}`;
  return weekday ? `${DAYS[d.getUTCDay()]}, ${base}` : base;
}
export function stamp(iso, { time = true } = {}) {
  if (typeof iso !== "string" || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const base = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return time ? `${base}, ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC` : base;
}
export const dayOf = (iso) => (typeof iso === "string" ? iso.slice(0, 10) : "");
/** Whole days from `fromIso` to `toIso`, both treated as UTC instants. */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / 86400000);
}
/** "in 2 days", "today", "3 days ago" — relative to world time, never the browser clock. */
export function relativeDay(iso, nowIso) {
  const diff = daysBetween(`${dayOf(nowIso)}T00:00:00Z`, `${dayOf(iso)}T00:00:00Z`);
  if (diff === undefined) return "";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
}
/** Countdown to a deadline instant, e.g. "2d 7h left" or "passed". */
export function countdown(deadlineIso, nowIso) {
  const a = Date.parse(nowIso);
  const b = Date.parse(deadlineIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  const ms = b - a;
  if (ms <= 0) return "deadline passed";
  const totalMinutes = Math.floor(ms / 60000);
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

const WORDS = {
  llc: "LLC", s_corporation: "S corporation", c_corporation: "C corporation", sole_proprietorship: "Sole proprietorship",
  partnership: "Partnership", non_profit: "Non-profit", weekly: "Weekly", biweekly: "Every other week",
  semimonthly: "Twice a month", monthly: "Monthly", quarterly: "Quarterly", annually: "Annually",
  off_cycle: "Off-cycle", regular: "Regular", direct_deposit: "Direct deposit", manual: "Manual check",
  one_day: "1-day", two_day: "2-day", four_day: "4-day", hourly: "Hourly", annual: "Salary", piece: "Per piece",
  cash_tips: "Cash tips", paycheck_tips: "Paycheck tips", double_overtime: "Double overtime", overtime: "Overtime",
  pto: "PTO", sick: "Sick", salaried: "Salaried", bonus: "Bonus", commission: "Commission", severance: "Severance",
  needs_attention: "Needs attention", blocking: "Blocking", completed: "Completed", draft: "Draft", pending: "Pending",
  processing: "Processing", paid: "Paid", partially_paid: "Partially paid", failed: "Failed", valid: "Valid",
  invalid: "Invalid", pending_verification: "Pending verification",
};
export const human = (value) => {
  const key = String(value ?? "");
  if (key === "") return "—";
  return Object.hasOwn(WORDS, key) ? WORDS[key] : key.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
};

const TONES = {
  paid: "green", completed: "green", active: "green", valid: "green", approved: "green",
  draft: "grey", pending: "amber", processing: "amber", needs_attention: "amber", pending_verification: "amber",
  blocking: "red", failed: "red", invalid: "red", inactive: "grey", terminated: "grey", partially_paid: "amber",
};
export function pill(status, label) {
  const key = String(status ?? "");
  const tone = Object.hasOwn(TONES, key) ? TONES[key] : "grey";
  return el("span", { class: `pill pill-${tone}` }, [el("span", { class: "dot" }), el("span", { text: label ?? human(key) })]);
}
export function initials(...parts) {
  const letters = parts.filter(Boolean).map((p) => String(p).trim()[0]).filter(Boolean).slice(0, 2);
  return letters.join("").toUpperCase() || "?";
}
export const fullName = (e) => [e?.first_name, e?.middle_name, e?.last_name].filter(Boolean).join(" ");
export function addressLine(address) {
  if (!address) return "—";
  const city = [address.city, address.state].filter(Boolean).join(", ");
  return [address.line1, address.line2, city, address.postal_code].filter(Boolean).join(" · ");
}
export function stateOf(address) {
  return address && typeof address.state === "string" ? address.state : "—";
}
