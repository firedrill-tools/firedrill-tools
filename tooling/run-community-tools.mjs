import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repositoryRoot, "packages");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const script = process.argv[2];
if (!new Set(["validate", "test"]).has(script) || process.argv.length !== 3) {
  throw new Error("usage: node tooling/run-community-tools.mjs <validate|test>");
}

const tools = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = join(packagesRoot, entry.name);
    const manifestPath = join(directory, "package.json");
    if (!existsSync(manifestPath)) return undefined;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.firedrill?.lifecycle === "revoked") return undefined;
    if (!["active", "deprecated"].includes(manifest.firedrill?.lifecycle)) {
      throw new Error(`${manifest.name ?? entry.name} has an invalid lifecycle`);
    }
    if (typeof manifest.name !== "string" || typeof manifest.scripts?.[script] !== "string") return undefined;
    return { directory, name: manifest.name };
  })
  .filter((tool) => tool !== undefined)
  .sort((left, right) => left.name.localeCompare(right.name));

if (tools.length === 0) throw new Error(`no releasable community Tool packages with a ${script} script were found`);

for (const [index, tool] of tools.entries()) {
  const runtimeOutput = join(tool.directory, ".firedrill");
  rmSync(runtimeOutput, { recursive: true, force: true });
  process.stdout.write(`\n[${index + 1}/${tools.length}] ${tool.name}\n`);
  const result = spawnSync(pnpm, ["--filter", tool.name, script], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
  // A single Tool test intentionally keeps its reports for a developer. The
  // repository-wide gate proves every package and discards only successful,
  // ignored runtime output so a clean CI runner cannot fill its disk midway.
  if (script === "test") rmSync(runtimeOutput, { recursive: true, force: true });
}
