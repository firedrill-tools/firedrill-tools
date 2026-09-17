// Input validation shared by handlers: provider-style BAD_REQUEST for malformed values, INVALID_REQUEST for rules.
import { DATE_FORMATS, TIMEZONES } from "./dates.mjs";
import { bad, invalid } from "./errors.mjs";
import { isObject, lower, toInt, toNumber, utf8Bytes } from "./util.mjs";

export const ROLES = new Set(["SIGNER", "APPROVER", "VIEWER", "CC", "ASSISTANT"]);
export const ACTION_ROLES = new Set(["SIGNER", "APPROVER", "VIEWER", "ASSISTANT"]);
export const VISIBILITIES = new Set(["EVERYONE", "MANAGER_AND_ABOVE", "ADMIN"]);
export const FIELD_TYPES = new Set(["SIGNATURE", "INITIALS", "NAME", "EMAIL", "DATE", "TEXT", "CHECKBOX"]);
const ACCESS_AUTH = new Set(["ACCOUNT"]);
const ACTION_AUTH = new Set(["ACCOUNT", "PASSKEY", "TWO_FACTOR_AUTH", "PASSWORD", "EXPLICIT_NONE"]);
const LANGUAGES = new Set(["de", "en", "fr", "es", "it", "pl", "pt-BR", "ja", "ko", "zh", "nl"]);
const UNSUPPORTED_META = ["emailSettings", "emailId", "emailReplyTo", "envelopeExpirationPeriod", "allowDictateNextSigner"];

export const DEFAULT_META = Object.freeze({
  subject: null, message: null, timezone: "Etc/UTC", dateFormat: "yyyy-MM-dd hh:mm a", distributionMethod: "EMAIL", signingOrder: "PARALLEL",
  redirectUrl: null, language: "en", typedSignatureEnabled: true, uploadSignatureEnabled: true, drawSignatureEnabled: true,
});

const given = (value) => value !== undefined;

export function title(context, value, name = "title") {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 255) bad(context, `${name} must be between 1 and 255 characters`);
  return value;
}

export function externalId(context, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 255) bad(context, "externalId must be at most 255 characters");
  return value;
}

export function visibility(context, value) {
  if (typeof value !== "string" || !VISIBILITIES.has(value)) bad(context, "visibility must be one of EVERYONE, MANAGER_AND_ABOVE, ADMIN");
  return value;
}

export function authList(context, value, name, allowed) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) bad(context, `${name} must be an array of at most 8 values`);
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) bad(context, `${name} contains an unsupported value`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
export const accessAuth = (context, value, name = "accessAuth") => authList(context, value, name, ACCESS_AUTH);
export const actionAuth = (context, value, name = "actionAuth") => authList(context, value, name, ACTION_AUTH);

export function email(context, value, name = "email") {
  const text = typeof value === "string" ? value.trim() : "";
  const at = text.indexOf("@");
  const domain = text.slice(at + 1);
  const ok = text.length >= 3 && text.length <= 254 && at > 0 && at === text.lastIndexOf("@") && /^[^\s]+$/.test(text) &&
    domain.indexOf(".") > 0 && !domain.endsWith(".");
  if (!ok) bad(context, `${name} must be a valid email address`);
  return lower(text);
}

function boolValue(context, value, name) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "false") return value === "true";
  return bad(context, `${name} must be a boolean`);
}

/** Applies a provider `meta` object onto `current`; `allowSigningOrder` false for distribute. */
export function applyMeta(context, current, input, { allowSigningOrder = true } = {}) {
  const meta = { ...current };
  if (input === undefined || input === null) return meta;
  if (!isObject(input)) bad(context, "meta must be an object");
  for (const key of UNSUPPORTED_META) if (given(input[key])) bad(context, `meta.${key} is not supported by this simulation`);
  const text = (key, max) => {
    if (!given(input[key])) return;
    if (input[key] !== null && (typeof input[key] !== "string" || input[key].length > max)) bad(context, `meta.${key} must be at most ${max} characters`);
    meta[key] = input[key];
  };
  text("subject", 254);
  text("message", 5000);
  const choice = (key, allowed) => {
    if (!given(input[key])) return;
    if (typeof input[key] !== "string" || !allowed.has(input[key])) bad(context, `meta.${key} has an unsupported value`);
    meta[key] = input[key];
  };
  choice("timezone", TIMEZONES);
  choice("dateFormat", DATE_FORMATS);
  choice("distributionMethod", new Set(["EMAIL", "NONE"]));
  choice("language", LANGUAGES);
  if (given(input.signingOrder)) {
    if (!allowSigningOrder) bad(context, "meta.signingOrder cannot be changed when distributing");
    choice("signingOrder", new Set(["PARALLEL", "SEQUENTIAL"]));
  }
  if (given(input.redirectUrl)) {
    const url = input.redirectUrl;
    if (url !== null && (typeof url !== "string" || url.length > 2048 || !/^https?:\/\/[^\s/]+[^\s]*$/.test(url))) {
      bad(context, "meta.redirectUrl must be an http or https URL");
    }
    meta.redirectUrl = url;
  }
  for (const key of ["typedSignatureEnabled", "uploadSignatureEnabled", "drawSignatureEnabled"]) {
    if (given(input[key])) meta[key] = boolValue(context, input[key], `meta.${key}`);
  }
  if (!meta.typedSignatureEnabled && !meta.uploadSignatureEnabled && !meta.drawSignatureEnabled) {
    bad(context, "At least one signature type must be enabled");
  }
  return meta;
}

/** A recipient definition (create, create-many, update); `partial` leaves absent keys undefined. */
export function recipientInput(context, input, { partial = false } = {}) {
  if (!isObject(input)) bad(context, "recipient must be an object");
  const out = {};
  if (!partial || given(input.email)) out.email = email(context, input.email);
  if (!partial || given(input.name)) {
    const name = input.name ?? "";
    if (typeof name !== "string" || name.length > 255) bad(context, "name must be at most 255 characters");
    out.name = name;
  }
  if (!partial || given(input.role)) {
    if (typeof input.role !== "string" || !ROLES.has(input.role)) bad(context, "role must be one of SIGNER, APPROVER, VIEWER, CC, ASSISTANT");
    out.role = input.role;
  }
  if (!partial || given(input.signingOrder)) {
    const order = input.signingOrder ?? null;
    out.signingOrder = order === null ? null : toInt(order, 1, 1000);
    if (order !== null && out.signingOrder === null) bad(context, "signingOrder must be an integer between 1 and 1000");
  }
  if (!partial || given(input.accessAuth)) out.accessAuth = accessAuth(context, input.accessAuth);
  if (!partial || given(input.actionAuth)) out.actionAuth = actionAuth(context, input.actionAuth);
  return out;
}

/** The uploaded synthetic text file: name, UTF-8 content (at most 65,536 bytes) and its form-feed separated pages. */
export function fileInput(context, file) {
  if (!isObject(file) || typeof file.name !== "string" || typeof file.content !== "string") bad(context, "file is required");
  if (file.name.trim().length === 0 || file.name.length > 255) bad(context, "file name must be between 1 and 255 characters");
  if (utf8Bytes(file.content) > 65536) bad(context, "File is too large: this simulation accepts UTF-8 text files up to 65536 bytes");
  const pageCount = file.content.split("\f").length;
  if (pageCount > 50) bad(context, "File has more than 50 pages");
  return { name: file.name, content: file.content, pageCount };
}
