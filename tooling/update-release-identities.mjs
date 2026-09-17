#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "firedrill-release-identities-"));

try {
  const verification = spawnSync(process.execPath, [join(repositoryRoot, "tooling/release-identities.mjs"), "verify-current"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (verification.error) throw verification.error;
  if (verification.status !== 0) {
    process.exitCode = verification.status ?? 1;
  } else {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "tooling/package-catalog.mjs"), "--output-dir", join(temporary, "catalog"), "--update-identities"],
      { cwd: repositoryRoot, env: process.env, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
