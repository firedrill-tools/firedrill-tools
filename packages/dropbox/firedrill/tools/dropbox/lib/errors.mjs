// Declared failures with Dropbox's nested error unions. Handlers build the union (only they know the route); the HTTP
// codec copies `details` verbatim. `error_summary` is the tag chain followed by Dropbox's "/..." padding.

function summaryOf(union) {
  const tags = [];
  let node = union;
  for (let guard = 0; guard < 8 && node !== null && typeof node === "object"; guard += 1) {
    const tag = node[".tag"];
    if (typeof tag !== "string") {
      if (node.reason !== undefined) {
        node = node.reason;
        continue;
      }
      break;
    }
    tags.push(tag);
    node = Object.hasOwn(node, tag) ? node[tag] : undefined;
  }
  return `${tags.join("/")}/...`;
}

/** Fails with a 409-style Dropbox union: `fail409(ctx, "NOT_FOUND", "path", {".tag":"not_found"})`. */
export function failUnion(context, code, union, message) {
  context.fail({ code, message: message ?? summaryOf(union), details: { error_summary: summaryOf(union), error: union } });
}

/** Wraps an inner tag under a route field: `wrap("path", "not_found")` → `{".tag":"path","path":{".tag":"not_found"}}`. */
export function wrap(field, inner) {
  const value = typeof inner === "string" ? { ".tag": inner } : inner;
  return { ".tag": field, [field]: value };
}

/** LookupError / WriteError code for a tag. */
export const LOOKUP_CODES = {
  malformed_path: "MALFORMED_PATH",
  not_found: "NOT_FOUND",
  not_file: "NOT_FILE",
  not_folder: "NOT_FOLDER",
};

export function lookupFail(context, field, tag) {
  failUnion(context, LOOKUP_CODES[tag], wrap(field, tag));
}

/** WriteError conflict: `kind` is file, folder or file_ancestor. */
export function conflictUnion(kind) {
  return { ".tag": "conflict", conflict: { ".tag": kind } };
}

/** 400 plain-text failures (Dropbox answers these with a text body). */
export function failText(context, code, message) {
  context.fail({ code, message });
}

export function tooManyFiles(context, what, bound) {
  failUnion(context, "TOO_MANY_FILES", { ".tag": "too_many_files" }, `too_many_files: ${what} exceeds the supported bound of ${bound} rows`);
}
