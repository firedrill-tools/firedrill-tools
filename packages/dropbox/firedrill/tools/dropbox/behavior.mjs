// Synthetic Dropbox (API v2 subset) for Firedrill. Every operation computes from `context.state`: entry ids, revs and
// link ids come from `meta/counters`, timestamps from the virtual clock, content hashes from the stored bytes. No
// Dropbox service is contacted and shared links are never served.
import { downloadBody, downloadDecode, encoder, nullBody, rpcDecode, uploadDecode, withoutServerTime } from "./lib/wire.mjs";
import { getCurrentAccount, getSpaceUsage } from "./ops/account.mjs";
import { getMetadata, download, listRevisions } from "./ops/read.mjs";
import { restore } from "./ops/history.mjs";
import { listFolder, listFolderContinue, listFolderGetLatestCursor } from "./ops/list.mjs";
import { copy, move } from "./ops/relocate.mjs";
import { search, searchContinue } from "./ops/search.mjs";
import { createSharedLink, listSharedLinks, revokeSharedLink } from "./ops/sharing.mjs";
import { createFolder, deleteEntry, upload } from "./ops/write.mjs";

// [operation id, handler, route id, Dropbox function name, decoder, success shaper]
const TABLE = [
  ["users.get-current-account", getCurrentAccount, "users-get-current-account", "users/get_current_account", rpcDecode, withoutServerTime],
  ["users.get-space-usage", getSpaceUsage, "users-get-space-usage", "users/get_space_usage", rpcDecode],
  ["files.list-folder", listFolder, "files-list-folder", "files/list_folder", rpcDecode],
  ["files.list-folder-continue", listFolderContinue, "files-list-folder-continue", "files/list_folder/continue", rpcDecode],
  ["files.list-folder-get-latest-cursor", listFolderGetLatestCursor, "files-list-folder-get-latest-cursor", "files/list_folder/get_latest_cursor", rpcDecode],
  ["files.get-metadata", getMetadata, "files-get-metadata", "files/get_metadata", rpcDecode],
  ["files.create-folder", createFolder, "files-create-folder-v2", "files/create_folder_v2", rpcDecode],
  ["files.upload", upload, "files-upload", "files/upload", uploadDecode],
  ["files.download", download, "files-download", "files/download", downloadDecode, downloadBody],
  ["files.delete", deleteEntry, "files-delete-v2", "files/delete_v2", rpcDecode],
  ["files.move", move, "files-move-v2", "files/move_v2", rpcDecode],
  ["files.copy", copy, "files-copy-v2", "files/copy_v2", rpcDecode],
  ["files.search", search, "files-search-v2", "files/search_v2", rpcDecode],
  ["files.search-continue", searchContinue, "files-search-continue-v2", "files/search/continue_v2", rpcDecode],
  ["files.list-revisions", listRevisions, "files-list-revisions", "files/list_revisions", rpcDecode],
  ["files.restore", restore, "files-restore", "files/restore", rpcDecode],
  ["sharing.create-shared-link-with-settings", createSharedLink, "sharing-create-shared-link-with-settings", "sharing/create_shared_link_with_settings", rpcDecode],
  ["sharing.list-shared-links", listSharedLinks, "sharing-list-shared-links", "sharing/list_shared_links", rpcDecode],
  ["sharing.revoke-shared-link", revokeSharedLink, "sharing-revoke-shared-link", "sharing/revoke_shared_link", rpcDecode, nullBody],
];

const operations = {};
const http = {};
for (const [operationId, handler, routeId, fn, decode, shape] of TABLE) {
  operations[operationId] = handler;
  http[routeId] = { decode, encode: encoder(fn, shape) };
}

export default { operations, http };
