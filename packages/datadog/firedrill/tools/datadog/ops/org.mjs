// Canonical-only organization context for apps and agents: virtual clock, organization and calling user.
import { caller, isoMillis, nowSec, nowUs } from "../lib/core.mjs";

export function orgContext(_input, context) {
  const user = caller(context);
  const org = context.state.get("meta", "org");
  const canWrite = user.role !== "Datadog Read Only Role";
  return {
    now: isoMillis(nowUs(context)),
    now_sec: nowSec(context),
    org: { name: org?.name ?? "", public_id: org?.publicId ?? "" },
    user: { handle: user.handle, name: user.name, uuid: user.uuid, role: user.role },
    permissions: {
      monitors_write: canWrite, dashboards_write: canWrite, incidents_write: canWrite, events_write: canWrite, metrics_write: canWrite,
    },
  };
}
