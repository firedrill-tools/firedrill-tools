// Input normalisation and validation shared by every launcher and runner. Pure functions plus `fail` calls; every
// check bounds the caller text before any regex runs, and error messages clip what they quote.
import { clip, fail, isPlainObject } from "./core.mjs";

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "proton.me", "example.com"]);
const SOCIAL = new Set(["linkedin.com", "facebook.com", "x.com", "twitter.com", "instagram.com"]);
const ROLE_LOCAL = new Set(["info", "sales", "support", "admin", "hello", "contact", "team", "noreply", "no-reply"]);
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_RE = /^[A-Za-z0-9._%+-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Reject unknown top-level fields the way the upstream validator reports them. */
export function rejectExtraFields(context, input, allowed) {
  for (const name of Object.keys(input)) {
    if (!allowed.has(name)) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${clip(name, 100)}: Extra inputs are not permitted`]);
  }
}

/** Optional string field with a length bound (minimum measured after trimming); `null`/absent → `null`. */
export function optionalString(context, input, name, max, min = 1) {
  if (!Object.hasOwn(input, name) || input[name] === null) return null;
  const value = input[name];
  if (typeof value !== "string") fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${name}: Input should be a valid string`]);
  // Length is measured after trimming so a blank (whitespace-only) value cannot pass as a present identifier.
  if (value.trim().length < min) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${name}: String should have at least ${min} character${min === 1 ? "" : "s"}`]);
  if (value.length > max) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${name}: String should have at most ${max} characters`]);
  return value;
}

/** Trim and collapse internal whitespace. */
export function collapse(text) {
  return text.trim().split(/\s+/).filter((part) => part.length > 0).join(" ");
}

/** True when the text carries U+FFFD (a mangled percent-encoded request). */
export function isMangled(text) {
  return text.includes("�");
}

function hostnameOf(text) {
  if (text.length > 253 || text.length === 0) return null;
  const labels = text.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) if (!LABEL_RE.test(label)) return null;
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) return null;
  return text;
}

/** Normalise a domain (URL accepted) to a lowercase hostname or fail with the documented domain codes. */
export function normalizeDomain(context, value, name = "domain") {
  if (typeof value !== "string" || value.length === 0 || value.length > 2083 || isMangled(value)) {
    fail(context, "VALIDATION_BAD_DOMAIN", `Bad ${name} ${clip(value)}`);
  }
  let text = value.trim().toLowerCase();
  const scheme = text.indexOf("://");
  if (scheme >= 0 && scheme <= 8) text = text.slice(scheme + 3);
  const slash = text.indexOf("/");
  if (slash >= 0) text = text.slice(0, slash);
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  const colon = text.indexOf(":");
  if (colon >= 0) text = text.slice(0, colon);
  if (text.startsWith("www.")) text = text.slice(4);
  const host = hostnameOf(text);
  if (host === null) fail(context, "VALIDATION_BAD_DOMAIN", `Bad ${name} ${clip(value)}`);
  if (FREE_MAIL.has(host)) fail(context, "VALIDATION_BAD_DOMAIN_EMAIL_PROVIDER", `Bad ${name} ${clip(value)}: email provider domain`);
  if (SOCIAL.has(host)) fail(context, "VALIDATION_BAD_DOMAIN_SOCIAL_MEDIA", `Bad ${name} ${clip(value)}: social media domain`);
  return host;
}

/** Lowercase, validated e-mail address; `options.role` rejects role mailboxes. */
export function normalizeEmail(context, value, name, options = {}) {
  if (typeof value !== "string" || value.length < 6 || value.length > 254 || isMangled(value)) {
    fail(context, "VALIDATION_BAD_EMAIL_INVALID", `Bad ${name} ${clip(value)}`);
  }
  const text = value.trim().toLowerCase();
  const at = text.indexOf("@");
  if (at <= 0 || at !== text.lastIndexOf("@")) fail(context, "VALIDATION_BAD_EMAIL_INVALID", `Bad ${name} ${clip(value)}`);
  const local = text.slice(0, at);
  const host = hostnameOf(text.slice(at + 1));
  if (!LOCAL_RE.test(local) || host === null) fail(context, "VALIDATION_BAD_EMAIL_INVALID", `Bad ${name} ${clip(value)}`);
  if (options.role === true && ROLE_LOCAL.has(local)) fail(context, "VALIDATION_BAD_EMAIL_ROLE", `Bad ${name} ${clip(value)}: role email`);
  return `${local}@${host}`;
}

/** LinkedIn URL or bare handle → lowercase id (3–500 chars) or VALIDATION_BAD_REQUEST. */
export function normalizeLinkedin(context, value, name) {
  if (typeof value !== "string" || value.length < 3 || value.length > 2083 || isMangled(value)) {
    fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${name}: Invalid linkedin url`]);
  }
  let text = value.trim().toLowerCase();
  const marker = text.indexOf("linkedin.com/");
  if (marker >= 0) {
    text = text.slice(marker + "linkedin.com/".length);
    const slash = text.indexOf("/");
    if (slash >= 0) text = text.slice(slash + 1);
  }
  const query = text.search(/[?#]/);
  if (query >= 0) text = text.slice(0, query);
  while (text.endsWith("/")) text = text.slice(0, -1);
  if (text.length < 3 || text.length > 500 || !/^[a-z0-9._%-]+$/.test(text)) {
    fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`${name}: Invalid linkedin url`]);
  }
  return text;
}

/** `custom_fields`: ≤ 100 keys of `[A-Za-z0-9_-]`, scalar values; stored on a null-prototype object. */
export function normalizeCustomFields(context, input) {
  if (!Object.hasOwn(input, "custom_fields") || input.custom_fields === null) return {};
  const value = input.custom_fields;
  if (!isPlainObject(value)) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["custom_fields: Input should be a valid dictionary"]);
  const keys = Object.keys(value);
  if (keys.length > 100) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["custom_fields: Dictionary should have at most 100 items"]);
  const fields = Object.create(null);
  for (const key of keys) {
    if (key.length > 100 || !KEY_RE.test(key) || FORBIDDEN_KEYS.has(key)) {
      fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`custom_fields.${clip(key, 100)}: Invalid key`]);
    }
    const item = value[key];
    const scalar = typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)) || (typeof item === "string" && item.length <= 1000);
    if (!scalar) fail(context, "VALIDATION_BAD_REQUEST", "Bad request", [`custom_fields.${clip(key, 100)}: Value must be a string of at most 1000 characters, a number or a boolean`]);
    fields[key] = item;
  }
  return fields;
}

/** Absolute http(s) URL ≤ 2083 characters, checked by hand; `null` when absent. */
export function normalizeWebhook(context, input) {
  if (!Object.hasOwn(input, "webhook_url") || input.webhook_url === null) return null;
  const value = input.webhook_url;
  const bad = () => fail(context, "VALIDATION_BAD_REQUEST", "Bad request", ["webhook_url: Input should be a valid URL"]);
  if (typeof value !== "string" || value.length < 10 || value.length > 2083 || isMangled(value)) bad();
  const lower = value.toLowerCase();
  const scheme = lower.startsWith("https://") ? 8 : lower.startsWith("http://") ? 7 : 0;
  if (scheme === 0) bad();
  const rest = value.slice(scheme);
  const end = rest.search(/[/?#]/);
  const authority = end >= 0 ? rest.slice(0, end) : rest;
  const host = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  const bare = host.includes(":") ? host.slice(0, host.indexOf(":")) : host;
  if (hostnameOf(bare.toLowerCase()) === null && bare !== "localhost") bad();
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f) bad();
  }
  return value;
}
