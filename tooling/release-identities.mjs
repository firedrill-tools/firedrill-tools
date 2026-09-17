#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(repositoryRoot, "release-identities.json");

function fail(message) {
  throw new Error(message);
}

function parse(bytes, label) {
  let lock;
  try {
    lock = JSON.parse(bytes);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  if (lock.schemaVersion !== 1 || !lock.releases || typeof lock.releases !== "object" || Array.isArray(lock.releases)) {
    fail(`${label} has an unsupported shape`);
  }
  const keys = Object.keys(lock.releases);
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) fail(`${label} release identities are not sorted`);
  const packageTools = new Map();
  for (const [release, record] of Object.entries(lock.releases)) {
    const separator = release.lastIndexOf("@");
    const packageName = release.slice(0, separator);
    const version = release.slice(separator + 1);
    if (!/^@firedrill-(?:community|tools)\/tool-[a-z0-9-]+$/.test(packageName) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      fail(`${label} contains invalid release identity ${release}`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) fail(`${label} contains an invalid record for ${release}`);
    const expectedKeys = ["archive", "sha256", "sha512", "size", "tool"];
    if (JSON.stringify(Object.keys(record)) !== JSON.stringify(expectedKeys)) fail(`${label} contains non-canonical fields for ${release}`);
    const expectedArchive = `${packageName.slice(1).replace("/", "-")}-${version}.tgz`;
    if (record.archive !== expectedArchive) fail(`${label} contains an invalid archive for ${release}`);
    if (!/^[0-9a-f]{64}$/.test(record.sha256) || !/^[0-9a-f]{128}$/.test(record.sha512)) {
      fail(`${label} contains an invalid digest for ${release}`);
    }
    if (!Number.isSafeInteger(record.size) || record.size <= 0) fail(`${label} contains an invalid size for ${release}`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(record.tool)) fail(`${label} contains an invalid Tool id for ${release}`);
    const priorTool = packageTools.get(packageName);
    if (priorTool && priorTool !== record.tool) fail(`${packageName} changes Tool identity across recorded versions`);
    packageTools.set(packageName, record.tool);
  }
  const canonical = `${JSON.stringify({ schemaVersion: 1, releases: lock.releases }, null, 2)}\n`;
  if (bytes !== canonical) fail(`${label} is not in canonical format`);
  return lock;
}

function baselineArgument() {
  const index = process.argv.indexOf("--baseline-ref");
  if (index < 0 || !process.argv[index + 1]) fail("usage: node tooling/release-identities.mjs verify-history --baseline-ref <commit>");
  const baseline = process.argv[index + 1];
  if (!/^[0-9a-f]{40,64}$/.test(baseline)) fail("baseline ref must be an exact commit SHA");
  return baseline;
}

function git(args) {
  return spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

try {
  const command = process.argv[2] ?? "verify-current";
  const currentBytes = readFileSync(lockPath, "utf8");
  const current = parse(currentBytes, "release-identities.json");
  if (command === "verify-current") {
    process.stdout.write(`verified ${Object.keys(current.releases).length} immutable release identities\n`);
  } else if (command === "verify-history") {
    const baseline = baselineArgument();
    if (/^0+$/.test(baseline)) {
      process.stdout.write("no prior revision exists; verified the initial release identity lock\n");
    } else {
      const commit = git(["cat-file", "-e", `${baseline}^{commit}`]);
      if (commit.status !== 0) fail(`baseline commit ${baseline} is unavailable`);
      const listed = git(["ls-tree", "--name-only", baseline, "--", "release-identities.json"]);
      if (listed.status !== 0) fail(`cannot inspect release identity history at ${baseline}`);
      if (!listed.stdout.trim()) {
        process.stdout.write("baseline predates the release identity lock; verified its initial introduction\n");
      } else {
        const shown = git(["show", `${baseline}:release-identities.json`]);
        if (shown.status !== 0) fail(`cannot read release identity history at ${baseline}`);
        const prior = parse(shown.stdout, `release-identities.json at ${baseline}`);
        for (const [release, record] of Object.entries(prior.releases)) {
          if (!(release in current.releases)) fail(`${release} was removed from the immutable release identity history`);
          if (JSON.stringify(current.releases[release]) !== JSON.stringify(record)) {
            fail(`${release} was rewritten in the immutable release identity history`);
          }
        }
        process.stdout.write(`verified ${Object.keys(prior.releases).length} historical release identities against ${baseline}\n`);
      }
    }
  } else {
    fail(`unknown command ${command}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
