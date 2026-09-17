// Synthetic Box Content API 2.0 subset for Firedrill. Every operation computes from `context.state`: ids come from
// `meta/counters`, timestamps from virtual time, SHA-1 digests from the stored bytes. No Box service is contacted.
import { Q, decoder, downloadEncoder, emptyEncoder, jsonEncoder, uploadDecoder } from "./lib/wire.mjs";
import { createCollaboration, deleteCollaboration, listFolderCollaborations } from "./ops/collabs.mjs";
import { createComment, listFileComments } from "./ops/comments.mjs";
import { copyFile, copyFolder } from "./ops/copy.mjs";
import { listEvents } from "./ops/events.mjs";
import { download, getFile, listVersions, restore } from "./ops/files-read.mjs";
import { getFolder, listItems } from "./ops/folders-read.mjs";
import { createFolder, deleteFile, deleteFolder, updateFile, updateFolder } from "./ops/items-write.mjs";
import { search } from "./ops/search.mjs";
import { uploadFile, uploadVersion } from "./ops/uploads.mjs";
import { getMe } from "./ops/users.mjs";

const page = { offset: Q.int, limit: Q.int };
const SEARCH_QUERY = {
  query: Q.str, type: Q.str, ancestor_folder_ids: Q.list, file_extensions: Q.list, content_types: Q.list, created_at_range: Q.str,
  updated_at_range: Q.str, owner_user_ids: Q.list, trash_content: Q.str, sort: Q.str, direction: Q.str, ...page, mdfilters: Q.str, scope: Q.str,
  include_recent_shared_links: Q.str, deleted_user_ids: Q.str, deleted_at_range: Q.str,
};

// [operation id, handler, route id, decoder, encoder]
const TABLE = [
  ["users.get-me", getMe, "get-users-me", decoder({}), jsonEncoder],
  ["folders.get", getFolder, "get-folder", decoder({ path: ["folder_id"], query: { sort: Q.str, direction: Q.str, ...page } }), jsonEncoder],
  ["folders.list-items", listItems, "list-folder-items",
    decoder({ path: ["folder_id"], query: { usemarker: Q.bool, marker: Q.str, sort: Q.str, direction: Q.str, ...page } }), jsonEncoder],
  ["folders.create", createFolder, "create-folder", decoder({ body: "json" }), jsonEncoder],
  ["folders.update", updateFolder, "update-folder", decoder({ path: ["folder_id"], ifMatch: true, body: "json" }), jsonEncoder],
  ["folders.delete", deleteFolder, "delete-folder", decoder({ path: ["folder_id"], ifMatch: true, query: { recursive: Q.bool } }), emptyEncoder],
  ["folders.copy", copyFolder, "copy-folder", decoder({ path: ["folder_id"], body: "json" }), jsonEncoder],
  ["files.get", getFile, "get-file", decoder({ path: ["file_id"] }), jsonEncoder],
  ["files.update", updateFile, "update-file", decoder({ path: ["file_id"], ifMatch: true, body: "json" }), jsonEncoder],
  ["files.delete", deleteFile, "delete-file", decoder({ path: ["file_id"], ifMatch: true }), emptyEncoder],
  ["files.copy", copyFile, "copy-file", decoder({ path: ["file_id"], body: "json" }), jsonEncoder],
  ["files.upload", uploadFile, "upload-file", uploadDecoder(false), jsonEncoder],
  ["files.upload-version", uploadVersion, "upload-file-version", uploadDecoder(true), jsonEncoder],
  ["files.download", download, "download-file", decoder({ path: ["file_id"], query: { version: Q.str } }), downloadEncoder],
  ["files.list-versions", listVersions, "list-file-versions", decoder({ path: ["file_id"], query: page }), jsonEncoder],
  ["files.restore", restore, "restore-file", decoder({ path: ["file_id"], body: "textjson" }), jsonEncoder],
  ["search.query", search, "search", decoder({ query: SEARCH_QUERY }), jsonEncoder],
  ["collaborations.create", createCollaboration, "create-collaboration", decoder({ query: { notify: Q.bool }, body: "json" }), jsonEncoder],
  ["collaborations.list-for-folder", listFolderCollaborations, "list-folder-collaborations",
    decoder({ path: ["folder_id"], query: { marker: Q.str, limit: Q.int } }), jsonEncoder],
  ["collaborations.delete", deleteCollaboration, "delete-collaboration", decoder({ path: ["collaboration_id"] }), emptyEncoder],
  ["comments.create", createComment, "create-comment", decoder({ body: "json" }), jsonEncoder],
  ["comments.list-for-file", listFileComments, "list-file-comments", decoder({ path: ["file_id"], query: page }), jsonEncoder],
  ["events.list", listEvents, "get-events", decoder({ query: { stream_type: Q.str, stream_position: Q.str, limit: Q.int, event_type: Q.str } }), jsonEncoder],
];

const operations = {};
const http = {};
for (const [operationId, handler, routeId, decode, encode] of TABLE) {
  operations[operationId] = handler;
  http[routeId] = { decode, encode };
}

export default { operations, http };
