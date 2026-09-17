// Connector vocabulary: the source and destination connector types of the Workflow Endpoint, the configuration key
// each type needs for a successful connection check, and the secret keys masked in every response.

export const SOURCE_TYPES = [
  "azure", "confluence", "couchbase", "databricks_volumes", "dropbox", "elasticsearch", "gcs", "google_drive", "jira", "kafka_cloud",
  "mongodb", "onedrive", "outlook", "postgres", "s3", "salesforce", "sharepoint", "slack", "snowflake", "zendesk", "box", "notion",
];

export const DESTINATION_TYPES = [
  "astradb", "azure_ai_search", "couchbase", "databricks_volumes", "databricks_volume_delta_tables", "delta_table", "elasticsearch", "gcs",
  "kafka_cloud", "milvus", "mongodb", "motherduck", "neo4j", "onedrive", "pinecone", "postgres", "redis", "qdrant_cloud", "s3", "snowflake",
  "weaviate_cloud", "ibm_watsonx_s3", "duckdb",
];

/** First required configuration key per type (a non-empty string makes the connection check succeed). */
const REQUIRED = new Map([
  ["azure", ["remote_url"]], ["confluence", ["url"]], ["couchbase", ["connection_string", "bucket"]], ["databricks_volumes", ["host", "catalog", "volume"]],
  ["dropbox", ["remote_url"]], ["elasticsearch", ["hosts", "index_name"]], ["gcs", ["remote_url"]], ["google_drive", ["drive_id"]], ["jira", ["url"]],
  ["kafka_cloud", ["bootstrap_servers", "topic"]], ["mongodb", ["database", "collection"]], ["onedrive", ["client_id", "tenant", "user_pname"]],
  ["outlook", ["client_id", "tenant", "user_email"]], ["postgres", ["host", "database", "table_name"]], ["s3", ["remote_url"]], ["salesforce", ["username"]],
  ["sharepoint", ["site", "client_id", "tenant"]], ["slack", ["channels"]], ["snowflake", ["account", "database", "table_name"]], ["zendesk", ["subdomain"]],
  ["box", ["remote_url"]], ["notion", []],
  ["astradb", ["collection_name"]], ["azure_ai_search", ["endpoint", "index"]], ["databricks_volume_delta_tables", ["server_hostname", "catalog"]],
  ["delta_table", ["table_uri"]], ["milvus", ["uri", "collection_name"]], ["motherduck", ["database"]], ["neo4j", ["uri", "database"]],
  ["pinecone", ["index_name"]], ["redis", ["host"]], ["qdrant_cloud", ["url", "collection_name"]], ["weaviate_cloud", ["cluster_url", "collection"]],
  ["ibm_watsonx_s3", ["iceberg_endpoint", "catalog"]], ["duckdb", ["database"]],
]);

export const requiredKeys = (type) => REQUIRED.get(type) ?? [];

const SECRET_KEYS = new Set(["secret_access_key", "token", "password", "client_secret", "private_key", "api_key", "access_token", "client_cred", "aws_secret_access_key"]);
export const MASK = "********";
export const isSecretKey = (key) => SECRET_KEYS.has(key);

/** Response shape of a connector row: `config` with secrets masked, internal fields removed. */
export function connectorView(row) {
  const config = {};
  for (const key of Object.keys(row.config)) config[key] = isSecretKey(key) ? MASK : row.config[key];
  return { id: row.id, name: row.name, type: row.type, config, created_at: row.created_at, updated_at: row.updated_at, key: row.key };
}

/** Validates a caller-supplied config object into a flat map of scalars; returns { config } or { issues: [[loc, msg]] }. */
export function normaliseConfig(value, loc) {
  const issues = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { issues: [[loc, "Input should be a valid dictionary"]] };
  const keys = Object.keys(value);
  if (keys.length > 40) return { issues: [[loc, "Configuration has more than 40 keys"]] };
  const config = {};
  for (const key of keys) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      issues.push([`${loc}.${key}`, "Invalid configuration key"]);
      continue;
    }
    if (key.length === 0 || key.length > 100 || !/^[A-Za-z0-9_.-]+$/.test(key)) {
      issues.push([`${loc}.${key.slice(0, 60)}`, "Configuration keys must match ^[A-Za-z0-9_.-]{1,100}$"]);
      continue;
    }
    const item = value[key];
    if (item === null || typeof item === "boolean") config[key] = item;
    else if (typeof item === "number" && Number.isFinite(item)) config[key] = item;
    else if (typeof item === "string") {
      if (item.length > 2000) issues.push([`${loc}.${key}`, "String should have at most 2000 characters"]);
      else config[key] = item;
    } else if (Array.isArray(item) && item.length <= 50 && item.every((x) => typeof x === "string" && x.length <= 500)) config[key] = item.join(",");
    else issues.push([`${loc}.${key}`, "Configuration values must be strings, numbers, booleans or null"]);
  }
  return issues.length > 0 ? { issues } : { config };
}
