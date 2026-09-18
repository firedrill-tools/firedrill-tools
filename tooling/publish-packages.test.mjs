import assert from "node:assert/strict";
import { test } from "node:test";

import { publishOne, runNpmPublish } from "./publish-packages.mjs";

const item = {
  archive: "firedrill-tools-tool-example-1.0.0.tgz",
  archivePath: "/tmp/firedrill-tools-tool-example-1.0.0.tgz",
  integrity: "sha512-dGVzdA==",
  name: "@firedrill-tools/tool-example",
  release: "@firedrill-tools/tool-example@1.0.0",
  version: "1.0.0",
};

const options = {
  dryRun: false,
  provenance: false,
  tag: "latest",
};

function runtime(states, result) {
  let publishCalls = 0;
  const registryStates = [...states];
  return {
    instance: {
      registryState: async () => {
        assert.ok(registryStates.length, "unexpected registry lookup");
        const state = registryStates.shift();
        if (state instanceof Error) throw state;
        return state;
      },
      publish: () => {
        publishCalls += 1;
        return result;
      },
      pause: async () => {},
      log: () => {},
    },
    publishCalls: () => publishCalls,
  };
}

test("runNpmPublish disables npm's internal fetch retries", () => {
  let invocation;
  const result = runNpmPublish(item, options, (command, args, spawnOptions) => {
    invocation = { command, args, spawnOptions };
    return { status: 0, stdout: "+ ok", stderr: "" };
  });

  assert.equal(result.status, 0);
  assert.equal(invocation.command, "npm");
  assert.ok(invocation.args.includes("--fetch-retries=0"));
  assert.equal(invocation.spawnOptions.env.NPM_CONFIG_FETCH_RETRIES, "0");
});

test("a matching preflight makes a resumed batch skip without writing", async () => {
  const harness = runtime([{ state: "matching", integrity: item.integrity }], {
    status: 0,
    stdout: "",
    stderr: "",
  });

  assert.equal(await publishOne(item, options, harness.instance), "skipped");
  assert.equal(harness.publishCalls(), 0);
});

test("a successful publish writes once and verifies matching registry bytes", async () => {
  const harness = runtime([{ state: "missing" }, { state: "matching", integrity: item.integrity }], {
    status: 0,
    stdout: "+ ok",
    stderr: "",
  });

  assert.equal(await publishOne(item, options, harness.instance), "published");
  assert.equal(harness.publishCalls(), 1);
});

test("a failed client response reconciles matching remote bytes without retrying", async () => {
  const harness = runtime([{ state: "missing" }, { state: "matching", integrity: item.integrity }], {
    status: 1,
    stdout: "",
    stderr: "npm error network response was interrupted",
  });

  assert.equal(await publishOne(item, options, harness.instance), "reconciled");
  assert.equal(harness.publishCalls(), 1);
});

test("a process error still reconciles matching remote bytes without retrying", async () => {
  const harness = runtime([{ state: "missing" }, { state: "matching", integrity: item.integrity }], {
    error: new Error("spawn npm EPIPE"),
    status: null,
    stdout: "",
    stderr: "",
  });

  assert.equal(await publishOne(item, options, harness.instance), "reconciled");
  assert.equal(harness.publishCalls(), 1);
});

test("a thrown process failure still reconciles matching remote bytes without retrying", async () => {
  let publishCalls = 0;
  const states = [{ state: "missing" }, { state: "matching", integrity: item.integrity }];
  const harness = {
    registryState: async () => states.shift(),
    publish: () => {
      publishCalls += 1;
      throw new Error("spawn setup failed");
    },
    pause: async () => {},
    log: () => {},
  };

  assert.equal(await publishOne(item, options, harness), "reconciled");
  assert.equal(publishCalls, 1);
});

test("a missing rate-limited publish stops after one write with cooldown guidance", async () => {
  const harness = runtime([{ state: "missing" }, { state: "missing" }], {
    status: 1,
    stdout: "",
    stderr: "npm error code E429\nnpm error 429 Too Many Requests",
  });

  await assert.rejects(
    publishOne(item, options, harness.instance),
    /No second publish was attempted[\s\S]*after npm's cooldown/,
  );
  assert.equal(harness.publishCalls(), 1);
});

test("a process-level 429 error also stops with cooldown guidance", async () => {
  const harness = runtime([{ state: "missing" }, { state: "missing" }], {
    error: new Error("npm exited with E429 rate limit"),
    status: null,
    stdout: "",
    stderr: "",
  });

  await assert.rejects(
    publishOne(item, options, harness.instance),
    /No second publish was attempted[\s\S]*after npm's cooldown/,
  );
  assert.equal(harness.publishCalls(), 1);
});

test("a failed publish with mismatching remote bytes fails after one write", async () => {
  const harness = runtime([{ state: "missing" }, { state: "mismatch", integrity: "sha512-other" }], {
    status: 1,
    stdout: "",
    stderr: "npm error network response was interrupted",
  });

  await assert.rejects(publishOne(item, options, harness.instance), /different bytes/);
  assert.equal(harness.publishCalls(), 1);
});

test("an unavailable reconciliation never causes a second write", async () => {
  const harness = runtime([{ state: "missing" }, new Error("registry unavailable")], {
    status: 1,
    stdout: "",
    stderr: "npm error network response was interrupted",
  });

  await assert.rejects(
    publishOne(item, options, harness.instance),
    /registry reconciliation failed:[\s\S]*No second publish was attempted/,
  );
  assert.equal(harness.publishCalls(), 1);
});
