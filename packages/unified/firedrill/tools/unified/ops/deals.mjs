// CRM deals: pipeline/stage validation against the connection's pipelines, probability defaulting and closed_at
// derivation when a deal enters or leaves a closed stage.
import { badRequest } from "../lib/errors.mjs";
import { idFilter, textFilter } from "../lib/query.mjs";
import { getRow, scanBound, scanConnection } from "../lib/store.mjs";
import { nowIso } from "../lib/time.mjs";
import { idArray, iso, num, shape, str, strArray } from "../lib/validate.mjs";
import { clip } from "../lib/util.mjs";
import { makeResource } from "./resource.mjs";

const DEAL_SPECS = {
  name: str(1000, { nullable: false, min: 1 }),
  description: str(20000),
  source: str(256),
  currency: str(3, { pattern: /^[A-Z]{3}$/ }),
  amount: num({ min: 0 }),
  probability: num({ min: 0, max: 100 }),
  closed_at: iso(),
  closing_at: iso(),
  lost_reason: str(1000),
  won_reason: str(1000),
  tags: strArray(100, 256),
  pipelines: shape("pipelineRefs"),
  stages: shape("pipelineRefs"),
  contact_ids: idArray(100),
  company_ids: idArray(100),
  user_id: str(256),
  metadata: shape("metadata"),
  raw: shape("raw"),
};

const defaults = () => ({
  name: "", description: null, source: null, currency: null, amount: null, probability: null, closed_at: null, closing_at: null,
  lost_reason: null, won_reason: null, tags: [], pipelines: [], stages: [], contact_ids: [], company_ids: [], user_id: null, metadata: [], raw: {},
});

const activeStages = (pipeline) => [...pipeline.stages].sort((a, b) => a.display_order - b.display_order);

/** Finds the pipeline owning a stage id across the connection (bounded scan of the small pipelines namespace). */
function pipelineOfStage(context, workspace, connectionId, stageId) {
  for (const pipeline of scanConnection(context, "pipelines", connectionId, scanBound(workspace))) {
    if (pipeline.stages.some((stage) => stage.id === stageId)) return pipeline;
  }
  return null;
}

/**
 * Resolves `pipelines`/`stages` references: a stage without a pipeline implies its owner; a pipeline without a stage
 * takes its first active stage; both must agree. Returns { pipelines, stages, stage } with names filled in.
 */
function resolveStage(context, workspace, connectionId, pipelines, stages) {
  if (pipelines.length === 0 && stages.length === 0) return { pipelines: [], stages: [], stage: null };
  let pipeline = null;
  if (pipelines.length > 0) {
    pipeline = getRow(context, "pipelines", connectionId, pipelines[0].id);
    if (pipeline === null) badRequest(context, `Unknown pipeline id ${clip(pipelines[0].id, 40)}`);
  } else {
    pipeline = pipelineOfStage(context, workspace, connectionId, stages[0].id);
    if (pipeline === null) badRequest(context, `Unknown stage id ${clip(stages[0].id, 40)}`);
  }
  let stage = null;
  if (stages.length > 0) {
    stage = pipeline.stages.find((entry) => entry.id === stages[0].id) ?? null;
    if (stage === null) badRequest(context, `Stage ${clip(stages[0].id, 40)} does not belong to pipeline ${pipeline.id}`);
  } else {
    stage = activeStages(pipeline).find((entry) => entry.active) ?? activeStages(pipeline)[0] ?? null;
  }
  return {
    pipelines: [{ id: pipeline.id, name: pipeline.name, type: null }],
    stages: stage === null ? [] : [{ id: stage.id, name: stage.name, type: null }],
    stage,
  };
}

function applyStage(context, row, resolved, previousStageId, bodyHasProbability) {
  row.pipelines = resolved.pipelines;
  row.stages = resolved.stages;
  const stage = resolved.stage;
  if (!bodyHasProbability && stage !== null) row.probability = stage.deal_probability;
  const stageId = stage === null ? null : stage.id;
  if (stageId !== previousStageId) {
    if (stage !== null && stage.is_closed) row.closed_at = row.closed_at ?? nowIso(context);
    else if (previousStageId !== null) row.closed_at = null;
  }
}

export const deals = makeResource({
  namespace: "deals",
  label: "Deal",
  category: "crm",
  permission: "crm_deal",
  objectType: "crm_deal",
  searchFields: ["name"],
  bodySpecs: DEAL_SPECS,
  defaults,
  filter(input, context) {
    const companyId = idFilter(input, context, "company_id");
    const contactId = idFilter(input, context, "contact_id");
    const pipelineId = idFilter(input, context, "pipeline_id");
    const userId = textFilter(input, context, "user_id");
    return (row) =>
      (companyId === null || row.company_ids.includes(companyId)) &&
      (contactId === null || row.contact_ids.includes(contactId)) &&
      (pipelineId === null || row.pipelines.some((entry) => entry.id === pipelineId)) &&
      (userId === null || row.user_id === userId);
  },
  prepareCreate(context, connection, fields, workspace) {
    if (typeof fields.name !== "string" || fields.name.length === 0) badRequest(context, "name is required");
    const row = { ...defaults(), ...fields };
    const resolved = resolveStage(context, workspace, connection.id, row.pipelines, row.stages);
    applyStage(context, row, resolved, null, Object.hasOwn(fields, "probability") && fields.probability !== null);
    return row;
  },
  prepareUpdate(context, connection, existing, fields, workspace) {
    const merged = { ...existing, ...fields };
    if (Object.hasOwn(fields, "pipelines") || Object.hasOwn(fields, "stages")) {
      const previousStageId = existing.stages[0]?.id ?? null;
      const resolved = resolveStage(context, workspace, connection.id, merged.pipelines, merged.stages);
      applyStage(context, merged, resolved, previousStageId, Object.hasOwn(fields, "probability") && fields.probability !== null);
    }
    return merged;
  },
});
