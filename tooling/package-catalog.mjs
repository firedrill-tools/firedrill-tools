#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { credentialFreeRemote } from "./repository-url.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repositoryRoot, "packages");
const identityLockPath = join(repositoryRoot, "release-identities.json");
const lifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepack",
  "prepare",
  "postpack",
  "prepublish",
  "prepublishonly",
  "publish",
  "postpublish",
  "preversion",
  "version",
  "postversion",
  "shrinkwrap",
]);

function fail(message) {
  throw new Error(message);
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${executable} ${args.join(" ")} failed\n${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function arguments_() {
  const index = process.argv.indexOf("--output-dir");
  if (index < 0 || !process.argv[index + 1]) {
    fail("usage: node tooling/package-catalog.mjs --output-dir <owned-directory> [--update-identities]");
  }
  const updateIdentities = process.argv.includes("--update-identities");
  const extras = process.argv.slice(2).filter((value, position, all) => {
    if (value === "--output-dir") return false;
    if (position > 0 && all[position - 1] === "--output-dir") return false;
    if (value === "--update-identities") return false;
    return true;
  });
  if (extras.length) fail(`unknown argument(s): ${extras.join(" ")}`);
  const output = resolve(process.cwd(), process.argv[index + 1]);
  if (output === repositoryRoot || output === packagesRoot || relative(packagesRoot, output).split(sep)[0] !== "..") {
    fail("artifact output must not be the repository root or live under packages/");
  }
  return { output, updateIdentities };
}

function json(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex");
}

function relativeArtifactPath(value, label) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) fail(`${label} must be a relative POSIX path`);
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    fail(`${label} contains path traversal`);
  }
  return normalized;
}

function inspectArchive(archive) {
  const names = command("tar", ["-tzf", archive]).split("\n").filter(Boolean);
  const verbose = command("tar", ["-tvzf", archive]).split("\n").filter(Boolean);
  if (!names.length) fail(`${basename(archive)} is empty`);
  if (verbose.length !== names.length || verbose.some((line) => !["-", "d"].includes(line[0]))) {
    fail(`${basename(archive)} contains a link, device or unsupported archive entry`);
  }
  const seen = new Set();
  for (const name of names) {
    if (name.includes("\0") || isAbsolute(name) || name.includes("\\")) fail(`${basename(archive)} contains an unsafe path: ${JSON.stringify(name)}`);
    const normalized = posix.normalize(name.replace(/\/$/, ""));
    if ((normalized !== "package" && !normalized.startsWith("package/")) || normalized.split("/").includes("..")) {
      fail(`${basename(archive)} contains path traversal: ${JSON.stringify(name)}`);
    }
    if (seen.has(name)) fail(`${basename(archive)} contains duplicate archive path ${JSON.stringify(name)}`);
    seen.add(name);
  }
}

function pack(packageDirectory, destination) {
  const output = command(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    { cwd: packageDirectory, env: { npm_config_update_notifier: "false", npm_config_audit: "false", npm_config_fund: "false" } },
  );
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    fail(`npm pack returned unreadable JSON for ${relative(repositoryRoot, packageDirectory)}`);
  }
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== "string") {
    fail(`npm pack returned an unexpected result for ${relative(repositoryRoot, packageDirectory)}`);
  }
  if (!/^[a-zA-Z0-9._-]+\.tgz$/.test(result[0].filename)) fail(`npm pack returned an unsafe filename: ${result[0].filename}`);
  const archive = join(destination, result[0].filename);
  if (!existsSync(archive)) fail(`npm pack did not create ${result[0].filename}`);
  inspectArchive(archive);
  return archive;
}

function canonicalIdentityRecord(record) {
  return {
    archive: record.archive,
    sha256: record.sha256,
    sha512: record.sha512,
    size: record.size,
    tool: record.tool,
  };
}

function sameIdentity(left, right) {
  return JSON.stringify(canonicalIdentityRecord(left)) === JSON.stringify(canonicalIdentityRecord(right));
}

function packageRecord(directory, firstPack, secondPack, destination, identities, releaseIdentities, updateIdentities) {
  const sourceSubdirectory = `packages/${basename(directory)}`;
  const packageJson = json(join(directory, "package.json"), `${sourceSubdirectory}/package.json`);
  if (typeof packageJson.name !== "string" || !/^@firedrill-tools\/tool-[a-z0-9-]+$/.test(packageJson.name)) {
    fail(`${sourceSubdirectory} has an invalid package name`);
  }
  if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
    fail(`${packageJson.name} has an invalid version`);
  }
  if (packageJson.firedrill?.layer !== "tool-pack") fail(`${packageJson.name} must declare firedrill.layer tool-pack`);
  if (!["active", "deprecated", "revoked"].includes(packageJson.firedrill?.lifecycle)) {
    fail(`${packageJson.name} has an invalid lifecycle`);
  }
  const forbiddenScripts = Object.keys(packageJson.scripts ?? {}).filter((name) => lifecycleScripts.has(name.toLowerCase()));
  if (forbiddenScripts.length) fail(`${packageJson.name} declares forbidden lifecycle scripts: ${forbiddenScripts.join(", ")}`);

  const toolPath = relativeArtifactPath(packageJson.firedrill?.tool, `${packageJson.name} firedrill.tool`);
  const definition = resolve(directory, toolPath);
  const packageRoot = realpathSync(directory);
  if (!existsSync(definition) || relative(packageRoot, realpathSync(definition)).startsWith("..")) {
    fail(`${packageJson.name} Tool definition escapes its package`);
  }
  const toolDefinition = json(definition, `${packageJson.name} Tool definition`);
  const tool = toolDefinition.manifest?.id;
  if (typeof tool !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(tool)) fail(`${packageJson.name} has an invalid Tool id`);
  if (toolDefinition.manifest?.version !== packageJson.version) fail(`${packageJson.name} package and Tool versions differ`);
  const engines = { node: packageJson.engines?.node, firedrill: toolDefinition.manifest?.engine };
  if (Object.values(engines).some((value) => typeof value !== "string" || !value.trim())) {
    fail(`${packageJson.name} must declare Node and Firedrill engine ranges`);
  }

  for (const [kind, identity] of [["package", packageJson.name], ["Tool", tool], ["release", `${packageJson.name}@${packageJson.version}`]]) {
    const key = `${kind}:${identity}`;
    if (identities.has(key)) fail(`duplicate ${kind} identity ${identity}`);
    identities.add(key);
  }

  if (packageJson.firedrill.lifecycle === "revoked") {
    const release = `${packageJson.name}@${packageJson.version}`;
    if (!releaseIdentities[release]) {
      fail(`${release} cannot be revoked before its immutable release identity is recorded`);
    }
    if (releaseIdentities[release].tool !== tool) fail(`${release} cannot change Tool identity while being revoked`);
    return {
      name: packageJson.name,
      version: packageJson.version,
      tool,
      lifecycle: "revoked",
      sourceSubdirectory,
      definition: toolPath,
    };
  }

  const one = pack(directory, firstPack);
  const two = pack(directory, secondPack);
  const firstBytes = readFileSync(one);
  const secondBytes = readFileSync(two);
  const sha512 = digest("sha512", firstBytes);
  if (firstBytes.length !== secondBytes.length || sha512 !== digest("sha512", secondBytes)) {
    fail(`${packageJson.name}@${packageJson.version} is not reproducible: two npm packs produced different bytes`);
  }
  const archive = basename(one);
  if (archive !== basename(two)) fail(`${packageJson.name} produced inconsistent archive names`);
  const record = {
    name: packageJson.name,
    version: packageJson.version,
    tool,
    lifecycle: packageJson.firedrill.lifecycle,
    engines,
    archive,
    size: firstBytes.length,
    sha256: digest("sha256", firstBytes),
    sha512,
    sourceSubdirectory,
    definition: toolPath,
  };
  const release = `${record.name}@${record.version}`;
  const recorded = releaseIdentities[release];
  if (recorded && !sameIdentity(record, recorded)) {
    fail(`${release} bytes differ from its immutable release identity; bump the package and Tool version`);
  }
  if (!recorded) {
    if (!updateIdentities) {
      fail(`${release} has no release identity; run pnpm release:identities:update after choosing a new version`);
    }
    releaseIdentities[release] = canonicalIdentityRecord(record);
  }
  copyFileSync(one, join(destination, archive));
  return record;
}

let staging;
let temporary;
let identityStaging;
try {
  const { output, updateIdentities } = arguments_();
  if (existsSync(output)) fail(`artifact output already exists: ${output}`);
  if (!updateIdentities) {
    const dirtyPackages = command("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "packages"]);
    if (dirtyPackages) fail("package sources differ from HEAD; commit them before producing release artifacts");
  }
  const revision = command("git", ["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(revision)) fail("git did not return an exact source revision");
  const sourceRepository = credentialFreeRemote(command("git", ["remote", "get-url", "origin"]));

  mkdirSync(dirname(output), { recursive: true });
  staging = mkdtempSync(join(dirname(output), `.${basename(output)}.next-`));
  temporary = mkdtempSync(join(dirname(output), `.${basename(output)}.packs-`));
  const firstPack = join(temporary, "one");
  const secondPack = join(temporary, "two");
  mkdirSync(firstPack);
  mkdirSync(secondPack);

  const identityLock = json(identityLockPath, "release-identities.json");
  if (identityLock.schemaVersion !== 1 || !identityLock.releases || typeof identityLock.releases !== "object" || Array.isArray(identityLock.releases)) {
    fail("release-identities.json has an unsupported shape");
  }
  const releaseIdentities = { ...identityLock.releases };

  const directories = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesRoot, entry.name, "package.json")))
    .map((entry) => join(packagesRoot, entry.name))
    .sort();
  if (!directories.length) fail("no Tool packages found");
  const identities = new Set();
  const packages = directories.map((directory) =>
    packageRecord(directory, firstPack, secondPack, staging, identities, releaseIdentities, updateIdentities),
  );
  packages.sort((a, b) => a.name.localeCompare(b.name));
  const catalog = { schemaVersion: 1, sourceRepository, sourceRevision: revision, packages };
  writeFileSync(join(staging, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  renameSync(staging, output);
  staging = undefined;
  if (updateIdentities) {
    const sortedReleases = Object.fromEntries(Object.entries(releaseIdentities).sort(([left], [right]) => left.localeCompare(right)));
    identityStaging = join(repositoryRoot, `.release-identities.json.next-${process.pid}`);
    writeFileSync(identityStaging, `${JSON.stringify({ schemaVersion: 1, releases: sortedReleases }, null, 2)}\n`, { flag: "wx" });
    renameSync(identityStaging, identityLockPath);
    identityStaging = undefined;
  }
  const packaged = packages.filter((item) => item.lifecycle !== "revoked").length;
  const tombstones = packages.length - packaged;
  process.stdout.write(`cataloged ${packaged} reproducible Tool packages and ${tombstones} revocation tombstones from ${revision} into ${output}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  if (staging) rmSync(staging, { recursive: true, force: true });
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  if (identityStaging) rmSync(identityStaging, { force: true });
}
