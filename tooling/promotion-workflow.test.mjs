import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/promote.yml"), "utf8");

test("promotion dispatches one verified public Tool release contract", () => {
  assert.match(workflow, /workflows:\s*\n\s*- CI/u);
  assert.match(workflow, /head_repository\.full_name == github\.repository/u);
  assert.match(workflow, /`firedrill-tools-\$\{COMMUNITY_SHA\}`/u);
  assert.match(workflow, /https:\/\/github\.com\/firedrill-tools\/firedrill-tools\.git/u);
  assert.match(workflow, /source_repository: "firedrill-tools\/firedrill-tools"/u);
  assert.match(workflow, /contract_version: "1"/u);
  assert.match(workflow, /TARGET_REPOSITORY: firedrill-tools\/firedrill\b/u);
  assert.match(workflow, /TARGET_REPOSITORY: firedrill-tools\/firedrill-platform\b/u);
  assert.doesNotMatch(workflow, /firedrill-community-tools/u);
});
