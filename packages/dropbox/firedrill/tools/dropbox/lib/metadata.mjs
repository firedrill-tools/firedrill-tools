// Dropbox `Metadata` unions serialised as the API does (".tag" discriminator, snake_case fields).
import { extensionOf } from "./paths.mjs";

export function fileMetadata(entry) {
  return {
    ".tag": "file",
    name: entry.name,
    id: entry.id,
    path_lower: entry.pathLower,
    path_display: entry.pathDisplay,
    client_modified: entry.clientModified,
    server_modified: entry.serverModified,
    rev: entry.rev,
    size: entry.size,
    is_downloadable: true,
    content_hash: entry.contentHash,
  };
}

/** A revision row rendered as the FileMetadata of that version. */
export function revisionMetadata(row) {
  return fileMetadata({ ...row, id: row.entryId });
}

export function folderMetadata(entry) {
  return { ".tag": "folder", name: entry.name, id: entry.id, path_lower: entry.pathLower, path_display: entry.pathDisplay };
}

export function deletedMetadata(entry) {
  return { ".tag": "deleted", name: entry.name, path_lower: entry.pathLower, path_display: entry.pathDisplay };
}

export function metadataOf(entry) {
  if (entry.deleted) return deletedMetadata(entry);
  return entry.tag === "file" ? fileMetadata(entry) : folderMetadata(entry);
}

const CATEGORY = new Map();
for (const [category, extensions] of Object.entries({
  image: ["jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "heic", "tif", "tiff", "ico"],
  document: ["txt", "md", "doc", "docx", "rtf", "odt", "pages", "html", "htm", "json", "xml", "log"],
  pdf: ["pdf"],
  spreadsheet: ["csv", "xls", "xlsx", "ods", "numbers", "tsv"],
  presentation: ["ppt", "pptx", "key", "odp"],
  audio: ["mp3", "wav", "aac", "flac", "m4a", "ogg"],
  video: ["mp4", "mov", "avi", "mkv", "webm", "m4v"],
  paper: ["paper"],
})) {
  for (const extension of extensions) CATEGORY.set(extension, category);
}

/** Search category of an entry (folders are "folder", unknown extensions "others"). */
export function categoryOf(entry) {
  if (entry.tag === "folder") return "folder";
  return CATEGORY.get(extensionOf(entry.name)) ?? "others";
}
