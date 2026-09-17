// Synthetic Unstructured account for Firedrill: the legacy Partition Endpoint (`POST /general/v0/general`) over a
// deterministic text partitioner, and the Workflow Endpoint subset (sources, destinations, workflows, jobs).
// Every operation computes from `context.state`; ids come from the seeded random source and `meta/counters`,
// timestamps from virtual time. No Unstructured service is contacted.
import { DESTINATION_TYPES, SOURCE_TYPES } from "./lib/connectors.mjs";
import { Q, decoder, encodeError, encoder } from "./lib/wire.mjs";
import { decodePartition, decodeRun } from "./lib/wire-multipart.mjs";
import { connectorOps } from "./ops/connectors.mjs";
import * as jobs from "./ops/jobs.mjs";
import { partition } from "./ops/partition.mjs";
import * as workflows from "./ops/workflows.mjs";

const sources = connectorOps({ namespace: "sources", idField: "source_id", types: SOURCE_TYPES, typeFilter: "source_type", label: "Source connector" });
const destinations = connectorOps({ namespace: "destinations", idField: "destination_id", types: DESTINATION_TYPES, typeFilter: "destination_type", label: "Destination connector" });

const CONNECTOR_FIELDS = ["name", "type", "config", "key"];
const WORKFLOW_FIELDS = ["name", "workflow_type", "source_id", "destination_id", "workflow_nodes", "schedule", "reprocess_all", "key", "template_id", "source_ids", "destination_ids", "skip_preflight"];
const WORKFLOW_UPDATE_FIELDS = [...WORKFLOW_FIELDS.filter((f) => f !== "key"), "status"];
const WORKFLOW_QUERY = { source_id: Q.str, destination_id: Q.str, status: Q.str, name: Q.str, page: Q.int, page_size: Q.int, sort_by: Q.str, sort_direction: Q.str, show_only_soft_deleted: Q.str, show_recommender_workflows: Q.str, dag_node_configuration_id: Q.str, created_since: Q.str, created_before: Q.str };

const API_VERSION = { "unstructured-api-version": "0.1.0-firedrill" };
const encodePartition = (result) => {
  if (result.outcome.status !== "ok") return { headers: API_VERSION, ...encodeError(result) };
  const value = result.outcome.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.csv === "string") return { headers: API_VERSION, body: { kind: "text", value: value.csv, contentType: "text/csv; charset=utf-8" } };
  return { headers: API_VERSION, body: { kind: "json", value } };
};

/** [operation id, handler, [route id, decode, encode?]...] */
const TABLE = [
  ["general.partition", partition, ["partition", decodePartition, encodePartition]],

  ["sources.list", sources.list, ["list-sources", decoder({ query: { source_type: Q.str }, idem: false })]],
  ["sources.create", sources.create, ["create-source", decoder({ body: "json", fields: CONNECTOR_FIELDS })]],
  ["sources.get", sources.get, ["get-source", decoder({ path: ["source_id"], idem: false })]],
  ["sources.update", sources.update, ["update-source", decoder({ path: ["source_id"], body: "json", fields: CONNECTOR_FIELDS })]],
  ["sources.delete", sources.remove, ["delete-source", decoder({ path: ["source_id"] })]],
  ["sources.check_connection", sources.checkConnection, ["create-source-connection-check", decoder({ path: ["source_id"] })]],
  ["sources.get_connection_check", sources.getConnectionCheck, ["get-source-connection-check", decoder({ path: ["source_id"], idem: false })]],

  ["destinations.list", destinations.list, ["list-destinations", decoder({ query: { destination_type: Q.str }, idem: false })]],
  ["destinations.create", destinations.create, ["create-destination", decoder({ body: "json", fields: CONNECTOR_FIELDS })]],
  ["destinations.get", destinations.get, ["get-destination", decoder({ path: ["destination_id"], idem: false })]],
  ["destinations.update", destinations.update, ["update-destination", decoder({ path: ["destination_id"], body: "json", fields: CONNECTOR_FIELDS })]],
  ["destinations.delete", destinations.remove, ["delete-destination", decoder({ path: ["destination_id"] })]],

  ["workflows.list", workflows.list, ["list-workflows", decoder({ query: WORKFLOW_QUERY, idem: false })]],
  ["workflows.create", workflows.create, ["create-workflow", decoder({ body: "json", fields: WORKFLOW_FIELDS })]],
  ["workflows.get", workflows.get, ["get-workflow", decoder({ path: ["workflow_id"], idem: false })]],
  ["workflows.update", workflows.update, ["update-workflow", decoder({ path: ["workflow_id"], body: "json", fields: WORKFLOW_UPDATE_FIELDS })]],
  ["workflows.delete", workflows.remove, ["delete-workflow", decoder({ path: ["workflow_id"] })]],
  ["workflows.run", workflows.run, ["run-workflow", decodeRun]],

  ["jobs.list", jobs.list, ["list-jobs", decoder({ query: { workflow_id: Q.str, status: Q.str, page: Q.int, page_size: Q.int }, idem: false })]],
  ["jobs.get", jobs.get, ["get-job", decoder({ path: ["job_id"], idem: false })]],
  ["jobs.cancel", jobs.cancel, ["cancel-job", decoder({ path: ["job_id"] })]],
  ["jobs.get_details", jobs.details, ["get-job-details", decoder({ path: ["job_id"], idem: false })]],
  ["jobs.get_failed_files", jobs.failedFiles, ["get-job-failed-files", decoder({ path: ["job_id"], idem: false })]],
  ["jobs.download_output", jobs.downloadOutput, ["download-job-output", decoder({ path: ["job_id"], query: { file_id: Q.str, node_id: Q.str }, idem: false })]],
];

const operations = {};
const http = {};
for (const [operationId, handler, ...routes] of TABLE) {
  operations[operationId] = handler;
  for (const [routeId, decode, encode] of routes) http[routeId] = { decode, encode: encode ?? encoder };
}

export default { operations, http };
