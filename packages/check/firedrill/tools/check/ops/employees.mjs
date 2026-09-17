// Employees: list, retrieve, create, update. Only the last four SSN digits are ever stored.
import { inScope, requireKey } from "../lib/access.mjs";
import { formatDate, parseDate, today } from "../lib/dates.mjs";
import { isId, nextId } from "../lib/ids.mjs";
import { keyComparator, limitArg, pageOf } from "../lib/paging.mjs";
import { activeOn, mustFind } from "../lib/records.mjs";
import { employeeOut } from "../lib/serialize.mjs";
import { scanAll } from "../lib/store.mjs";
import { address, bad, bool, choice, date, email, hasOwn, metadata, requireField, text } from "../lib/validate.mjs";
import { boolFilter, cursorArg, idFilter, refFilter } from "./common.mjs";

const METHODS = ["manual", "direct_deposit"];
const READ_ONLY = { id: "This field is read-only.", company: "This field cannot be changed.", bank_accounts: "This field is read-only.", onboard: "This field is read-only.", active: "This field is read-only." };

export function employeesList(input, context) {
  const key = requireKey(context, false);
  const filters = {};
  const company = refFilter(context, input, filters, "company", "com");
  let workplaces;
  if (hasOwn(input, "workplace")) {
    const raw = input.workplace;
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").filter((part) => part !== "") : null;
    if (list === null || list.length === 0 || list.length > 100 || !list.every((id) => isId("wrk", id))) bad(context, "workplace", "Invalid workplace id.");
    filters.workplace = list.join(",");
    workplaces = new Set(list);
  }
  const active = boolFilter(context, input, filters, "active", undefined);
  const ids = idFilter(context, input, filters);
  const limit = limitArg(context, input, 100);
  const cursor = cursorArg(context, input);
  const day = today(context);
  const keyOf = (row) => [row.last_name, row.first_name, row.seq];
  const compare = keyComparator();
  const rows = scanAll(context, "employees")
    .filter((row) => inScope(key, row.company) && (company === undefined || row.company === company)
      && (workplaces === undefined || row.workplaces.some((id) => workplaces.has(id)))
      && (active === undefined || activeOn(row, day) === active) && (ids === undefined || ids.has(row.id)))
    .sort((a, b) => compare(keyOf(a), keyOf(b)));
  return pageOf(context, { resource: "employees", path: "/employees", rows, filters, limit, cursor, keyTypes: ["s", "s", "i"], keyOf, compare, map: (row) => employeeOut(context, row) });
}

export function employeesGet(input, context) {
  const key = requireKey(context, false);
  return employeeOut(context, mustFind(context, key, "employees", input.employee, "employee"));
}

/** Validates the writable fields present in `input` into `patch`; `current` is the stored row on update. */
function applyFields(context, key, input, patch, companyId, current) {
  const day = today(context);
  if (hasOwn(input, "first_name")) patch.first_name = text(context, input.first_name, "first_name", 100, { required: true });
  if (hasOwn(input, "last_name")) patch.last_name = text(context, input.last_name, "last_name", 100, { required: true });
  if (hasOwn(input, "middle_name")) patch.middle_name = text(context, input.middle_name, "middle_name", 100, { nullable: true });
  if (hasOwn(input, "email")) patch.email = email(context, input.email, "email");
  if (hasOwn(input, "dob")) {
    const dob = date(context, input.dob, "dob", { nullable: true });
    if (dob !== null && (dob > day - 14 * 365 || dob < day - 121 * 365)) bad(context, "dob", "Employee must be between 14 and 120 years old.");
    patch.dob = dob === null ? null : formatDate(dob);
  }
  if (hasOwn(input, "residence")) patch.residence = input.residence === null ? null : address(context, input.residence, "residence");
  if (hasOwn(input, "start_date")) patch.start_date = formatDate(date(context, input.start_date, "start_date"));
  if (hasOwn(input, "termination_date")) {
    const end = date(context, input.termination_date, "termination_date", { nullable: true });
    patch.termination_date = end === null ? null : formatDate(end);
  }
  if (hasOwn(input, "payment_method_preference")) patch.payment_method_preference = choice(context, input.payment_method_preference, METHODS, "payment_method_preference");
  if (hasOwn(input, "w2_electronic_consent_provided")) patch.w2_electronic_consent_provided = bool(context, input.w2_electronic_consent_provided, "w2_electronic_consent_provided");
  if (hasOwn(input, "metadata")) patch.metadata = metadata(context, input.metadata);
  if (hasOwn(input, "ssn")) {
    if (typeof input.ssn !== "string" || !/^[0-9]{9}$/.test(input.ssn) || input.ssn.startsWith("000") || input.ssn.startsWith("9")) bad(context, "ssn", "Enter a valid nine-digit SSN.");
    patch.ssn_last_four = input.ssn.slice(5);
    patch.ssn_validation_status = "pending";
  }
  if (hasOwn(input, "workplaces")) {
    const list = input.workplaces;
    if (!Array.isArray(list) || list.length < 1 || list.length > 20) bad(context, "workplaces", "Provide between 1 and 20 workplaces.");
    list.forEach((id, i) => {
      const row = isId("wrk", id) ? context.state.get("workplaces", id) : null;
      if (row === null || !inScope(key, row.company)) bad(context, `workplaces.${i}`, "Workplace not found.");
      if (row.company !== companyId) bad(context, `workplaces.${i}`, "Workplace belongs to another company.");
      if (!row.active && !(current?.workplaces ?? []).includes(id)) bad(context, `workplaces.${i}`, "Workplace is not active.");
    });
    if (new Set(list).size !== list.length) bad(context, "workplaces", "Workplaces must be unique.");
    patch.workplaces = [...list];
  }
  const workplaces = patch.workplaces ?? current?.workplaces ?? [];
  if (hasOwn(input, "primary_workplace")) {
    if (typeof input.primary_workplace !== "string" || !workplaces.includes(input.primary_workplace)) bad(context, "primary_workplace", "Primary workplace must be one of the employee's workplaces.");
    patch.primary_workplace = input.primary_workplace;
  } else if (current !== undefined && !workplaces.includes(current.primary_workplace)) {
    bad(context, "primary_workplace", "Primary workplace must be one of the employee's workplaces.");
  }
  const start = parseDate(patch.start_date ?? current?.start_date);
  const end = patch.termination_date !== undefined ? patch.termination_date : current?.termination_date ?? null;
  if (end !== null && start !== null && parseDate(end) < start) bad(context, "termination_date", "Termination date must be on or after the start date.");
}

export function employeesCreate(input, context) {
  const key = requireKey(context, true);
  for (const field of ["company", "first_name", "last_name", "workplaces"]) requireField(context, input, field);
  if (hasOwn(input, "termination_date")) bad(context, "termination_date", "Set a termination date by updating the employee.");
  const company = mustFind(context, key, "companies", input.company, "company");
  const patch = {};
  applyFields(context, key, input, patch, company.id, undefined);
  const { id, seq } = nextId(context, "emp", "employees");
  const row = {
    id, seq, company: company.id, first_name: patch.first_name, middle_name: patch.middle_name ?? null, last_name: patch.last_name,
    email: patch.email ?? null, dob: patch.dob ?? null, residence: patch.residence ?? null, workplaces: patch.workplaces,
    primary_workplace: patch.primary_workplace ?? patch.workplaces[0], start_date: patch.start_date ?? formatDate(today(context)),
    termination_date: null, payment_method_preference: patch.payment_method_preference ?? "manual", has_bank_account: false,
    ssn_last_four: patch.ssn_last_four ?? null, ssn_validation_status: patch.ssn_validation_status ?? null,
    w2_electronic_consent_provided: patch.w2_electronic_consent_provided ?? false, metadata: patch.metadata ?? {},
  };
  context.state.put("employees", id, row);
  return employeeOut(context, row);
}

export function employeesUpdate(input, context) {
  const key = requireKey(context, true);
  for (const field of Object.keys(READ_ONLY)) if (hasOwn(input, field)) bad(context, field, READ_ONLY[field]);
  const current = mustFind(context, key, "employees", input.employee, "employee");
  const patch = {};
  applyFields(context, key, input, patch, current.company, current);
  const row = { ...current, ...patch };
  context.state.put("employees", row.id, row);
  return employeeOut(context, row);
}
