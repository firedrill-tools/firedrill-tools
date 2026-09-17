// scripts.run and processes.list.
import { invalid, notFound, outOfRange } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { checkScriptId } from "../lib/names.mjs";
import { fillPage, mintKeyedToken, pageSize, resumeIndex } from "../lib/page.mjs";
import { renderProcess } from "../lib/render.mjs";
import { contentRowId, executionRowId, saveMeta, scanPrefix } from "../lib/store.mjs";
import { clip, isMangled, jsonBytes, parseRfc3339 } from "../lib/util.mjs";
import { begin, loadContacts, loadGroups } from "./common.mjs";
import { ScriptError, evaluate, extractBody } from "./runtime.mjs";
import { loadProject } from "./script.mjs";

const SCRIPT = "script.googleapis.com";
const EXECUTION_CAP = 500;
const MAX_PARAMETERS = 10;
const MAX_PARAMETER_BYTES = 4096;
const EXECUTION_ERROR_TYPE = "type.googleapis.com/google.apps.script.v1.ExecutionError";
const EXECUTION_RESPONSE_TYPE = "type.googleapis.com/google.apps.script.v1.ExecutionResponse";

export function runScript(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROJECTS], SCRIPT, "google.apps.script.v1.Scripts.Run");
  checkScriptId(context, input.scriptId);
  const project = loadProject(context, caller, input.scriptId, true);

  const functionName = input.function;
  if (typeof functionName !== "string" || functionName.trim().length === 0) invalid(context, "A function name is required.");
  if (functionName.length > 80) invalid(context, "A function name accepts at most 80 characters.");
  if (isMangled(functionName)) invalid(context, "The function name contains characters that could not be decoded.");

  const devMode = input.devMode === true;
  if (devMode && project.ownerUserId !== caller.user.id && !(project.editorUserIds ?? []).includes(caller.user.id)) {
    invalid(context, "devMode requires the caller to be the project's owner or an editor.");
  }
  const sessionState = input.sessionState;
  if (sessionState !== undefined && sessionState !== null && (typeof sessionState !== "string" || sessionState.length > 200)) {
    invalid(context, "sessionState accepts at most 200 characters.");
  }

  const args = readParameters(context, input.parameters);

  let deploymentId = null;
  let versionNumber = null;
  if (!devMode) {
    const deployment = newestExecutionApiDeployment(context, project.scriptId);
    if (deployment === null) {
      notFound(context, "Requested entity was not found. The script has no API executable deployment; deploy it or call with devMode.");
    }
    deploymentId = deployment.deploymentId;
    versionNumber = deployment.versionNumber;
  }

  const content = context.state.get("script-content", contentRowId(project.scriptId, versionNumber));
  if (content === null) notFound(context, "Requested entity was not found.");

  const declared = new Set();
  for (const file of content.files) for (const name of file.functionNames) declared.add(name);
  if (!declared.has(functionName)) {
    invalid(context, `Script function "${clip(functionName, 80)}" was not found in the deployed content.`, "FUNCTION_NOT_FOUND");
  }

  const file = content.files.find((entry) => entry.type === "SERVER_JS" && entry.functionNames.includes(functionName));
  const extracted = file === undefined ? null : extractBody(file.source, functionName);

  const builtins = {
    contactCount: () => loadContacts(context, caller.user.id).size,
    groupCount: () => loadGroups(context, caller.user.id).size,
    scriptTitle: () => project.title,
  };

  const startedAt = context.clock.nowUs();
  let result = null;
  let errorMessage = null;
  if (extracted === null) {
    errorMessage = `Exception: the body of ${functionName} could not be read`;
  } else {
    try {
      result = evaluate(functionName, extracted.body, extracted.params, args, builtins);
    } catch (error) {
      if (!(error instanceof ScriptError)) throw error;
      errorMessage = error.message;
    }
  }

  const status = errorMessage === null ? "COMPLETED" : "FAILED";
  const durationUs = 120000 + declared.size * 15000;
  recordExecution(context, meta, caller, project, functionName, deploymentId, devMode, status, startedAt, durationUs, errorMessage);
  saveMeta(context, meta);

  context.events.emit("script.executed", {
    scriptId: project.scriptId,
    projectTitle: project.title,
    functionName,
    deploymentId,
    devMode,
    status,
    durationUs,
    executedByUserId: caller.user.id,
    errorMessage,
  });

  if (errorMessage !== null) {
    // A script exception is a successful API call: HTTP 200 carrying an ExecutionError.
    return {
      done: true,
      error: {
        code: 3,
        message: "ScriptError",
        details: [{
          "@type": EXECUTION_ERROR_TYPE,
          errorMessage,
          errorType: "ScriptError",
          scriptStackTraceElements: [{ function: functionName, lineNumber: 1 }],
        }],
      },
    };
  }
  return { done: true, response: { "@type": EXECUTION_RESPONSE_TYPE, result } };
}

function readParameters(context, raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) invalid(context, "parameters must be an array.");
  if (raw.length > MAX_PARAMETERS) invalid(context, `parameters accepts at most ${MAX_PARAMETERS} entries, got ${raw.length}.`);
  for (const entry of raw) {
    if (jsonBytes(entry === undefined ? null : entry) > MAX_PARAMETER_BYTES) {
      invalid(context, `Each parameter must encode to at most ${MAX_PARAMETER_BYTES} bytes.`);
    }
  }
  return raw.map((entry) => (entry === undefined ? null : entry));
}

function newestExecutionApiDeployment(context, scriptId) {
  let best = null;
  for (const entry of scanPrefix(context, "script-deployments", `${scriptId}:`)) {
    const row = context.state.get("deployments", entry.rowId.slice(entry.rowId.indexOf(":") + 1));
    if (row === null || row.entryPointType !== "EXECUTION_API") continue;
    if (best === null || row.createTimeUs > best.createTimeUs || (row.createTimeUs === best.createTimeUs && row.deploymentId > best.deploymentId)) {
      best = row;
    }
  }
  return best;
}

function recordExecution(context, meta, caller, project, functionName, deploymentId, devMode, status, startTimeUs, durationUs, errorMessage) {
  const seq = meta.nextExecutionSeq;
  meta.nextExecutionSeq += 1;
  const row = {
    scriptId: project.scriptId,
    projectName: project.title,
    functionName,
    deploymentId,
    processType: devMode ? "EDITOR" : "EXECUTION_API",
    processStatus: status,
    userAccessLevel: project.ownerUserId === caller.user.id ? "OWNER" : "WRITE",
    startTimeUs,
    durationUs,
    runtimeVersion: "V8",
    errorMessage: errorMessage === null ? null : clip(errorMessage, 400),
  };
  context.state.put("executions", executionRowId(caller.user.id, startTimeUs, seq), row);

  const rows = scanPrefix(context, "executions", `${caller.user.id}:`);
  if (rows.length > EXECUTION_CAP) {
    for (const stale of rows.slice(0, rows.length - EXECUTION_CAP)) context.state.delete("executions", stale.rowId);
  }
}

const STATUSES = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELED", "RUNNING", "PAUSED"]);
const TYPES = new Set(["EXECUTION_API", "WEBAPP", "TRIGGER", "EDITOR", "SIMPLE_TRIGGER", "MENU", "BATCH_TASK"]);
const ACCESS_LEVELS = new Set(["NONE", "READ", "WRITE", "OWNER"]);

export function listProcesses(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROCESSES], SCRIPT, "google.apps.script.v1.Processes.ListUserProcesses");
  const limit = pageSize(context, input.pageSize, 1, 200, 50);
  const filter = input.userProcessFilter ?? {};
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) invalid(context, "userProcessFilter must be an object.");

  if (filter.scriptId !== undefined && filter.scriptId !== null) {
    if (typeof filter.scriptId !== "string" || filter.scriptId.length > 60) invalid(context, "userProcessFilter.scriptId is not a valid script id.");
  }
  if (filter.functionName !== undefined && filter.functionName !== null) {
    if (typeof filter.functionName !== "string" || filter.functionName.length > 80) invalid(context, "userProcessFilter.functionName accepts at most 80 characters.");
    if (isMangled(filter.functionName)) invalid(context, "userProcessFilter.functionName contains characters that could not be decoded.");
  }
  const statuses = readEnumList(context, filter.statuses, STATUSES, "statuses", 6);
  const types = readEnumList(context, filter.types, TYPES, "types", 4);
  const after = readTime(context, filter.startTime, "startTime");
  const before = readTime(context, filter.endTime, "endTime");
  if (after !== null && before !== null && before <= after) invalid(context, "userProcessFilter.endTime must be later than userProcessFilter.startTime.");
  if (filter.deploymentId !== undefined && filter.deploymentId !== null) {
    if (typeof filter.deploymentId !== "string" || filter.deploymentId.length > 60) invalid(context, "userProcessFilter.deploymentId is not a valid deployment id.");
  }
  if (filter.projectName !== undefined && filter.projectName !== null) {
    if (typeof filter.projectName !== "string" || filter.projectName.length > 120) invalid(context, "userProcessFilter.projectName accepts at most 120 characters.");
    if (isMangled(filter.projectName)) invalid(context, "userProcessFilter.projectName contains characters that could not be decoded.");
  }
  const accessLevels = readEnumList(context, filter.userAccessLevels, ACCESS_LEVELS, "userAccessLevels", 4);

  const rows = scanPrefix(context, "executions", `${caller.user.id}:`).map((row) => ({ rowId: row.rowId, value: row.value }));
  const matched = rows
    .filter(({ value }) => {
      if (filter.scriptId !== undefined && filter.scriptId !== null && value.scriptId !== filter.scriptId) return false;
      if (filter.functionName !== undefined && filter.functionName !== null && value.functionName !== filter.functionName) return false;
      if (statuses !== null && !statuses.has(value.processStatus)) return false;
      if (types !== null && !types.has(value.processType)) return false;
      if (after !== null && value.startTimeUs < after) return false;
      if (before !== null && value.startTimeUs >= before) return false;
      if (filter.deploymentId !== undefined && filter.deploymentId !== null && value.deploymentId !== filter.deploymentId) return false;
      if (filter.projectName !== undefined && filter.projectName !== null && value.projectName !== filter.projectName) return false;
      if (accessLevels !== null && !accessLevels.has(value.userAccessLevel)) return false;
      return true;
    })
    .sort((a, b) => b.value.startTimeUs - a.value.startTimeUs || (a.rowId < b.rowId ? 1 : -1));

  const scope = `processes:${caller.user.id}`;
  const processKey = (entry) => [entry.value.startTimeUs, entry.rowId];
  const start = resumeIndex(context, input.pageToken, scope, matched, (entry) => entry.rowId, processKey, [-1, -1]);
  const { entries, nextIndex } = fillPage(
    matched,
    start,
    limit,
    (entry) => renderProcess(entry.value),
    () => outOfRange(context, "A single process record is larger than the maximum response size for this simulation."),
  );
  const out = { processes: entries };
  if (nextIndex < matched.length) out.nextPageToken = mintKeyedToken(scope, matched[nextIndex].rowId, processKey(matched[nextIndex]));
  return out;
}

function readEnumList(context, raw, allowed, field, max) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) invalid(context, `userProcessFilter.${field} must be an array.`);
  if (raw.length === 0) return null;
  if (raw.length > max) invalid(context, `userProcessFilter.${field} accepts at most ${max} entries.`);
  const out = new Set();
  for (const entry of raw) {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      invalid(context, `Invalid userProcessFilter.${field} value "${clip(String(entry), 60)}". Valid values: ${[...allowed].join(", ")}.`);
    }
    out.add(entry);
  }
  return out;
}

function readTime(context, raw, field) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") invalid(context, `userProcessFilter.${field} must be an RFC 3339 timestamp.`);
  const us = parseRfc3339(raw);
  if (us === null) {
    invalid(
      context,
      `userProcessFilter.${field} must be an RFC 3339 timestamp with an explicit UTC offset, for example 2026-09-14T00:00:00Z; got "${clip(raw, 60)}".`,
      "INVALID_TIMESTAMP",
    );
  }
  return us;
}
