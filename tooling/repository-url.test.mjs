import assert from "node:assert/strict";
import { test } from "node:test";

import { credentialFreeRemote } from "./repository-url.mjs";

const canonical = "https://github.com/firedrill-tools/firedrill-tools.git";

for (const origin of [
  "git@github.com:firedrill-tools/firedrill-tools.git",
  "git@github.com:firedrill-tools/firedrill-tools",
  "ssh://git@github.com/firedrill-tools/firedrill-tools.git",
  "ssh://git@github.com/firedrill-tools/firedrill-tools",
  "https://github.com/firedrill-tools/firedrill-tools.git",
  "https://github.com/firedrill-tools/firedrill-tools",
  "https://github.com/firedrill-tools/firedrill-tools/",
]) {
  test(`normalizes ${origin}`, () => {
    assert.equal(credentialFreeRemote(origin), canonical);
  });
}

for (const origin of [
  "http://github.com/firedrill-tools/firedrill-tools",
  "https://token@github.com/firedrill-tools/firedrill-tools",
  "https://example.com/firedrill-tools/firedrill-tools",
  "https://github.com/firedrill-tools/firedrill-tools?token=secret",
  "not-a-url",
]) {
  test(`rejects unsafe origin ${origin}`, () => {
    assert.throws(() => credentialFreeRemote(origin), /credential-free HTTPS or GitHub SSH URL/);
  });
}
