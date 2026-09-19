#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const MAX_BATCH_SIZE = 10;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_DELAY_MS = 30_000;

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

function integerOption(name, fallback, { minimum, maximum }) {
  const raw = option(name, String(fallback));
  if (!/^\d+$/.test(raw)) fail(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function arguments_() {
  const catalogDirectory = option("--catalog-dir");
  if (!catalogDirectory) {
    fail(
      "usage: node tooling/publish-packages.mjs --catalog-dir <directory> " +
        "[--offset <n>] [--limit <1-10>] [--tag <tag>] [--delay-ms <n>] " +
        "[--summary <path>] [--dry-run] [--no-provenance]",
    );
  }
  const knownWithValues = new Set([
    "--catalog-dir",
    "--offset",
    "--limit",
    "--tag",
    "--delay-ms",
    "--summary",
  ]);
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
  const summary = option("--summary");
  return {
    catalogDirectory: resolve(process.cwd(), catalogDirectory),
    offset: integerOption("--offset", 0, { minimum: 0, maximum: 10_000 }),
    limit: integerOption("--limit", DEFAULT_BATCH_SIZE, { minimum: 1, maximum: MAX_BATCH_SIZE }),
    delayMs: integerOption("--delay-ms", DEFAULT_DELAY_MS, { minimum: 0, maximum: 300_000 }),
    tag,
    summary: summary ? resolve(process.cwd(), summary) : undefined,
    dryRun: process.argv.includes("--dry-run"),
    provenance: !process.argv.includes("--no-provenance"),
  };
}

function parseJson(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  return value;
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
}

function expectedIntegrity(sha512) {
  return `sha512-${Buffer.from(sha512, "hex").toString("base64")}`;
}

function validateCatalog(directory) {
  const catalogPath = join(directory, "catalog.json");
  if (!existsSync(catalogPath)) fail(`catalog is missing: ${catalogPath}`);
  const catalog = parseJson(catalogPath, "catalog.json");
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.packages) || !catalog.packages.length) {
    fail("catalog.json has an unsupported shape");
  }
  if (!/^[0-9a-f]{40,64}$/.test(catalog.sourceRevision ?? "")) {
    fail("catalog.json does not identify an exact source revision");
  }
  if (process.env.GITHUB_SHA && catalog.sourceRevision !== process.env.GITHUB_SHA) {
    fail("catalog.json source revision does not match the checked-out workflow revision");
  }
  if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== "firedrill-tools/firedrill-tools") {
    fail("publishing is restricted to firedrill-tools/firedrill-tools");
  }
  if (catalog.sourceRepository !== "https://github.com/firedrill-tools/firedrill-tools.git") {
    fail("catalog.json does not identify the canonical public Tool repository");
  }
  const releases = new Set();
  const archives = new Set();
  const tools = new Set();
  let priorName = "";
  const publishable = [];
  for (const item of catalog.packages) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("catalog contains an invalid package record");
    if (!/^@firedrill-tools\/[a-z0-9][a-z0-9-]*$/.test(item.name ?? "") || item.name <= priorName) {
      fail("catalog package names must be unique, valid, and sorted");
    }
    priorName = item.name;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version ?? "")) {
      fail(`${item.name} has an invalid version`);
    }
    const release = `${item.name}@${item.version}`;
    if (releases.has(release)) fail(`catalog contains duplicate release ${release}`);
    releases.add(release);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.tool ?? "") || tools.has(item.tool)) {
      fail(`${release} has an invalid or duplicate Tool id`);
    }
    tools.add(item.tool);
    if (item.name !== `@firedrill-tools/${item.tool}`) {
      fail(`${release} package name must match Tool id ${item.tool}`);
    }
    if (item.lifecycle === "revoked") continue;
    if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(item.archive ?? "") || archives.has(item.archive)) {
      fail(`${release} has an invalid or duplicate archive name`);
    }
    const expectedArchive = `${item.name.slice(1).replace("/", "-")}-${item.version}.tgz`;
    if (item.archive !== expectedArchive) fail(`${release} archive must be named ${expectedArchive}`);
    archives.add(item.archive);
    if (!Number.isSafeInteger(item.size) || item.size <= 0) fail(`${release} has an invalid archive size`);
    if (!/^[0-9a-f]{64}$/.test(item.sha256 ?? "") || !/^[0-9a-f]{128}$/.test(item.sha512 ?? "")) {
      fail(`${release} has invalid archive digests`);
    }
    const archivePath = join(directory, item.archive);
    if (isAbsolute(item.archive) || !existsSync(archivePath)) fail(`${release} archive is missing`);
    const bytes = readFileSync(archivePath);
    if (
      bytes.length !== item.size ||
      digest("sha256", bytes) !== item.sha256 ||
      digest("sha512", bytes) !== item.sha512
    ) {
      fail(`${release} archive does not match catalog.json`);
    }
    publishable.push({
      ...item,
      release,
      archivePath,
      integrity: expectedIntegrity(item.sha512),
    });
  }
  return { catalog, publishable };
}

function registryVersionUrl(registry, name, version) {
  const base = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  return new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, base);
}

function registryPackageUrl(registry, name) {
  const base = new URL(registry.endsWith("/") ? registry : `${registry}/`);
  return new URL(encodeURIComponent(name), base);
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, 300_000);
  return Math.min(2 ** (attempt - 1) * 5_000, 120_000);
}

async function pause(milliseconds) {
  if (milliseconds > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function registryState(registry, item, tag, runtime = {}) {
  const attempts = runtime.attempts ?? 5;
  const fetchRegistry = runtime.fetch ?? fetch;
  const pauseRegistry = runtime.pause ?? pause;
  const url = registryVersionUrl(registry, item.name, item.version);
  const packageUrl = registryPackageUrl(registry, item.name);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetchRegistry(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === attempts) {
        fail(`registry lookup for ${item.release} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await pauseRegistry(Math.min(2 ** (attempt - 1) * 5_000, 120_000));
      continue;
    }
    if (response.status === 404) return { state: "missing" };
    if (response.status === 429 || response.status >= 500) {
      if (attempt === attempts) fail(`registry lookup for ${item.release} failed with HTTP ${response.status}`);
      await pauseRegistry(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok) fail(`registry lookup for ${item.release} failed with HTTP ${response.status}`);
    const body = await response.json();
    const integrity = body?.dist?.integrity;
    if (typeof integrity !== "string" || !integrity) fail(`registry metadata for ${item.release} has no integrity`);
    if (integrity !== item.integrity) return { state: "mismatch", integrity };

    let packageResponse;
    try {
      packageResponse = await fetchRegistry(packageUrl, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt === attempts) {
        fail(
          `registry dist-tag lookup for ${item.release} failed: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await pauseRegistry(Math.min(2 ** (attempt - 1) * 5_000, 120_000));
      continue;
    }
    if (packageResponse.status === 404) {
      if (attempt === attempts) {
        return { state: "matching", integrity, tagVersion: undefined, tagPending: true };
      }
      await pauseRegistry(Math.min(2 ** (attempt - 1) * 5_000, 120_000));
      continue;
    }
    if (packageResponse.status === 429 || packageResponse.status >= 500) {
      if (attempt === attempts) {
        fail(`registry dist-tag lookup for ${item.release} failed with HTTP ${packageResponse.status}`);
      }
      await pauseRegistry(retryDelay(packageResponse, attempt));
      continue;
    }
    if (!packageResponse.ok) {
      fail(`registry dist-tag lookup for ${item.release} failed with HTTP ${packageResponse.status}`);
    }
    const packageBody = await packageResponse.json();
    return { state: "matching", integrity, tagVersion: packageBody?.["dist-tags"]?.[tag] };
  }
  fail(`registry lookup for ${item.release} exhausted its attempts`);
}

export function runNpmPublish(item, options, spawn = spawnSync) {
  const args = [
    "publish",
    item.archivePath,
    "--access",
    "public",
    "--ignore-scripts",
    "--tag",
    options.tag,
    "--registry",
    DEFAULT_REGISTRY,
    "--fetch-retries=0",
  ];
  if (options.provenance) args.push("--provenance");
  return spawn("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
      NPM_CONFIG_FETCH_RETRIES: "0",
    },
  });
}

function publishWasThrottled(result) {
  const processError = result.error instanceof Error ? result.error.message : "";
  return /(?:E429|429 Too Many Requests|rate limit)/i.test(
    `${processError}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
}

function safeFailureOutput(result) {
  const error = result.error instanceof Error ? `npm process error: ${result.error.message}` : "";
  const output = `${error}\n${result.stderr || result.stdout || "npm publish failed without output"}`.trim();
  return output
    .split("\n")
    .filter((line) => !/(?:_authToken|npm_[A-Za-z0-9]{20,})/i.test(line))
    .join("\n");
}

function safeRerunGuidance(item) {
  return (
    `No second publish was attempted for ${item.release}. ` +
    "Rerun the same batch when it is safe; registry preflight will skip the version if npm committed it."
  );
}

const defaultRuntime = {
  registryState: (item, tag) => registryState(DEFAULT_REGISTRY, item, tag),
  publish: runNpmPublish,
  pause,
  log: (message) => process.stdout.write(message),
};

export async function publishOne(item, options, runtime = defaultRuntime) {
  const initial = await runtime.registryState(item, options.tag);
  if (initial.state === "matching") {
    if (initial.tagVersion === undefined && initial.tagPending) {
      runtime.log(`skip ${item.release}: exact registry bytes match; ${options.tag} metadata is still propagating\n`);
      return "skipped-pending-tag";
    }
    if (initial.tagVersion !== item.version) {
      fail(
        `${item.release} has matching registry bytes, but ${options.tag} points to ` +
          `${initial.tagVersion ?? "no version"}; reconcile the dist-tag explicitly before resuming`,
      );
    }
    runtime.log(`skip ${item.release}: registry integrity already matches\n`);
    return "skipped";
  }
  if (initial.state === "mismatch") {
    fail(`${item.release} already exists with different bytes; versions are immutable`);
  }
  if (options.dryRun) {
    runtime.log(`would publish ${item.release} (${item.archive})\n`);
    return "planned";
  }

  runtime.log(`publish ${item.release} (single write attempt)\n`);
  let result;
  try {
    result = runtime.publish(item, options);
  } catch (error) {
    result = {
      error: error instanceof Error ? error : new Error(String(error)),
      status: null,
      stdout: "",
      stderr: "",
    };
  }
  if (!result.error && result.status === 0) {
    let matchingBytesObserved = false;
    let observedTagVersion;
    for (let lookup = 1; lookup <= 8; lookup += 1) {
      let state;
      try {
        state = await runtime.registryState(item, options.tag);
      } catch (error) {
        fail(
          `${item.release} was accepted by npm, but registry reconciliation failed: ` +
            `${error instanceof Error ? error.message : String(error)}\n${safeRerunGuidance(item)}`,
        );
      }
      if (state.state === "matching") {
        matchingBytesObserved = true;
        observedTagVersion = state.tagVersion;
        if (state.tagVersion === item.version) return "published";
      }
      if (state.state === "mismatch") fail(`${item.release} appeared with different bytes after publishing`);
      if (lookup < 8) await runtime.pause(Math.min(lookup * 2_000, 10_000));
    }
    if (matchingBytesObserved && observedTagVersion !== undefined) {
      fail(
        `${item.release} was accepted with matching bytes, but ${options.tag} points to ` +
          `${observedTagVersion ?? "no version"}; no automatic dist-tag write was attempted`,
      );
    }
    if (matchingBytesObserved) {
      runtime.log(
        `accepted ${item.release}: exact registry bytes match; ${options.tag} metadata is still propagating\n`,
      );
      return "accepted-pending-tag";
    }
    runtime.log(
      `accepted ${item.release}: npm acknowledged the upload, but exact registry bytes are not readable yet; ` +
        "a later rerun or registry gate must reconcile them\n",
    );
    return "accepted";
  }

  // npm can commit an upload even when its client returns an error. Reconcile
  // the immutable version before reporting failure, and never issue a second
  // write from this process.
  let state;
  try {
    state = await runtime.registryState(item, options.tag);
  } catch (error) {
    fail(
      `${item.release} publish returned an error and registry reconciliation failed: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `${safeFailureOutput(result)}\n${safeRerunGuidance(item)}`,
    );
  }
  if (state.state === "matching") {
    if (state.tagVersion !== item.version) {
      fail(
        `${item.release} was committed with matching bytes, but ${options.tag} points to ` +
          `${state.tagVersion ?? "no version"}; no automatic dist-tag write was attempted`,
      );
    }
    runtime.log(`reconciled ${item.release}: npm committed matching bytes despite the client error\n`);
    return "reconciled";
  }
  if (state.state === "mismatch") {
    fail(`${item.release} appeared with different bytes after a failed publish; versions are immutable`);
  }
  if (publishWasThrottled(result)) {
    fail(
      `${item.release} was rate-limited and registry reconciliation confirms the version is absent.\n` +
        `${safeFailureOutput(result)}\nNo second publish was attempted. ` +
        "Rerun the same batch after npm's cooldown; registry preflight makes the rerun safe.",
    );
  }
  fail(
    `${item.release} publish failed and registry reconciliation confirms the version is absent.\n` +
      `${safeFailureOutput(result)}\n${safeRerunGuidance(item)}`,
  );
}

function writeSummary(path, summary) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
}

export async function publishBatch(selected, options, summary, runtime = defaultRuntime) {
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const outcome = await publishOne(item, options, runtime);
    summary.results.push({ release: item.release, integrity: item.integrity, outcome });
    if (!options.dryRun && index < selected.length - 1) await runtime.pause(options.delayMs);
  }
}

async function main() {
  let options;
  let summary;
  try {
    options = arguments_();
    const { catalog, publishable } = validateCatalog(options.catalogDirectory);
    const selected = publishable.slice(options.offset, options.offset + options.limit);
    if (!selected.length) fail(`batch offset ${options.offset} is past the ${publishable.length} publishable packages`);
    summary = {
      schemaVersion: 1,
      sourceRevision: catalog.sourceRevision,
      dryRun: options.dryRun,
      offset: options.offset,
      limit: options.limit,
      selected: selected.map((item) => item.release),
      results: [],
    };
    process.stdout.write(
      `${options.dryRun ? "checking" : "publishing"} ${selected.length} of ${publishable.length} packages ` +
        `(offset ${options.offset}, max batch ${MAX_BATCH_SIZE})\n`,
    );
    await publishBatch(selected, options, summary);
    writeSummary(options.summary, summary);
    process.stdout.write(
      `${options.dryRun ? "checked" : "completed"} batch ${options.offset}-${options.offset + selected.length - 1}\n`,
    );
  } catch (error) {
    if (options?.summary && summary) {
      try {
        writeSummary(options.summary, {
          ...summary,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // The original failure is authoritative; a summary must never mask it.
      }
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) await main();
