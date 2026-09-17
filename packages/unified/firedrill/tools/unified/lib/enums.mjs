// Connection enums as published in the provider's OpenAPI document (property_Connection_categories and the crm_/
// messaging_ values of property_Connection_permissions).
export const CATEGORIES = [
  "passthrough", "hris", "ats", "auth", "saml", "crm", "enrich", "martech", "ticketing", "uc", "accounting", "storage", "commerce",
  "payment", "genai", "messaging", "kms", "task", "scim", "lms", "repo", "metadata", "calendar", "verification", "ads", "analytics",
  "forms", "shipping", "assessment", "signing", "clubs", "datastore", "cdp", "performance", "social",
];

export const PERMISSIONS = [
  "crm_company_read", "crm_company_write", "crm_contact_read", "crm_contact_write", "crm_deal_read", "crm_deal_write",
  "crm_event_read", "crm_event_write", "crm_lead_read", "crm_lead_write", "crm_pipeline_read", "crm_pipeline_write",
  "crm_taxonomy_read", "messaging_message_read", "messaging_message_write", "messaging_channel_read", "messaging_channel_write",
  "messaging_event_read", "messaging_event_write",
];
