// Validation of post fields shared by create and partial update.
import { blank, invalidValue, tooLong } from "./errors.mjs";
import { templateHashtags } from "./text.mjs";

export const MAX_COMMENTARY = 3000;
export const VISIBILITIES = new Set(["PUBLIC", "CONNECTIONS", "LOGGED_IN"]);
export const FEED_DISTRIBUTIONS = new Set(["MAIN_FEED", "NONE"]);

/** Returns templated commentary ("" when absent). Blank checks are the caller's (they depend on article/reshare). */
export function commentaryArg(context, value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return invalidValue(context, "commentary", value);
  if (value.length > MAX_COMMENTARY) return tooLong(context, "commentary", value.length, MAX_COMMENTARY);
  const templated = templateHashtags(value);
  if (templated.length > MAX_COMMENTARY) return tooLong(context, "commentary", templated.length, MAX_COMMENTARY);
  return value.trim() === "" ? "" : templated;
}

/** Validates `content`; only `content.article` is simulated. Returns the stored article or null. */
export function contentArg(context, content) {
  if (content === undefined || content === null) return null;
  if (typeof content !== "object" || Array.isArray(content)) return invalidValue(context, "content", content);
  for (const key of Object.keys(content)) {
    if (key !== "article") return invalidValue(context, `content/${key}`, "an unsupported content type");
  }
  const article = content.article;
  if (article === undefined) return invalidValue(context, "content", content);
  if (article === null || typeof article !== "object" || Array.isArray(article)) return invalidValue(context, "content/article", article);
  const { source, title, description } = article;
  if (typeof source !== "string" || !/^https:\/\/[^\s/]+/.test(source)) return invalidValue(context, "content/article/source", source);
  if (source.length > 2000) return tooLong(context, "content/article/source", source.length, 2000);
  if (typeof title !== "string" || title.trim() === "") return blank(context, "content/article/title");
  if (title.length > 400) return tooLong(context, "content/article/title", title.length, 400);
  if (description !== undefined && description !== null && typeof description !== "string") {
    return invalidValue(context, "content/article/description", description);
  }
  if (typeof description === "string" && description.length > 4000) {
    return tooLong(context, "content/article/description", description.length, 4000);
  }
  return { source, title, description: typeof description === "string" && description !== "" ? description : null };
}

/** Compares two 1–19 digit decimal id strings numerically. */
export function compareIds(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
