// Hostile-input harness for the partitioners and the chunker. Node built-ins only.
//   node test/hostile.mjs [seed=1] [cases=20000]
// Cases run in a worker thread; the main thread watches a shared case counter and terminates the worker when one case runs
// longer than the hang bound, so a non-terminating partitioner is reported instead of hanging the harness. A case fails when
// it takes more than LIMIT_MS (partition plus JSON encoding of the result, as the route does), throws anything, or answers a
// code that is not one of the package's declared error codes. Exit status 1 on any failure.
// The latency bound is machine-dependent, so only the command line applies it. Packaged conformance calls runHostile with
// `limitMs: Infinity` and a long hang bound: a determinism check must not pass on a fast machine and fail on a slow one,
// while a case that throws, answers an undeclared code or never terminates still fails everywhere.
// Every MULTIPART_EVERY-th case also decodes a hostile multipart/form-data request envelope through both route decoders
// (partition and workflow run) and checks that a decoded `languages` list is either accepted whole or refused, never cut.
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { makeCase, makeMultipartCase } from "./hostile-gen.mjs";

export const LIMIT_MS = 250;
export const HANG_MS = 5000;
const RSS_LIMIT = 2 * 1024 * 1024 * 1024;
const MULTIPART_EVERY = 4;
const DECLARED = new Set(["INVALID_REQUEST", "UNSUPPORTED_FILE_TYPE", "RESPONSE_TOO_LARGE", "INVALID_FILE", "VALIDATION_ERROR"]);

async function workerMain() {
  const { seed, cases, from, shared, limitMs = LIMIT_MS } = workerData;
  const progress = new Int32Array(shared);
  const { partitionFile } = await import(new URL("../firedrill/tools/unstructured/lib/partition/index.mjs", import.meta.url));
  const { decodePartition, decodeRun } = await import(new URL("../firedrill/tools/unstructured/lib/wire-multipart.mjs", import.meta.url));
  const { parseLanguages, MAX_LANGUAGES, MAX_LANGUAGE_LENGTH } = await import(new URL("../firedrill/tools/unstructured/lib/validate.mjs", import.meta.url));
  const { RESERVED } = await import(new URL("../firedrill/tools/unstructured/lib/wire.mjs", import.meta.url));
  const multipartOutcome = (m) => {
    const request = { headers: { "content-type": [m.contentType] }, path: { workflow_id: "w" }, body: { kind: "text", value: m.body } };
    const args = decodePartition(request).arguments;
    decodeRun(request);
    if (Object.hasOwn(args, RESERVED)) return /^(400|422):/.test(args[RESERVED]) ? "refused" : `undeclared ${args[RESERVED].slice(0, 60)}`;
    if (args.languages === undefined) return "ok";
    const issues = { items: [], add(loc, message) { this.items.push(`${loc}: ${message}`); } };
    const list = parseLanguages(args.languages, "body.languages", issues);
    const flat = Array.isArray(args.languages) ? args.languages : String(args.languages).split(",").map((x) => x.trim()).filter((x) => x.length > 0);
    const fits = flat.length <= MAX_LANGUAGES && flat.every((x) => typeof x === "string" && x.length <= MAX_LANGUAGE_LENGTH);
    if (fits) return list !== null && list.length === flat.length && list.every((x, i) => x === flat[i]) ? "ok" : "undeclared languages changed";
    return list === null && issues.items.length > 0 ? "VALIDATION_ERROR" : "undeclared languages cut";
  };
  const formats = new Map();
  const failures = [];
  let peakRss = 0;
  // Warm the partitioners once so JIT compilation is not charged to the first measured case of each format.
  for (let i = 0; i < 18; i += 1) {
    const c = makeCase(seed + 7919, i);
    partitionFile({ filename: c.filename, content: c.content.slice(0, 2048) }, c.options, null);
  }
  for (let index = from; index < cases; index += 1) {
    Atomics.store(progress, 0, index);
    const c = makeCase(seed, index);
    const started = performance.now();
    let outcome;
    try {
      const result = partitionFile({ filename: c.filename, content: c.content, bad_transfer: c.badTransfer }, c.options, null);
      if (result.ok) {
        JSON.stringify(result.elements);
        outcome = "ok";
      } else outcome = DECLARED.has(result.code) && typeof result.message === "string" ? result.code : `undeclared ${result.code}`;
    } catch (error) {
      outcome = `threw ${String(error?.stack ?? error).slice(0, 300)}`;
    }
    const ms = performance.now() - started;
    const key = c.options.chunk === null ? c.format : `${c.format}+chunk`;
    const stat = formats.get(key) ?? { cases: 0, worst: 0, worstCase: -1, totalMs: 0, outcomes: {} };
    stat.cases += 1;
    stat.totalMs += ms;
    stat.outcomes[outcome.split(" ")[0]] = (stat.outcomes[outcome.split(" ")[0]] ?? 0) + 1;
    if (ms > stat.worst) Object.assign(stat, { worst: ms, worstCase: index, worstShape: c.shape, worstSize: c.content.length });
    formats.set(key, stat);
    if (ms > limitMs || outcome.startsWith("threw") || outcome.startsWith("undeclared")) {
      failures.push({ index, format: key, shape: c.shape, size: c.content.length, ms: Math.round(ms), outcome });
    }
    if (index % MULTIPART_EVERY === MULTIPART_EVERY - 1) {
      const m = makeMultipartCase(seed, index);
      const mStarted = performance.now();
      let mOutcome;
      try {
        mOutcome = multipartOutcome(m);
      } catch (error) {
        mOutcome = `threw ${String(error?.stack ?? error).slice(0, 300)}`;
      }
      const mMs = performance.now() - mStarted;
      const mStat = formats.get("multipart") ?? { cases: 0, worst: 0, worstCase: -1, totalMs: 0, outcomes: {} };
      mStat.cases += 1;
      mStat.totalMs += mMs;
      mStat.outcomes[mOutcome.split(" ")[0]] = (mStat.outcomes[mOutcome.split(" ")[0]] ?? 0) + 1;
      if (mMs > mStat.worst) Object.assign(mStat, { worst: mMs, worstCase: index, worstShape: m.shape, worstSize: m.body.length });
      formats.set("multipart", mStat);
      if (mMs > limitMs || mOutcome.startsWith("threw") || mOutcome.startsWith("undeclared")) failures.push({ index, format: "multipart", shape: m.shape, size: m.body.length, ms: Math.round(mMs), outcome: mOutcome });
    }
    if (index % 250 === 0) {
      const rss = process.memoryUsage().rss;
      peakRss = Math.max(peakRss, rss);
      if (rss > RSS_LIMIT) {
        failures.push({ index, format: key, shape: c.shape, size: c.content.length, ms: Math.round(ms), outcome: `rss ${rss} bytes over ${RSS_LIMIT}` });
        break;
      }
    }
  }
  Atomics.store(progress, 0, -1);
  parentPort.postMessage({ formats: Object.fromEntries(formats), failures, peakRss });
}

/**
 * Runs `cases` hostile cases of `seed` and resolves { cases, formats, failures, peakRss, elapsedMs }. A hung case is reported
 * as a failure (the worker is terminated) rather than blocking the caller.
 */
export function runHostile({ seed = 1, cases = 20000, limitMs = LIMIT_MS, hangMs = HANG_MS } = {}) {
  const shared = new SharedArrayBuffer(4);
  const progress = new Int32Array(shared);
  const started = Date.now();
  return new Promise((resolve) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { seed, cases, from: 0, shared, limitMs }, resourceLimits: { maxOldGenerationSizeMb: 4096 } });
    let last = -2;
    let since = Date.now();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve({ cases, elapsedMs: Date.now() - started, ...value });
    };
    const timer = setInterval(() => {
      const current = Atomics.load(progress, 0);
      if (current !== last) {
        last = current;
        since = Date.now();
      } else if (current >= 0 && Date.now() - since > hangMs) {
        const c = makeCase(seed, current);
        void worker.terminate();
        finish({ formats: {}, peakRss: 0, failures: [{ index: current, format: c.format, shape: c.shape, size: c.content.length, ms: Date.now() - since, outcome: "hang (worker terminated)" }] });
      }
    }, 100);
    worker.on("message", (message) => finish(message));
    worker.on("error", (error) => finish({ formats: {}, peakRss: 0, failures: [{ index: Atomics.load(progress, 0), outcome: `worker error ${String(error?.stack ?? error).slice(0, 300)}` }] }));
    worker.on("exit", (code) => finish({ formats: {}, peakRss: 0, failures: [{ index: Atomics.load(progress, 0), outcome: `worker exited ${code} without a result` }] }));
  });
}

if (!isMainThread && workerData?.shared !== undefined) await workerMain();
else if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = Number.parseInt(process.argv[2] ?? "1", 10);
  const cases = Number.parseInt(process.argv[3] ?? "20000", 10);
  const report = await runHostile({ seed, cases });
  const rows = Object.entries(report.formats).sort(([a], [b]) => a.localeCompare(b));
  for (const [format, stat] of rows) {
    console.log(`${format.padEnd(15)} cases=${String(stat.cases).padStart(5)} worst=${stat.worst.toFixed(1)}ms (case ${stat.worstCase}, ${stat.worstShape}, ${stat.worstSize} chars) mean=${(stat.totalMs / stat.cases).toFixed(2)}ms ${JSON.stringify(stat.outcomes)}`);
  }
  console.log(`seed=${seed} cases=${cases} elapsed=${report.elapsedMs}ms peakRss=${Math.round(report.peakRss / 1048576)}MiB failures=${report.failures.length}`);
  for (const failure of report.failures.slice(0, 50)) console.log(`FAIL ${JSON.stringify(failure)}`);
  process.exitCode = report.failures.length > 0 ? 1 : 0;
}
