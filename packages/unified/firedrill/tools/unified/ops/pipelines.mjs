// CRM pipelines: read-only reference data (list and get); stages are returned ordered by display_order.
import { makeResource } from "./resource.mjs";

const orderStages = (item) =>
  Array.isArray(item.stages) ? { ...item, stages: [...item.stages].sort((a, b) => a.display_order - b.display_order || (a.id < b.id ? -1 : 1)) } : item;

export const pipelines = makeResource({
  namespace: "pipelines",
  label: "Pipeline",
  category: "crm",
  permission: "crm_pipeline",
  objectType: "crm_pipeline",
  searchFields: ["name"],
  bodySpecs: {},
  defaults: () => ({}),
  filter: () => () => true,
  present: orderStages,
  prepareCreate: () => ({}),
  prepareUpdate: (context, connection, existing) => existing,
});
