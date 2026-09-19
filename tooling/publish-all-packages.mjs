#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org";
const ORGANIZATION = "firedrill-tools";
const MAX_PUBLISHES_PER_ACCOUNT = 25;
const MAX_CHILD_BATCH = 10;
const PUBLISHERS = [
  { slot: "A", username: "kirandas", tokenVariable: "NPM_TOKEN_PUBLISHER_A" },
  { slot: "B", username: "kiran.epic", tokenVariable: "NPM_TOKEN_PUBLISHER_B" },
  { slot: "C", username: "kiran-reloadwork", tokenVariable: "NPM_TOKEN_PUBLISHER_C" },
];

function fail(message) {
  throw new Error(message);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function arguments_() {
  const catalogDirectory = option("--catalog-dir");
  if (!catalogDirectory) {
    fail(
      "usage: node tooling/publish-all-packages.mjs --catalog-dir <directory> " +
        "[--tag <tag>] [--summary <path>] [--delay-ms <n>] [--dry-run] [--no-provenance]",
    );
  }
  const knownWithValues = new Set(["--catalog-dir", "--tag", "--summary", "--delay-ms"]);
  const knownFlags = new Set(["--dry-run", "--no-provenance"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (knownFlags.has(value)) continue;
    if (knownWithValues.has(value)) {
      index += 1;
      continue;
    }
    fail(`unknown argument ${value}`);
  }
  const tag = option("--tag", "latest");
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(tag) || /^v?\d+(?:\.\d+)*$/.test(tag)) {
    fail("--tag must be a non-numeric npm dist-tag");
  }
  const delayMs = option("--delay-ms", "30000");
  if (!/^\d+$/.test(delayMs) || Number(delayMs) > 300_000) fail("--delay-ms must be between 0 and 300000");
  const summary = option("--summary");
  return {
    catalogDirectory: resolve(process.cwd(), catalogDirectory),
    delayMs: Number(delayMs),
    dryRun: process.argv.includes("--dry-run"),
    provenance: !process.argv.includes("--no-provenance"),
    summary: summary ? resolve(process.cwd(), summary) : undefined,
    tag,
  };
}

function json(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function balancedPublisherAssignments(packageCount, publishers = PUBLISHERS) {
  if (!Number.isSafeInteger(packageCount) || packageCount < 1) fail("package count must be a positive integer");
  if (!Array.isArray(publishers) || publishers.length !== 3) fail("exactly three publishers are required");
  let remaining = packageCount;
  let offset = 0;
  return publishers.map((publisher, index) => {
    const count = Math.ceil(remaining / (publishers.length - index));
    if (count > MAX_PUBLISHES_PER_ACCOUNT) {
      fail(
        `${packageCount} packages cannot be published by three accounts without exceeding ` +
          `${MAX_PUBLISHES_PER_ACCOUNT} publishes per account`,
      );
    }
    const assignment = { ...publisher, count, offset };
    offset += count;
    remaining -= count;
    return assignment;
  });
}

export function childBatches(assignment) {
  const batches = [];
  let remaining = assignment.count;
  let offset = assignment.offset;
  while (remaining > 0) {
    const count = Math.min(MAX_CHILD_BATCH, remaining);
    batches.push({ count, offset });
    offset += count;
    remaining -= count;
  }
  return batches;
}

function tokenFingerprint(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function registryJson(path, token, label) {
  let response;
  try {
    response = await fetch(`${REGISTRY}${path}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`${label} could not reach npm: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) fail(`${label} failed with HTTP ${response.status}`);
  return response.json();
}

async function verifyPublisherCredentials(assignments) {
  const fingerprints = new Set();
  for (const assignment of assignments) {
    const token = process.env[assignment.tokenVariable];
    if (!token) fail(`${assignment.tokenVariable} is not configured`);
    const fingerprint = tokenFingerprint(token);
    if (fingerprints.has(fingerprint)) fail("publisher tokens must belong to three distinct npm accounts");
    fingerprints.add(fingerprint);

    const identity = await registryJson("/-/whoami", token, `${assignment.tokenVariable} identity check`);
    if (identity?.username !== assignment.username) {
      fail(`${assignment.tokenVariable} must belong to ${assignment.username}, not ${identity?.username ?? "unknown"}`);
    }
    const members = await registryJson(
      `/-/org/${ORGANIZATION}/user`,
      token,
      `${assignment.username} organization access check`,
    );
    if (!new Set(["owner", "admin"]).has(members?.[assignment.username])) {
      fail(`${assignment.username} must be an owner or admin of @${ORGANIZATION}`);
    }
  }
}

function childArguments(options, batch, summary, dryRun) {
  const args = [
    resolve(import.meta.dirname, "publish-packages.mjs"),
    "--catalog-dir",
    options.catalogDirectory,
    "--offset",
    String(batch.offset),
    "--limit",
    String(batch.count),
    "--tag",
    options.tag,
    "--delay-ms",
    String(options.delayMs),
    "--summary",
    summary,
  ];
  if (dryRun) args.push("--dry-run");
  if (!options.provenance) args.push("--no-provenance");
  return args;
}

function runBatch(options, batch, summary, { dryRun, token, npmrc }) {
  const result = spawnSync(process.execPath, childArguments(options, batch, summary, dryRun), {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(token ? { NODE_AUTH_TOKEN: token } : {}),
      ...(npmrc ? { NPM_CONFIG_USERCONFIG: npmrc } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0 || result.error) {
    const detail = result.error instanceof Error ? result.error.message : result.stderr?.trim();
    fail(`package batch ${batch.offset}-${batch.offset + batch.count - 1} failed${detail ? `: ${detail}` : ""}`);
  }
  return json(summary, `batch ${batch.offset} receipt`);
}

function writeSummary(path, value) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

async function main() {
  let temporaryDirectory;
  let summary;
  const options = arguments_();
  try {
    const catalog = json(join(options.catalogDirectory, "catalog.json"), "catalog.json");
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.packages) || !catalog.packages.length) {
      fail("catalog.json has an unsupported shape");
    }
    const assignments = balancedPublisherAssignments(catalog.packages.filter((item) => item.lifecycle !== "revoked").length);
    summary = {
      schemaVersion: 1,
      sourceRevision: catalog.sourceRevision,
      dryRun: options.dryRun,
      assignments: assignments.map(({ slot, username, offset, count }) => ({ slot, username, offset, count })),
      batches: [],
    };
    process.stdout.write(
      `publisher plan: ${assignments.map(({ username, count }) => `${username}=${count}`).join(", ")}\n`,
    );

    temporaryDirectory = mkdtempSync(join(tmpdir(), "firedrill-tool-publish-"));

    // Validate every immutable release against the registry before the first write.
    for (const assignment of assignments) {
      for (const batch of childBatches(assignment)) {
        const receipt = runBatch(
          options,
          batch,
          join(temporaryDirectory, `preflight-${batch.offset}.json`),
          { dryRun: true },
        );
        summary.batches.push({ phase: "preflight", publisher: assignment.username, ...receipt });
      }
    }

    if (options.dryRun) {
      writeSummary(options.summary, summary);
      process.stdout.write("all package names, archives, and registry identities passed preflight\n");
      return;
    }

    await verifyPublisherCredentials(assignments);
    const npmrc = join(temporaryDirectory, ".npmrc");
    writeFileSync(
      npmrc,
      `registry=${REGISTRY}/\n@${ORGANIZATION}:registry=${REGISTRY}/\n//registry.npmjs.org/:_authToken=\${NODE_AUTH_TOKEN}\n`,
      { mode: 0o600 },
    );

    for (const assignment of assignments) {
      const token = process.env[assignment.tokenVariable];
      for (const batch of childBatches(assignment)) {
        const receipt = runBatch(
          options,
          batch,
          join(temporaryDirectory, `publish-${batch.offset}.json`),
          { dryRun: false, token, npmrc },
        );
        summary.batches.push({ phase: "publish", publisher: assignment.username, ...receipt });
      }
    }
    writeSummary(options.summary, summary);
    process.stdout.write("all Tool packages were published or reconciled with exact registry bytes\n");
  } catch (error) {
    if (options.summary && summary) {
      try {
        writeSummary(options.summary, {
          ...summary,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The original failure is authoritative.
      }
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (temporaryDirectory) rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) await main();
