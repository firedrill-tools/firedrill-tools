// Apps Script API v1: projects create/get, content get/update, versions.create, deployments create/list.
import { fail, invalid, notFound, outOfRange } from "../lib/errors.mjs";
import { SCOPES, requireScope } from "../lib/identity.mjs";
import { checkScriptId } from "../lib/names.mjs";
import { fillPage, mintKeyedToken, pageSize, resumeIndex } from "../lib/page.mjs";
import { renderContent, renderDeployment, renderProject, renderVersion } from "../lib/render.mjs";
import {
  contentRowId, deploymentIdFor, reserveObjects, saveMeta, scanPrefix, scriptIdFor, versionRowId,
} from "../lib/store.mjs";
import { clip, isMangled, utf8Length } from "../lib/util.mjs";
import { begin } from "./common.mjs";

const SCRIPT = "script.googleapis.com";
const FILE_NAME_RE = /^[A-Za-z0-9_ .-]{1,100}$/;
const FILE_TYPES = new Set(["SERVER_JS", "HTML", "JSON"]);
// Apps Script file names carry no extension: the manifest is `appsscript` (type JSON), code files are e.g. `Code`.
export const MANIFEST_NAME = "appsscript";
const MAX_FILES = 12;
const MAX_FILE_BYTES = 16384;
const MAX_TOTAL_BYTES = 131072;
const MAX_FUNCTIONS = 20;

const DEFAULT_MANIFEST = JSON.stringify(
  { timeZone: "Etc/UTC", dependencies: {}, exceptionLogging: "STACKDRIVER", runtimeVersion: "V8" },
  null,
  2,
);
const DEFAULT_CODE = "function myFunction() {\n  return 0;\n}\n";

/** Top-level `function name(` declarations, found by a linear scan — the source is never evaluated. */
export function functionNamesOf(source) {
  const names = [];
  const text = stripComments(source);
  let index = 0;
  while (index < text.length && names.length < MAX_FUNCTIONS) {
    const at = text.indexOf("function", index);
    if (at < 0) break;
    const before = at === 0 ? "\n" : text[at - 1];
    index = at + "function".length;
    if (!/[\s;}]/.test(before)) continue;
    let cursor = index;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
    const start = cursor;
    while (cursor < text.length && /[A-Za-z0-9_$]/.test(text[cursor])) cursor += 1;
    const name = text.slice(start, cursor);
    if (name.length === 0 || name.length > 80) continue;
    while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
    if (text[cursor] !== "(") continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Removes `//` and block comments with a single linear pass; string literals are respected. */
export function stripComments(source) {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      index += 1;
      while (index < source.length) {
        out += source[index];
        if (source[index] === "\\") {
          index += 1;
          if (index < source.length) out += source[index];
          index += 1;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

/** Loads a project the caller may at least read; the Apps Script API does reveal existence. */
export function loadProject(context, caller, scriptId, needWrite) {
  checkScriptId(context, scriptId);
  const project = context.state.get("script-projects", scriptId);
  if (project === null) notFound(context, "Requested entity was not found.");
  const editors = project.editorUserIds ?? [];
  const isOwner = project.ownerUserId === caller.user.id;
  const isEditor = editors.includes(caller.user.id);
  if (!isOwner && !isEditor) {
    fail(context, "PERMISSION_DENIED", "The caller does not have permission to access this script project.", "IAM_PERMISSION_DENIED");
  }
  if (needWrite && !isOwner && !isEditor) {
    fail(context, "PERMISSION_DENIED", "The caller does not have permission to modify this script project.", "IAM_PERMISSION_DENIED");
  }
  return project;
}

export function createProject(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROJECTS], SCRIPT, "google.apps.script.v1.Projects.Create");
  const title = input.title;
  if (typeof title !== "string" || title.trim().length === 0) invalid(context, "A script project needs a non-empty title.");
  if (isMangled(title)) invalid(context, "The title contains characters that could not be decoded.");
  if (title.length > 120) invalid(context, "A script project title accepts at most 120 characters.");
  const parentId = input.parentId;
  if (parentId !== undefined && parentId !== null) {
    if (typeof parentId !== "string" || parentId.length === 0 || parentId.length > 60) invalid(context, "parentId must be a Drive file id of at most 60 characters.");
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(parentId)) invalid(context, `Invalid parentId "${clip(parentId, 60)}".`);
  }

  const now = context.clock.nowUs();
  let scriptId = scriptIdFor(meta.nextScriptId);
  let attempts = 0;
  while (context.state.get("script-projects", scriptId) !== null && attempts < 64) {
    meta.nextScriptId += 1;
    scriptId = scriptIdFor(meta.nextScriptId);
    attempts += 1;
  }
  const project = {
    scriptId,
    title: title.trim(),
    parentId: typeof parentId === "string" ? parentId : null,
    ownerUserId: caller.user.id,
    creatorUserId: caller.user.id,
    lastModifyUserId: caller.user.id,
    editorUserIds: [],
    createTimeUs: now,
    updateTimeUs: now,
    headVersion: 0,
    fileCount: 2,
  };
  const files = [
    { name: "Code", type: "SERVER_JS", source: DEFAULT_CODE, functionNames: ["myFunction"], createTimeUs: now, updateTimeUs: now, lastModifyUserId: caller.user.id },
    { name: MANIFEST_NAME, type: "JSON", source: DEFAULT_MANIFEST, functionNames: [], createTimeUs: now, updateTimeUs: now, lastModifyUserId: caller.user.id },
  ];
  reserveObjects(context, meta, 1);
  meta.nextScriptId += 1;
  context.state.put("script-projects", scriptId, project);
  context.state.put("script-content", contentRowId(scriptId, null), {
    scriptId,
    versionNumber: null,
    files,
    totalBytes: files.reduce((sum, file) => sum + utf8Length(file.source), 0),
  });
  saveMeta(context, meta);
  return renderProject(project, caller.users);
}

export function getProject(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROJECTS, SCOPES.SCRIPT_PROJECTS_READONLY], SCRIPT, "google.apps.script.v1.Projects.Get");
  const project = loadProject(context, caller, input.scriptId, false);
  return renderProject(project, caller.users);
}

export function getContent(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROJECTS, SCOPES.SCRIPT_PROJECTS_READONLY], SCRIPT, "google.apps.script.v1.Projects.GetContent");
  const project = loadProject(context, caller, input.scriptId, false);
  let versionNumber = null;
  if (input.versionNumber !== undefined && input.versionNumber !== null) {
    if (!Number.isInteger(input.versionNumber)) invalid(context, "versionNumber must be an integer.");
    if (input.versionNumber <= 0) invalid(context, "versionNumber must be greater than zero.");
    versionNumber = input.versionNumber;
  }
  const content = context.state.get("script-content", contentRowId(project.scriptId, versionNumber));
  if (content === null) notFound(context, versionNumber === null ? "Requested entity was not found." : `Version ${versionNumber} was not found.`);
  return renderContent(project.scriptId, content, caller.users);
}

export function updateContent(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROJECTS], SCRIPT, "google.apps.script.v1.Projects.UpdateContent");
  const project = loadProject(context, caller, input.scriptId, true);
  const raw = input.files;
  if (!Array.isArray(raw) || raw.length === 0) invalid(context, "A content update must carry at least one file.");
  if (raw.length > MAX_FILES) invalid(context, `A script project supports at most ${MAX_FILES} files in this simulation, got ${raw.length}.`);

  const now = context.clock.nowUs();
  const seen = new Set();
  const files = [];
  let totalBytes = 0;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid(context, "Each file must be an object.");
    const name = entry.name;
    if (typeof name !== "string" || !FILE_NAME_RE.test(name)) invalid(context, `Invalid file name "${clip(String(name ?? ""), 100)}".`);
    if (seen.has(name)) invalid(context, `Duplicate file name "${clip(name, 100)}".`);
    seen.add(name);
    const type = entry.type;
    if (typeof type !== "string" || !FILE_TYPES.has(type)) invalid(context, `Invalid file type "${clip(String(type ?? ""), 40)}"; use SERVER_JS, HTML or JSON.`);
    const source = entry.source ?? "";
    if (typeof source !== "string") invalid(context, `File "${clip(name, 100)}" must carry a string source.`);
    if (isMangled(source)) invalid(context, `File "${clip(name, 100)}" contains characters that could not be decoded.`);
    const bytes = utf8Length(source);
    if (bytes > MAX_FILE_BYTES) invalid(context, `File "${clip(name, 100)}" is ${bytes} bytes; the limit is ${MAX_FILE_BYTES}.`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) invalid(context, `The project content is larger than the supported bound of ${MAX_TOTAL_BYTES} bytes.`);
    const functionNames = type === "SERVER_JS" ? functionNamesOf(source) : [];
    if (functionNames.length >= MAX_FUNCTIONS) invalid(context, `File "${clip(name, 100)}" declares more than ${MAX_FUNCTIONS - 1} functions.`);
    files.push({ name, type, source, functionNames, createTimeUs: now, updateTimeUs: now, lastModifyUserId: caller.user.id });
  }

  const manifest = files.find((file) => file.name === MANIFEST_NAME);
  if (manifest === undefined) {
    const withExtension = files.find((file) => file.name === `${MANIFEST_NAME}.json`);
    if (withExtension !== undefined) {
      invalid(context, `File names carry no extension in this API: the manifest must be named "${MANIFEST_NAME}" (type JSON), not "${withExtension.name}".`);
    }
    invalid(context, `A content update must include the "${MANIFEST_NAME}" manifest file.`);
  }
  if (manifest.type !== "JSON") invalid(context, `The "${MANIFEST_NAME}" file must have type JSON.`);
  try {
    const parsed = JSON.parse(manifest.source);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch {
    invalid(context, `The "${MANIFEST_NAME}" file is not a valid JSON object.`);
  }

  context.state.put("script-content", contentRowId(project.scriptId, null), {
    scriptId: project.scriptId,
    versionNumber: null,
    files,
    totalBytes,
  });
  context.state.put("script-projects", project.scriptId, {
    ...project,
    lastModifyUserId: caller.user.id,
    updateTimeUs: now,
    fileCount: files.length,
  });
  saveMeta(context, meta);
  return renderContent(project.scriptId, { files }, caller.users);
}

export function createVersion(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_PROJECTS], SCRIPT, "google.apps.script.v1.Projects.Versions.Create");
  const project = loadProject(context, caller, input.scriptId, true);
  const description = input.description ?? "";
  if (typeof description !== "string" || description.length > 300) invalid(context, "A version description accepts at most 300 characters.");
  if (isMangled(description)) invalid(context, "The description contains characters that could not be decoded.");

  const head = context.state.get("script-content", contentRowId(project.scriptId, null));
  if (head === null) notFound(context, "Requested entity was not found.");

  const now = context.clock.nowUs();
  const versionNumber = (project.headVersion ?? 0) + 1;
  reserveObjects(context, meta, 1);
  context.state.put("script-content", contentRowId(project.scriptId, versionNumber), { ...head, versionNumber });
  context.state.put("script-versions", versionRowId(project.scriptId, versionNumber), {
    scriptId: project.scriptId,
    versionNumber,
    description,
    createTimeUs: now,
    createdByUserId: caller.user.id,
  });
  context.state.put("script-projects", project.scriptId, { ...project, headVersion: versionNumber, updateTimeUs: now, lastModifyUserId: caller.user.id });
  saveMeta(context, meta);
  return renderVersion({ scriptId: project.scriptId, versionNumber, description, createTimeUs: now });
}

const ACCESS = new Set(["MYSELF", "DOMAIN", "ANYONE", "ANYONE_ANONYMOUS"]);
const EXECUTE_AS = new Set(["USER_ACCESSING", "USER_DEPLOYING"]);

export function createDeployment(input, context) {
  const { caller, meta } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_DEPLOYMENTS], SCRIPT, "google.apps.script.v1.Projects.Deployments.Create");
  const project = loadProject(context, caller, input.scriptId, true);
  const config = input.deploymentConfig ?? {};
  if (typeof config !== "object" || config === null || Array.isArray(config)) invalid(context, "deploymentConfig must be an object.");
  if (config.scriptId !== undefined && config.scriptId !== null && config.scriptId !== project.scriptId) {
    invalid(context, "deploymentConfig.scriptId must match the script id in the request path.");
  }
  const description = config.description ?? "";
  if (typeof description !== "string" || description.length > 300) invalid(context, "A deployment description accepts at most 300 characters.");
  const manifestFileName = config.manifestFileName ?? MANIFEST_NAME;
  if (typeof manifestFileName !== "string" || !FILE_NAME_RE.test(manifestFileName)) {
    invalid(context, `Invalid manifestFileName "${clip(String(manifestFileName), 100)}".`);
  }

  let versionNumber = null;
  if (config.versionNumber !== undefined && config.versionNumber !== null) {
    if (!Number.isInteger(config.versionNumber) || config.versionNumber <= 0) invalid(context, "deploymentConfig.versionNumber must be a positive integer.");
    if (context.state.get("script-versions", versionRowId(project.scriptId, config.versionNumber)) === null) {
      notFound(context, `Version ${config.versionNumber} was not found.`);
    }
    versionNumber = config.versionNumber;
  }

  const content = context.state.get("script-content", contentRowId(project.scriptId, versionNumber));
  if (content === null) notFound(context, "Requested entity was not found.");
  const manifest = content.files.find((file) => file.name === manifestFileName);
  if (manifest === undefined) notFound(context, `Manifest file "${clip(manifestFileName, 100)}" was not found in the deployed content.`);
  if (manifest.type !== "JSON") invalid(context, `Manifest file "${clip(manifestFileName, 100)}" must have type JSON.`);

  let entryPointType = "EXECUTION_API";
  let access = "MYSELF";
  let executeAs = "USER_DEPLOYING";
  try {
    const parsed = JSON.parse(manifest.source);
    const webapp = parsed?.webapp;
    if (webapp !== null && typeof webapp === "object" && !Array.isArray(webapp)) {
      entryPointType = "WEB_APP";
      if (typeof webapp.access === "string" && ACCESS.has(webapp.access)) access = webapp.access;
      if (typeof webapp.executeAs === "string" && EXECUTE_AS.has(webapp.executeAs)) executeAs = webapp.executeAs;
    }
  } catch {
    invalid(context, `Manifest file "${clip(manifestFileName, 100)}" is not valid JSON.`);
  }

  const now = context.clock.nowUs();
  let deploymentId = deploymentIdFor(meta.nextDeploymentId);
  let attempts = 0;
  while (context.state.get("deployments", deploymentId) !== null && attempts < 64) {
    meta.nextDeploymentId += 1;
    deploymentId = deploymentIdFor(meta.nextDeploymentId);
    attempts += 1;
  }
  const row = {
    deploymentId,
    scriptId: project.scriptId,
    versionNumber,
    manifestFileName,
    description,
    entryPointType,
    webAppAccess: access,
    webAppExecuteAs: executeAs,
    createTimeUs: now,
    updateTimeUs: now,
    createdByUserId: caller.user.id,
  };
  reserveObjects(context, meta, 1);
  meta.nextDeploymentId += 1;
  context.state.put("deployments", deploymentId, row);
  context.state.put("script-deployments", `${project.scriptId}:${deploymentId}`, { versionNumber });
  saveMeta(context, meta);
  return renderDeployment(row);
}

export function listDeployments(input, context) {
  const { caller } = begin(context, input);
  requireScope(context, caller, [SCOPES.SCRIPT_DEPLOYMENTS, SCOPES.SCRIPT_DEPLOYMENTS_READONLY], SCRIPT, "google.apps.script.v1.Projects.Deployments.List");
  const project = loadProject(context, caller, input.scriptId, false);
  const limit = pageSize(context, input.pageSize, 1, 200, 50);
  const rows = [];
  for (const entry of scanPrefix(context, "script-deployments", `${project.scriptId}:`)) {
    const row = context.state.get("deployments", entry.rowId.slice(entry.rowId.indexOf(":") + 1));
    if (row !== null) rows.push(row);
  }
  rows.sort((a, b) => b.createTimeUs - a.createTimeUs || (a.deploymentId < b.deploymentId ? -1 : 1));

  const scope = `deployments:${project.scriptId}`;
  const deployKey = (row) => [row.createTimeUs, row.deploymentId];
  const start = resumeIndex(context, input.pageToken, scope, rows, (row) => row.deploymentId, deployKey, [-1, 1]);
  const { entries, nextIndex } = fillPage(
    rows,
    start,
    limit,
    renderDeployment,
    () => outOfRange(context, "A single deployment is larger than the maximum response size for this simulation."),
  );
  const out = { deployments: entries };
  if (nextIndex < rows.length) out.nextPageToken = mintKeyedToken(scope, rows[nextIndex].deploymentId, deployKey(rows[nextIndex]));
  return out;
}
