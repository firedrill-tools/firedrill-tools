// Domains: create with generated DNS records, list, get, instant synthetic verification, remove.
import { checkIdempotencyKey, fail, newId, randomChars, requireUuid, resolveKey, scanAll } from "../lib/core.mjs";
import { present, safeObject } from "../lib/check.mjs";
import { paginate } from "../lib/page.mjs";
import { wireTime } from "../lib/time.mjs";

const REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function oneOf(context, value, allowed, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(context, "VALIDATION_ERROR", `The \`${field}\` field must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

export function validHostname(name) {
  if (name.length < 4 || name.length > 253) return false;
  const labels = name.split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label)) && !/^[0-9]+$/.test(labels[labels.length - 1]);
}

function getDomain(context, rawId) {
  const id = requireUuid(context, rawId);
  const domain = context.state.get("domains", id);
  if (domain === null) fail(context, "NOT_FOUND", "Domain not found");
  return domain;
}

function renderRecord(record) {
  const out = { record: record.record, name: record.name, type: record.type, ttl: record.ttl, status: record.status, value: record.value };
  if (record.priority !== null) out.priority = record.priority;
  return out;
}

function summary(domain) {
  return {
    id: domain.id,
    name: domain.name,
    status: domain.status,
    created_at: wireTime(domain.createdAtUs),
    region: domain.region,
    open_tracking: domain.openTracking,
    click_tracking: domain.clickTracking,
    capabilities: domain.capabilities,
  };
}

export function domainsCreate(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  if (!present(input.name)) fail(context, "MISSING_REQUIRED_FIELD", "Missing `name` field.");
  const name = input.name.trim().toLowerCase();
  if (!validHostname(name)) fail(context, "VALIDATION_ERROR", "The `name` field must be a valid domain name.");
  if (present(input.trackingSubdomain)) fail(context, "VALIDATION_ERROR", "The `tracking_subdomain` field is not supported by this simulated service.");
  const region = oneOf(context, input.region, REGIONS, "region", "us-east-1");
  const tls = oneOf(context, input.tls, ["opportunistic", "enforced"], "tls", "opportunistic");
  let customReturnPath = "send";
  if (present(input.customReturnPath)) {
    customReturnPath = String(input.customReturnPath).toLowerCase();
    if (customReturnPath.length > 63 || !LABEL.test(customReturnPath)) fail(context, "VALIDATION_ERROR", "The `custom_return_path` field must be a single DNS label.");
  }
  const capabilities = { sending: "enabled", receiving: "disabled" };
  if (present(input.capabilities)) {
    const source = safeObject(context, input.capabilities, "capabilities", 2);
    for (const key of Object.keys(source)) {
      if (key !== "sending" && key !== "receiving") fail(context, "VALIDATION_ERROR", "The `capabilities` field accepts only `sending` and `receiving`.");
      capabilities[key] = oneOf(context, source[key], ["enabled", "disabled"], `capabilities.${key}`, capabilities[key]);
    }
  }
  if (context.state.get("domain-names", name) !== null) fail(context, "VALIDATION_ERROR", `The ${name} domain has been registered already`);
  const id = newId(context, "domains");
  const host = `${customReturnPath}.${name}`;
  const records = [
    { record: "SPF", name: host, type: "MX", ttl: "Auto", status: "not_started", value: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
    { record: "SPF", name: host, type: "TXT", ttl: "Auto", status: "not_started", value: '"v=spf1 include:amazonses.com ~all"', priority: null },
    { record: "DKIM", name: `resend._domainkey.${name}`, type: "TXT", ttl: "Auto", status: "not_started", value: `p=${randomChars(context, B64, 216)}`, priority: null },
  ];
  if (capabilities.receiving === "enabled") {
    records.push({ record: "Receiving", name, type: "MX", ttl: "Auto", status: "not_started", value: `inbound-smtp.${region}.amazonaws.com`, priority: 10 });
  }
  const domain = {
    id, name, region, status: "not_started",
    openTracking: input.openTracking === true, clickTracking: input.clickTracking === true,
    tls, customReturnPath, capabilities, records, createdAtUs: context.clock.nowUs(),
  };
  context.state.put("domains", id, domain);
  context.state.put("domain-names", name, { domainId: id });
  const { capabilities: caps, ...rest } = summary(domain);
  return { ...rest, capabilities: caps, records: records.map(renderRecord) };
}

export function domainsList(input, context) {
  resolveKey(context);
  const rows = scanAll(context, "domains").map((record) => record.value);
  return paginate(context, input, rows, summary);
}

export function domainsGet(input, context) {
  resolveKey(context);
  const domain = getDomain(context, input.id);
  return { object: "domain", ...summary(domain), records: domain.records.map(renderRecord) };
}

export function domainsVerify(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const domain = getDomain(context, input.id);
  if (domain.status !== "verified") {
    const status = domain.name.endsWith(".invalid") ? "failed" : "verified";
    context.state.put("domains", domain.id, { ...domain, status, records: domain.records.map((record) => ({ ...record, status })) });
  }
  return { object: "domain", id: domain.id };
}

export function domainsRemove(input, context) {
  resolveKey(context);
  checkIdempotencyKey(context, input);
  const domain = getDomain(context, input.id);
  context.state.delete("domains", domain.id);
  context.state.delete("domain-names", domain.name);
  return { object: "domain", id: domain.id, deleted: true };
}
