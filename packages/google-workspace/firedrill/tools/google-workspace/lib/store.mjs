// State access: bounded scans, the id counter row, the object cap guard and row-id construction.
import { OBJECT_CAP, SCAN_BOUND, objectCapExceeded, scanBoundExceeded } from "./errors.mjs";
import { pad } from "./util.mjs";

export const DEFAULT_META = {
  nextContactId: 1,
  nextOtherContactId: 1,
  nextGroupId: 1,
  nextSubscriptionId: 1,
  nextOperationId: 1,
  nextScriptId: 1,
  nextDeploymentId: 1,
  nextExecutionSeq: 1,
  objectCount: 0,
};

const CHUNK = 512;

/** Scans a whole namespace. A scan that fills the bound could be incomplete, so it fails instead of truncating. */
export function scanAll(context, namespace, bound = SCAN_BOUND) {
  const rows = context.state.scan(namespace, { limit: bound + 1 });
  if (rows.length > bound) scanBoundExceeded(context, namespace);
  return rows;
}

/** Scans every row whose id starts with `prefix`, in row-id order, completely. */
export function scanPrefix(context, namespace, prefix, bound = SCAN_BOUND) {
  const out = [];
  let after = prefix;
  for (;;) {
    const rows = context.state.scan(namespace, { afterRowId: after, limit: CHUNK });
    for (const row of rows) {
      if (!row.rowId.startsWith(prefix)) return out;
      out.push(row);
      if (out.length > bound) scanBoundExceeded(context, namespace);
    }
    if (rows.length < CHUNK) return out;
    after = rows[rows.length - 1].rowId;
  }
}

export function readMeta(context) {
  const row = context.state.get("meta", "counters");
  return { ...DEFAULT_META, ...(row ?? {}) };
}

/** Read by every operation that scans state: a broken invariant must not produce a short answer. */
export function guardedMeta(context) {
  const meta = readMeta(context);
  if (meta.objectCount > OBJECT_CAP) objectCapExceeded(context);
  return meta;
}

export const saveMeta = (context, meta) => context.state.put("meta", "counters", meta);

export function reserveObjects(context, meta, count) {
  if (meta.objectCount + count > OBJECT_CAP) objectCapExceeded(context);
  meta.objectCount += count;
}

export function releaseObjects(meta, count) {
  meta.objectCount = Math.max(0, meta.objectCount - count);
}

// Google contact ids are `c` + 19 digits. Both series are derived from the counter, so they are stable across replays.
export const contactIdFor = (n) => `c${pad(String(3100000000000000000n + BigInt(n)), 19)}`;
export const otherContactIdFor = (n) => `c${pad(String(4100000000000000000n + BigInt(n)), 19)}`;

// Exact 32-bit state machine so every derived id is identical on every machine and every replay.
const step = (value, salt) => (Math.imul(value, 1103515245) + 12345 + salt) >>> 0;

const HEX = "0123456789abcdef";
/** User contact-group ids are 16 lowercase hex characters; derived from the counter, never random. */
export function groupIdFor(n) {
  let value = (Math.imul(n, 2654435761) + 1013904223) >>> 0;
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    value = step(value, i * 7919);
    out += HEX[(value >>> 11) & 15];
  }
  return out;
}

/** Workspace Events subscription ids are uuid-shaped; derived from the counter. */
export function subscriptionIdFor(n) {
  return `0a1b2c3d-${pad((n >>> 0).toString(16), 4).slice(-4)}-4d5e-8f60-${pad(String(n), 12)}`;
}

export const operationIdFor = (n) => `op${pad(n, 16)}`;

const SCRIPT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
/** Apps Script ids: `1` followed by 43 characters of the Drive id alphabet, derived from the counter. */
export function scriptIdFor(n) {
  let out = "1";
  let value = (Math.imul(n, 2654435761) + 1013904223) >>> 0;
  for (let i = 0; i < 43; i += 1) {
    value = step(value, i * 7919);
    out += SCRIPT_CHARS[(value >>> 9) & 63];
  }
  return out;
}

/** Deployment ids: `AKfycb` plus 30 characters of the same alphabet. */
export function deploymentIdFor(n) {
  let out = "AKfycb";
  let value = (Math.imul(n, 40503) + 7919) >>> 0;
  for (let i = 0; i < 30; i += 1) {
    value = step(value, i * 2654435761);
    out += SCRIPT_CHARS[(value >>> 9) & 63];
  }
  return out;
}

export const contactRowId = (ownerUserId, contactId) => `${ownerUserId}:${contactId}`;
export const groupRowId = (ownerUserId, groupId) => `${ownerUserId}:${groupId}`;
export const memberRowId = (ownerUserId, groupId, contactId) => `${ownerUserId}:${groupId}:${contactId}`;
export const contentRowId = (scriptId, versionNumber) =>
  versionNumber === null || versionNumber === undefined ? `${scriptId}:HEAD` : `${scriptId}:v${pad(versionNumber, 6)}`;
export const versionRowId = (scriptId, versionNumber) => `${scriptId}:${pad(versionNumber, 6)}`;
export const executionRowId = (userId, startTimeUs, seq) => `${userId}:${pad(startTimeUs, 16)}:${pad(seq, 4)}`;
export const resourceRowId = (targetResource) => `r:${targetResource.slice(0, 200)}`;
