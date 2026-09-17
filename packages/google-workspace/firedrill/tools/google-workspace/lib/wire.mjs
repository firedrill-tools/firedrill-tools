// Pure HTTP codecs. A request the codec cannot map travels as `__request_error`, a declared optional argument the
// handler checks first, so the caller receives Google's own envelope and status instead of a framework message.
// The name is reserved: it is stripped from anything a caller sends, so it can never be spoofed.
import { ERRORS } from "./errors.mjs";
import { clip } from "./util.mjs";

const MAX_DEPTH = 512;
const MAX_REPEATS = 64;
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RESERVED = "__request_error";

export const refuse = (message) => ({ arguments: { __request_error: clip(message, 300) } });

const last = (values) => (Array.isArray(values) && values.length > 0 ? values[Math.min(values.length, MAX_REPEATS) - 1] : undefined);

const all = (values) => (Array.isArray(values) ? values.slice(0, MAX_REPEATS) : []);

/** Iterative depth and key check; never recursive, so a deeply nested body cannot overflow the stack. */
function shapeProblem(value) {
  const stack = [[value, 1]];
  let visited = 0;
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > MAX_DEPTH) return "request body is nested too deeply";
    if (node === null || typeof node !== "object") continue;
    visited += 1;
    if (visited > 20000) return "request body has too many members";
    if (!Array.isArray(node)) {
      for (const key of Object.keys(node)) {
        if (BANNED_KEYS.has(key)) return `unknown name "${clip(key, 60)}"`;
        if (key.length > 200) return `unknown name "${clip(key, 60)}"`;
      }
    } else if (node.length > 20000) {
      return "request body has too many array entries";
    }
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  if (Object.hasOwn(value, "__proto__")) return 'unknown name "__proto__"';
  return null;
}

// Query-value converters. A value that does not convert is passed through unchanged so the handler answers with
// Google's own envelope rather than a framework mapping error.
const intOrRaw = (value) => (typeof value === "string" && /^-?[0-9]{1,9}$/.test(value) ? Number(value) : value);
const boolOrRaw = (value) => (value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value);

export const Q = {
  str: (value) => value,
  int: intOrRaw,
  bool: boolOrRaw,
  list: (values) => all(values),
};

function idempotency(request) {
  const key = last(request.headers["idempotency-key"]);
  return typeof key === "string" && key.length > 0 && key.length <= 255 ? { idempotencyKey: key } : {};
}

/**
 * Builds a decoder.
 * `path`   — map of path parameter name -> argument name, or `{ name, prefix }` to rebuild a resource name.
 * `query`  — map of query parameter name -> converter; a name ending in `[]` collects every repetition.
 * `body`   — "none" | "json"; a JSON body's own members become arguments.
 * `bodyKey`— when set, the whole JSON body becomes that single argument instead.
 * `custom` — a Google custom method spelled `<head>:<method>` inside one path segment.
 * `nest`   — `{ prefix, name }` gathers `prefix.*` query parameters into one nested object argument.
 */
export function decoder({ path = {}, query = {}, body = "none", bodyKey = null, custom = null, nest = null }) {
  return (request) => {
    const args = Object.create(null);
    for (const [name, spec] of Object.entries(query)) {
      if (name === RESERVED) continue;
      if (name.endsWith("[]")) {
        const key = name.slice(0, -2);
        const values = all(request.query[key]);
        if (values.length > 0) args[key] = values;
        continue;
      }
      const value = last(request.query[name]);
      if (value !== undefined) args[name] = spec(value);
    }

    if (body === "json") {
      const value = request.body.kind === "json" ? request.body.value : undefined;
      if (value !== undefined) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("request body must be a JSON object");
        const problem = shapeProblem(value);
        if (problem !== null) return refuse(problem);
        if (bodyKey === null) {
          for (const [key, member] of Object.entries(value)) {
            if (key === RESERVED || Object.hasOwn(args, key)) continue;
            args[key] = member;
          }
        } else {
          args[bodyKey] = value;
        }
      } else if (request.body.kind === "text" && request.body.value.trim().length > 0) {
        return refuse("request body must be JSON");
      }
    }

    for (const [param, spec] of Object.entries(path)) {
      const raw = typeof request.path[param] === "string" ? request.path[param] : "";
      if (typeof spec === "string") args[spec] = raw;
      else args[spec.name] = `${spec.prefix ?? ""}${raw}`;
    }

    if (nest !== null) {
      const nested = Object.create(null);
      let any = false;
      for (const key of Object.keys(args)) {
        if (!key.startsWith(`${nest.prefix}.`)) continue;
        nested[key.slice(nest.prefix.length + 1)] = args[key];
        delete args[key];
        any = true;
      }
      if (any) args[nest.name] = { ...nested };
    }

    if (custom !== null) {
      const raw = typeof request.path[custom.param] === "string" ? request.path[custom.param] : "";
      const cut = raw.lastIndexOf(":");
      const head = cut < 0 ? "" : raw.slice(0, cut);
      const suffix = cut < 0 ? null : raw.slice(cut + 1);
      if (suffix !== custom.method || (custom.head !== undefined && custom.head !== head)) {
        // The URL is not this Google custom method, so it is not a Google endpoint at all. Placeholders keep the
        // operation's required arguments present, so the handler answers NOT_FOUND with the provider's envelope.
        return { arguments: { ...(custom.notFoundArgs ?? {}), __request_error: "__not_found__" } };
      }
      if (custom.name !== undefined) args[custom.name] = `${custom.prefix ?? ""}${head}`;
    }

    return { arguments: { ...args }, ...idempotency(request) };
  };
}

const RETRY_AFTER = new Map([["RESOURCE_EXHAUSTED", "30"], ["UNAVAILABLE", "5"]]);

/** Builds the google.rpc.Status error body for a route of `service` (the production host) and RPC `method`. */
export function errorEncoder(service, method) {
  return ({ invocation, outcome }) => {
    const error = outcome.error ?? {};
    const refusal = invocation?.arguments?.__request_error;
    let code = String(error.code ?? "").replace(/^tool\./, "");
    if (outcome.status === "invalid") code = "INVALID_ARGUMENT";
    else if (outcome.status === "denied") code = "PERMISSION_DENIED";
    else if (outcome.status === "unsupported") code = "NOT_FOUND";
    if (refusal === "__not_found__") code = "NOT_FOUND";
    const [status, canonical, defaultReason] = ERRORS.get(code) ?? [500, "INTERNAL", "BACKEND_ERROR"];

    let message = typeof error.message === "string" && error.message.length > 0 ? error.message : "Request could not be processed.";
    if (refusal === "__not_found__") {
      message = "Method not found.";
    } else if (outcome.status === "invalid") {
      if (typeof refusal === "string") message = `Request contains an invalid argument: ${refusal}`;
      else if (Array.isArray(error.issues) && error.issues.length > 0) {
        const issue = error.issues[0];
        const where = Array.isArray(issue.path) && issue.path.length > 0 ? clip(issue.path.join("."), 80) : "request";
        message = `Invalid value at '${where}': ${clip(String(issue.message ?? "invalid value"), 200)}`;
      } else message = `Request contains an invalid argument. ${clip(message, 300)}`;
    } else if (outcome.status === "denied") {
      message = "The caller does not have permission to call this method.";
    }

    const reason = typeof error.details?.reason === "string" ? error.details.reason : defaultReason;
    const metadata = error.details?.metadata;
    const detail = {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason,
      domain: "googleapis.com",
      metadata: {
        service,
        method,
        ...(metadata !== null && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      },
    };
    const retryAfter = RETRY_AFTER.get(code);
    return {
      ...(retryAfter === undefined ? {} : { headers: { "retry-after": retryAfter } }),
      body: { kind: "json", value: { error: { code: status, message: clip(message, 2000), status: canonical, details: [detail] } } },
    };
  };
}

/** Success -> the value as JSON; failure -> Google's error envelope. */
export function jsonEncoder(service, method) {
  const onError = errorEncoder(service, method);
  return (result) => (result.outcome.status === "ok" ? { body: { kind: "json", value: result.outcome.value } } : onError(result));
}

export const PEOPLE_SERVICE = "people.googleapis.com";
export const EVENTS_SERVICE = "workspaceevents.googleapis.com";
export const SCRIPT_SERVICE = "script.googleapis.com";
