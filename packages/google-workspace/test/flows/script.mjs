// Apps Script project, content, version, deployment, execution and process flows.
import assert from "node:assert/strict";
import { DEPLOYMENT, SCRIPT, SCRIPTS, api, expectGoogleError, ok, toolError } from "../lib.mjs";

const MANIFEST = JSON.stringify({ timeZone: "Etc/UTC", dependencies: {}, exceptionLogging: "STACKDRIVER", runtimeVersion: "V8" });
const WEBAPP_MANIFEST = JSON.stringify({
  timeZone: "Etc/UTC", dependencies: {}, exceptionLogging: "STACKDRIVER", runtimeVersion: "V8",
  webapp: { access: "ANYONE", executeAs: "USER_ACCESSING" },
});

async function appsScript() {
  const project = await api("POST", `${SCRIPT}/projects`, { body: { title: "Vendor digest" }, idempotencyKey: "gw-project-1" });
  assert.equal(project.status, 200);
  const scriptId = project.body.scriptId;
  assert.match(scriptId, /^1[A-Za-z0-9_-]{43}$/);
  assert.equal(project.body.owner.email, "ada.okonkwo@northwind-labs.example.com");
  expectGoogleError(await api("POST", `${SCRIPT}/projects`, { body: { title: "  " } }), 400, "INVALID_ARGUMENT", "empty title");

  const seeded = await api("GET", `${SCRIPT}/projects/${scriptId}/content`);
  assert.equal(seeded.status, 200);
  assert.deepEqual(seeded.body.files.map((file) => file.name).sort(), ["Code", "appsscript"]);
  assert.deepEqual(seeded.body.files.find((file) => file.name === "Code").functionSet.values, [{ name: "myFunction" }]);

  const content = await api("PUT", `${SCRIPT}/projects/${scriptId}/content`, {
    body: {
      files: [
        { name: "Code", type: "SERVER_JS", source: 'function total(p1, p2) {\n  return p1 + p2;\n}\n\nfunction label() {\n  return scriptTitle();\n}\n\nfunction inf() {\n  return 1e308 * 10;\n}\n\nfunction nan() {\n  return 1e308 * 10 - 1e308 * 10;\n}\n\nfunction big() {\n  return 1e999;\n}\n\nfunction neg() {\n  return -1;\n}\n\nfunction negFrac() {\n  return -1.5;\n}\n\nfunction doubleNeg() {\n  return 2 - -3;\n}\n\nfunction negParam(p1) {\n  return -p1;\n}\n' },
        { name: "Extra", type: "SERVER_JS", source: "function counter() {\n  return contactCount();\n}\n" },
        { name: "appsscript", type: "JSON", source: WEBAPP_MANIFEST },
      ],
    },
  });
  assert.equal(content.status, 200);
  const functions = content.body.files.find((file) => file.name === "Code").functionSet.values.map((entry) => entry.name);
  assert.deepEqual(functions, ["total", "label", "inf", "nan", "big", "neg", "negFrac", "doubleNeg", "negParam"], "the function set is recomputed from the source");

  expectGoogleError(
    await api("PUT", `${SCRIPT}/projects/${scriptId}/content`, { body: { files: [{ name: "Code", type: "SERVER_JS", source: "" }, { name: "Code", type: "SERVER_JS", source: "" }, { name: "appsscript", type: "JSON", source: MANIFEST }] } }),
    400, "INVALID_ARGUMENT", "duplicate file name",
  );
  expectGoogleError(
    await api("PUT", `${SCRIPT}/projects/${scriptId}/content`, { body: { files: [{ name: "Code", type: "SERVER_JS", source: "" }] } }),
    400, "INVALID_ARGUMENT", "missing manifest",
  );
  const extensionManifest = await api("PUT", `${SCRIPT}/projects/${scriptId}/content`, { body: { files: [{ name: "appsscript.json", type: "JSON", source: MANIFEST }] } });
  expectGoogleError(extensionManifest, 400, "INVALID_ARGUMENT", "manifest named with an extension");
  assert.match(extensionManifest.body.error.message, /must be named "appsscript"/);
  expectGoogleError(
    await api("PUT", `${SCRIPT}/projects/${scriptId}/content`, { body: { files: [{ name: "Big", type: "SERVER_JS", source: "x".repeat(20000) }, { name: "appsscript", type: "JSON", source: MANIFEST }] } }),
    400, "INVALID_ARGUMENT", "file over the byte cap",
  );
  expectGoogleError(
    await api("PUT", `${SCRIPT}/projects/${SCRIPTS.missing}/content`, { body: { files: [{ name: "appsscript", type: "JSON", source: MANIFEST }] } }),
    404, "NOT_FOUND", "content update on an unknown project",
  );

  const version = await api("POST", `${SCRIPT}/projects/${scriptId}/versions`, { body: { description: "First digest" } });
  assert.equal(version.status, 200);
  assert.equal(version.body.versionNumber, 1);
  expectGoogleError(await api("POST", `${SCRIPT}/projects/${SCRIPTS.missing}/versions`, { body: {} }), 404, "NOT_FOUND", "version on an unknown project");
  expectGoogleError(await api("POST", `${SCRIPT}/projects/${scriptId}/versions`, { body: { description: "x".repeat(400) } }), 400, "INVALID_ARGUMENT", "long description");

  const atVersion = await api("GET", `${SCRIPT}/projects/${scriptId}/content`, { query: { versionNumber: 1 } });
  assert.equal(atVersion.status, 200);
  assert.equal(atVersion.body.files.length, 3);
  expectGoogleError(await api("GET", `${SCRIPT}/projects/${scriptId}/content`, { query: { versionNumber: 9 } }), 404, "NOT_FOUND", "unknown version");
  expectGoogleError(await api("GET", `${SCRIPT}/projects/${scriptId}/content`, { query: { versionNumber: 0 } }), 400, "INVALID_ARGUMENT", "version zero");

  const webApp = await api("POST", `${SCRIPT}/projects/${scriptId}/deployments`, { body: { versionNumber: 1, description: "Digest web app" } });
  assert.equal(webApp.status, 200);
  assert.equal(webApp.body.entryPoints[0].entryPointType, "WEB_APP");
  assert.equal(webApp.body.entryPoints[0].webApp.entryPointConfig.access, "ANYONE");
  assert.match(webApp.body.entryPoints[0].webApp.url, /^https:\/\/script\.google\.com\/macros\/s\/AKfycb[A-Za-z0-9_-]{30}\/exec$/);

  const head = await api("POST", `${SCRIPT}/projects/${scriptId}/deployments`, { body: { description: "HEAD deployment" } });
  assert.equal(head.status, 200);
  assert.equal(head.body.deploymentConfig.versionNumber, undefined);
  expectGoogleError(
    await api("POST", `${SCRIPT}/projects/${scriptId}/deployments`, { body: { scriptId: SCRIPTS.missing } }),
    400, "INVALID_ARGUMENT", "deploymentConfig.scriptId mismatch",
  );
  expectGoogleError(
    await api("POST", `${SCRIPT}/projects/${scriptId}/deployments`, { body: { versionNumber: 42 } }),
    404, "NOT_FOUND", "deploying an unknown version",
  );

  const firstPage = await api("GET", `${SCRIPT}/projects/${scriptId}/deployments`, { query: { pageSize: 1 } });
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.deployments.length, 1);
  assert.ok(firstPage.body.nextPageToken !== undefined);
  const secondPage = await api("GET", `${SCRIPT}/projects/${scriptId}/deployments`, { query: { pageToken: firstPage.body.nextPageToken } });
  assert.equal(secondPage.body.deployments.length, 1);
  assert.notEqual(secondPage.body.deployments[0].deploymentId, firstPage.body.deployments[0].deploymentId);
  expectGoogleError(await api("GET", `${SCRIPT}/projects/${scriptId}/deployments`, { query: { pageSize: 900 } }), 400, "OUT_OF_RANGE", "deployment page size");
  expectGoogleError(await api("GET", `${SCRIPT}/projects/${SCRIPTS.missing}/deployments`), 404, "NOT_FOUND", "deployments of an unknown project");
  await toolError("deployments.list", { scriptId: SCRIPTS.vendorSync, pageToken: "###" }, "INVALID_ARGUMENT");

  const seededDeployments = await api("GET", `${SCRIPT}/projects/${SCRIPTS.vendorSync}/deployments`);
  assert.equal(seededDeployments.body.deployments[0].deploymentId, DEPLOYMENT);
  assert.equal(seededDeployments.body.deployments[0].entryPoints[0].entryPointType, "EXECUTION_API");

  // The runtime computes results; it never returns a canned payload.
  const greet = await api("POST", `${SCRIPT}/scripts/${SCRIPTS.vendorSync}:run`, { body: { function: "greet", parameters: ["Ada"] } });
  assert.equal(greet.status, 200);
  assert.equal(greet.body.response.result, "Hello, Ada");
  assert.equal(greet.body.response["@type"], "type.googleapis.com/google.apps.script.v1.ExecutionResponse");

  const counted = await api("POST", `${SCRIPT}/scripts/${SCRIPTS.vendorSync}:run`, { body: { function: "countContacts" } });
  assert.equal(counted.status, 200);
  const connections = await api("GET", "/people/v1/people/me/connections", { query: { personFields: "names", pageSize: 1 } });
  assert.equal(counted.body.response.result, connections.body.totalPeople, "countContacts() reads the caller's own contacts");

  const synced = await api("POST", `${SCRIPT}/scripts/${SCRIPTS.vendorSync}:run`, { body: { function: "syncInvoices" } });
  assert.equal(synced.body.response.result, `synced ${connections.body.totalPeople} vendor contacts`);

  expectGoogleError(
    await api("POST", `${SCRIPT}/scripts/${SCRIPTS.vendorSync}:run`, { body: { function: "noSuchFunction" } }),
    400, "INVALID_ARGUMENT", "unknown function",
  );
  expectGoogleError(
    await api("POST", `${SCRIPT}/scripts/${scriptId}:run`, { body: { function: "label" } }),
    404, "NOT_FOUND", "no API executable deployment",
  );
  expectGoogleError(
    await api("POST", `${SCRIPT}/scripts/${SCRIPTS.vendorSync}:execute`, { body: { function: "greet" } }),
    404, "NOT_FOUND", "unsupported script method",
  );
  const devRun = await api("POST", `${SCRIPT}/scripts/${scriptId}:run`, { body: { function: "label", devMode: true } });
  assert.equal(devRun.status, 200);
  assert.equal(devRun.body.response.result, "Vendor digest");

  // Arithmetic that leaves the finite JSON number range is a script exception (HTTP 200 + ExecutionError), never a 5xx.
  for (const [name, pattern] of [["inf", /non-finite numeric result in inf/], ["nan", /non-finite numeric result in nan/], ["big", /non-finite numeric result in big/]]) {
    const overflow = await api("POST", `${SCRIPT}/scripts/${scriptId}:run`, { body: { function: name, devMode: true } });
    assert.equal(overflow.status, 200, `${name}: a non-finite result is a ScriptError, not a handler failure`);
    assert.equal(overflow.body.done, true);
    assert.equal(overflow.body.error.message, "ScriptError");
    assert.match(overflow.body.error.details[0].errorMessage, pattern);
  }

  // A numeric literal may carry a leading minus (`-1`, `2 - -3`); a sign on anything else is outside the grammar.
  for (const [name, expected] of [["neg", -1], ["negFrac", -1.5], ["doubleNeg", 5]]) {
    const signed = await api("POST", `${SCRIPT}/scripts/${scriptId}:run`, { body: { function: name, devMode: true } });
    assert.equal(signed.status, 200, `${name}: a leading minus on a numeric literal is accepted`);
    assert.equal(signed.body.done, true);
    assert.equal(signed.body.response.result, expected, `${name}: the signed literal is evaluated`);
  }
  const negParam = await api("POST", `${SCRIPT}/scripts/${scriptId}:run`, { body: { function: "negParam", parameters: [4], devMode: true } });
  assert.equal(negParam.status, 200, "negating a parameter is a ScriptError, not a handler failure");
  assert.equal(negParam.body.error.message, "ScriptError");
  assert.match(negParam.body.error.details[0].errorMessage, /unsupported expression in negParam/);

  // Ada is neither owner nor editor of "Legacy cleanup".
  expectGoogleError(await api("GET", `${SCRIPT}/projects/${SCRIPTS.legacy}`), 403, "PERMISSION_DENIED", "another owner's project");
  expectGoogleError(await api("GET", `${SCRIPT}/projects/${SCRIPTS.missing}`), 404, "NOT_FOUND", "unknown project");
  expectGoogleError(await api("GET", `${SCRIPT}/projects/not-a-script-id`), 400, "INVALID_ARGUMENT", "malformed script id");

  const editorProject = await api("GET", `${SCRIPT}/projects/${SCRIPTS.onboarding}`);
  assert.equal(editorProject.status, 200, "Ada is an editor of Onboarding forms");

  const processes = await api("GET", `${SCRIPT}/processes`);
  assert.equal(processes.status, 200);
  assert.ok(processes.body.processes.length >= 4);
  assert.equal(processes.body.processes[0].startTime >= processes.body.processes[1].startTime, true, "newest first");
  const filtered = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.scriptId": SCRIPTS.vendorSync } });
  assert.ok(filtered.body.processes.every((entry) => entry.projectName === "Vendor invoice sync"));
  const failed = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.statuses": ["FAILED"] } });
  assert.ok(failed.body.processes.every((entry) => entry.processStatus === "FAILED"));
  const after = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.startTime": "2026-09-15T00:00:00Z" } });
  assert.ok(after.body.processes.every((entry) => entry.startTime >= "2026-09-15"));
  assert.ok(after.body.processes.length < processes.body.processes.length, "startTime narrows the list");
  const before = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.endTime": "2026-09-15T00:00:00Z" } });
  assert.ok(before.body.processes.length > 0 && before.body.processes.every((entry) => entry.startTime < "2026-09-15"));
  assert.equal(before.body.processes.length + after.body.processes.length, processes.body.processes.length, "startTime/endTime partition the list");
  const byProject = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.projectName": "Vendor invoice sync" } });
  assert.deepEqual(byProject.body.processes, filtered.body.processes, "projectName filter matches the scriptId filter");
  const byLevel = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.userAccessLevels": ["OWNER"] } });
  assert.ok(byLevel.body.processes.every((entry) => entry.userAccessLevel === "OWNER"));
  const byDeployment = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.deploymentId": "AKfycbNoSuchDeployment0000000000000" } });
  assert.deepEqual(byDeployment.body.processes, []);
  expectGoogleError(
    await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.startTime": "2026-09-15T00:00:00Z", "userProcessFilter.endTime": "2026-09-14T00:00:00Z" } }),
    400, "INVALID_ARGUMENT", "endTime before startTime",
  );
  expectGoogleError(
    await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.userAccessLevels": ["ROOT"] } }),
    400, "INVALID_ARGUMENT", "unknown access level",
  );
  // Paging at two rows a page must return every process exactly once.
  let pageToken;
  let pagedTotal = 0;
  let pages = 0;
  do {
    const page = await api("GET", `${SCRIPT}/processes`, { query: { pageSize: 2, pageToken } });
    assert.equal(page.status, 200);
    assert.ok(page.body.processes.length <= 2);
    pagedTotal += page.body.processes.length;
    pageToken = page.body.nextPageToken;
    pages += 1;
    assert.ok(pages <= 20, "process paging did not terminate");
  } while (pageToken !== undefined);
  assert.equal(pagedTotal, processes.body.processes.length, "paging returns the same processes as one page");
  assert.ok(pages >= 2);

  expectGoogleError(
    await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.startTime": "2026-09-15 00:00:00" } }),
    400, "INVALID_ARGUMENT", "zone-less timestamp",
  );
  expectGoogleError(
    await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.statuses": ["NOPE"] } }),
    400, "INVALID_ARGUMENT", "unknown process status",
  );
  expectGoogleError(await api("GET", `${SCRIPT}/processes`, { query: { pageSize: 900 } }), 400, "OUT_OF_RANGE", "process page size");
  await toolError("processes.list", { pageToken: "###" }, "INVALID_ARGUMENT");
}

async function appsScriptOwner() {
  // Bruno owns "Legacy cleanup"; its body is outside the supported grammar, so the run is a ScriptError.
  const run = await api("POST", `${SCRIPT}/scripts/${SCRIPTS.legacy}:run`, { body: { function: "purgeOldRows", devMode: true } });
  assert.equal(run.status, 200, "a script exception is a successful API call");
  assert.equal(run.body.done, true);
  assert.equal(run.body.error.message, "ScriptError");
  assert.equal(run.body.error.details[0]["@type"], "type.googleapis.com/google.apps.script.v1.ExecutionError");
  assert.match(run.body.error.details[0].errorMessage, /unsupported statement in purgeOldRows/);

  const processes = await api("GET", `${SCRIPT}/processes`, { query: { "userProcessFilter.functionName": "purgeOldRows" } });
  assert.ok(processes.body.processes.some((entry) => entry.processStatus === "FAILED"));

  const ownProject = await api("GET", `${SCRIPT}/projects/${SCRIPTS.legacy}`);
  assert.equal(ownProject.status, 200);
  assert.equal(ownProject.body.owner.email, "bruno.marek@northwind-labs.example.com");

  const content = await ok("script-projects.get-content", { scriptId: SCRIPTS.onboarding });
  assert.equal(content.files.length, 2);
  const version = await ok("script-versions.create", { scriptId: SCRIPTS.onboarding, description: "Bruno's first version" });
  assert.equal(version.versionNumber, 1);
  const deployment = await ok("deployments.create", { scriptId: SCRIPTS.onboarding, deploymentConfig: { versionNumber: 1 } });
  assert.equal(deployment.entryPoints[0].entryPointType, "EXECUTION_API");
  const listed = await ok("deployments.list", { scriptId: SCRIPTS.onboarding });
  assert.equal(listed.deployments.length, 1);
  const updated = await ok("script-projects.update-content", {
    scriptId: SCRIPTS.onboarding,
    files: [
      { name: "Code", type: "SERVER_JS", source: "function collectResponses() {\n  return groupCount();\n}\n" },
      { name: "appsscript", type: "JSON", source: MANIFEST },
    ],
  });
  assert.equal(updated.files.length, 2);
  const groups = await ok("contact-groups.list", {});
  const ran = await ok("scripts.run", { scriptId: SCRIPTS.onboarding, function: "collectResponses" });
  assert.equal(ran.response.result, groups.totalItems, "groupCount() reads the caller's own groups");
  const project = await ok("script-projects.create", { title: "Bruno scratch" });
  assert.equal(project.title, "Bruno scratch");
}

export const FLOWS = { "apps-script": appsScript, "apps-script-owner": appsScriptOwner };
