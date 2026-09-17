// users.get-me: the calling Box user.
import { resolveCaller } from "../lib/access.mjs";
import { rejectAsUser } from "./common.mjs";
import { parseFields, select } from "../lib/render.mjs";
import { rfc3339 } from "../lib/util.mjs";

export function getMe(input, context) {
  const user = resolveCaller(context);
  rejectAsUser(context, input);
  const fields = parseFields(context, input.fields);
  return select({
    type: "user", id: user.id, name: user.name, login: user.login, created_at: rfc3339(user.createdAtUs), modified_at: rfc3339(user.modifiedAtUs),
    language: user.language, timezone: user.timezone, space_amount: user.spaceAmount, space_used: user.spaceUsed, max_upload_size: user.maxUploadSize,
    status: user.status, job_title: user.jobTitle, avatar_url: `https://app.box.com/api/avatar/large/${user.id}`,
    enterprise: { type: "enterprise", id: "700100", name: "Northwind Studio" }, role: user.role,
  }, fields);
}
