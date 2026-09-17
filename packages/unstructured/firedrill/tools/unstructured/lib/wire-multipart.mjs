// Decoders for the two multipart routes (`POST /general/v0/general`, `POST /api/v1/workflows/{id}/run`).
// The framework hands `text` bodies as strict UTF-8 strings, so only text documents can arrive here.
import { isMultipart, parseMultipart } from "./multipart.mjs";
import { base64Decode, clip, utf8Decode } from "./util.mjs";
import { RESERVED, headerOf } from "./wire.mjs";

const MAX_FILES = 32;
const LIST_FIELDS = new Set(["languages", "ocr_languages", "skip_infer_table_types", "extract_image_block_types"]);
const MAX_FIELDS = 64;

function fileOf(part) {
  const file = {
    filename: typeof part.filename === "string" ? clip(part.filename, 500) : "",
    content_type: part.contentType !== null && part.contentType !== "application/octet-stream" ? clip(part.contentType, 200) : null,
    content: part.body,
  };
  if (part.lastModified !== null) file.last_modified = clip(part.lastModified, 100);
  if (part.transferEncoding === "base64") {
    const bytes = base64Decode(part.body.replace(/[\r\n]/g, ""));
    const text = bytes === null ? null : utf8Decode(bytes);
    if (text === null) file.bad_transfer = true;
    else file.content = text;
  } else if (part.transferEncoding !== null && part.transferEncoding !== "binary" && part.transferEncoding !== "8bit" && part.transferEncoding !== "7bit") {
    file.bad_transfer = true;
  }
  return file;
}

/** Folds multipart parts into arguments: `fileField` parts -> array of files, other parts -> text or string-array fields. */
function foldParts(parts, fileField, refuse) {
  const args = {};
  const files = [];
  let fieldCount = 0;
  for (const part of parts) {
    if (part.name === fileField || part.name === `${fileField}[]`) {
      if (files.length >= MAX_FILES) return refuse(`422:loc=body.${fileField}: At most ${MAX_FILES} files per request`);
      files.push(fileOf(part));
      continue;
    }
    const name = part.name.endsWith("[]") ? part.name.slice(0, -2) : part.name;
    if (name.length === 0 || name === RESERVED || name === "__proto__" || name === "constructor" || name === "prototype") return refuse(`422:loc=body: Invalid form field name "${clip(part.name, 60)}"`);
    if (part.filename !== null) return refuse(`422:loc=body.${clip(name, 100)}: Unexpected file upload; only "${fileField}" parts may carry a file`);
    fieldCount += 1;
    if (fieldCount > MAX_FIELDS) return refuse("422:loc=body: Too many form fields");
    if (LIST_FIELDS.has(name)) {
      if (!Object.hasOwn(args, name)) args[name] = [];
      if (args[name].length < 64) args[name].push(part.body);
    } else if (!Object.hasOwn(args, name)) args[name] = part.body;
  }
  if (files.length > 0) args[fileField] = files;
  return args;
}

function multipartArgs(request, fileField, allowEmpty) {
  const refuse = (message) => ({ [RESERVED]: clip(message, 300) });
  const contentType = headerOf(request, "content-type");
  const body = request.body.kind === "text" ? request.body.value : request.body.kind === "form" ? "form" : "";
  if (request.body.kind === "json") return refuse("422:loc=body: Expected multipart/form-data");
  if (request.body.kind === "form") return refuse("422:loc=body: Expected multipart/form-data, not application/x-www-form-urlencoded");
  if (body.length === 0 && allowEmpty && (contentType === null || !isMultipart(contentType))) return {};
  if (!isMultipart(contentType)) return refuse("422:loc=body: Expected multipart/form-data");
  const parsed = parseMultipart(contentType, body);
  if (parsed.error !== undefined) return refuse(`400:${parsed.error}`);
  return foldParts(parsed.parts, fileField, refuse);
}

export function decodePartition(request) {
  return { arguments: multipartArgs(request, "files", false) };
}

export function decodeRun(request) {
  const args = { workflow_id: typeof request.path.workflow_id === "string" ? request.path.workflow_id : "" };
  Object.assign(args, multipartArgs(request, "input_files", true));
  const out = { arguments: args };
  const key = headerOf(request, "idempotency-key");
  if (typeof key === "string" && key.length > 0 && key.length <= 255) out.idempotencyKey = key;
  return out;
}
