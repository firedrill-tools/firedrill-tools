#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = ["package.json", "pnpm-lock.yaml"];
const forbidden = [
  { pattern: /(?:^|[\s:'"])(?:file:)?\/(?:Users|home|private\/tmp)\//m, label: "machine-specific path" },
  { pattern: /firedrill-platform\/vendor\//, label: "hosted-repository dependency" },
];

try {
  for (const file of files) {
    const contents = readFileSync(resolve(root, file), "utf8");
    for (const rule of forbidden) {
      if (rule.pattern.test(contents)) throw new Error(`${file} contains a ${rule.label}`);
    }
  }
  process.stdout.write("workspace dependency metadata is portable\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
