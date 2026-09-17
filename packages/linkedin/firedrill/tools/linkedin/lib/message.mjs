// Comment message validation: text (≤ 1250 characters) and mention attributes.
import { blank, invalidValue, missing, tooLong } from "./errors.mjs";
import { parseUrn } from "./urn.mjs";

export const MAX_COMMENT = 1250;
const MAX_ATTRIBUTES = 50;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Returns `{ text, attributes }` in stored form (`{ start, length, person, organization }`). */
export function messageArg(context, message, field = "message") {
  if (message === undefined || message === null) return missing(context, field);
  if (!isObject(message)) return invalidValue(context, field, message);
  const text = message.text;
  if (text === undefined || text === null || (typeof text === "string" && text.trim() === "")) return blank(context, `${field}/text`);
  if (typeof text !== "string") return invalidValue(context, `${field}/text`, text);
  if (text.length > MAX_COMMENT) return tooLong(context, `${field}/text`, text.length, MAX_COMMENT);
  const raw = message.attributes ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTRIBUTES) return invalidValue(context, `${field}/attributes`, "more than 50 attributes");
  const attributes = [];
  for (let i = 0; i < raw.length; i += 1) {
    const where = `${field}/attributes/${i}`;
    const attribute = raw[i];
    if (!isObject(attribute)) return invalidValue(context, where, attribute);
    const { start, length, value } = attribute;
    if (!Number.isInteger(start) || start < 0 || !Number.isInteger(length) || length < 1 || start + length > text.length) {
      return invalidValue(context, `${where}/start`, `${start}+${length} outside the text`);
    }
    if (!isObject(value)) return invalidValue(context, `${where}/value`, value);
    const personUrn = isObject(value.person) ? value.person.person : undefined;
    const organizationUrn = isObject(value.organization) ? value.organization.organization : undefined;
    const person = parseUrn(personUrn);
    const organization = parseUrn(organizationUrn);
    if (person !== null && person.type === "person" && organizationUrn === undefined && context.state.get("people", person.id) !== null) {
      attributes.push({ start, length, person: person.id, organization: null });
    } else if (organization !== null && organization.type === "organization" && personUrn === undefined
      && context.state.get("organizations", organization.id) !== null) {
      attributes.push({ start, length, person: null, organization: Number(organization.id) });
    } else {
      return invalidValue(context, `${where}/value`, value);
    }
  }
  return { text, attributes };
}
