// Contact writes: PUT/POST /Contacts (batch create or update), POST /Contacts/{ContactID}, MCP create-contact and update-contact.
import { elementsOf, failElements, open } from "./access.mjs";
import { contactElement, mergeContact, storeContact } from "./contact-rules.mjs";
import { contactFlags, renderContact } from "./views-docs.mjs";
import { hasOwn, normalGuid, own } from "./util.mjs";

function keyCheck(s, input) {
  if (input.idempotencyKeyProblem === true) s.validation("Idempotency-Key must be at most 128 characters");
}

export const contactWriteOperations = {
  "contacts.save": (input, context) => {
    const s = open(context, input, "contacts", "write");
    keyCheck(s, input);
    const elements = elementsOf(s, input, "Contacts");
    let pathId = null;
    if (input.pathContactId !== undefined) {
      pathId = normalGuid(input.pathContactId);
      if (pathId === null || s.get("contacts", pathId) === null) s.notFound();
    }
    const summarize = input.summarizeErrors !== false;
    const results = [];
    const failed = [];
    for (const element of elements) {
      const bodyId = hasOwn(element, "ContactID") && element.ContactID !== null ? normalGuid(element.ContactID) : null;
      const errors = [];
      if (hasOwn(element, "ContactID") && element.ContactID !== null && bodyId === null) errors.push("ContactID must be a GUID");
      if (pathId !== null && bodyId !== null && bodyId !== pathId) errors.push("ContactID in the body does not match the ContactID in the URL");
      const targetId = pathId ?? bodyId;
      let existing = null;
      if (targetId !== null && errors.length === 0) {
        existing = s.get("contacts", targetId);
        if (input.method === "PUT" && pathId === null && existing !== null) errors.push("A contact with this ContactID already exists; use POST to update it");
        else if (existing === null) s.notFound();
      }
      if (errors.length === 0) {
        const merged = mergeContact(s, element, existing);
        errors.push(...merged.errors);
        if (errors.length === 0) {
          results.push({ ok: true, contact: storeContact(s, merged.value, existing === null) });
          continue;
        }
      }
      const projection = { ...contactElement(element, existing), ValidationErrors: errors.map((Message) => ({ Message })) };
      failed.push(projection);
      results.push({ ok: false, projection });
    }
    if (failed.length > 0 && summarize) failElements(s, failed);
    const flags = contactFlags(s.rows("invoices"));
    const Contacts = results.map((result) => {
      if (!result.ok) return { ...result.projection, StatusAttributeString: "ERROR" };
      const rendered = renderContact(result.contact, { flags });
      return summarize ? rendered : { ...rendered, StatusAttributeString: "OK" };
    });
    return s.envelope({ Contacts });
  },
  "contacts.create": (input, context) => {
    const s = open(context, input, "contacts", "write");
    const element = { Name: input.name };
    if (input.email !== undefined) element.EmailAddress = input.email;
    if (input.phone !== undefined) element.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: input.phone }];
    const merged = mergeContact(s, element, null);
    if (merged.errors.length > 0) s.validation(merged.errors, contactElement(element, null));
    const stored = storeContact(s, merged.value, true);
    return renderContact(stored, { flags: contactFlags(s.rows("invoices")) });
  },
  "contacts.update": (input, context) => {
    const s = open(context, input, "contacts", "write");
    const id = normalGuid(input.contactId);
    const existing = id === null ? null : s.get("contacts", id);
    if (existing === null) s.notFound();
    const element = { Name: input.name };
    if (input.firstName !== undefined) element.FirstName = input.firstName;
    if (input.lastName !== undefined) element.LastName = input.lastName;
    if (input.email !== undefined) element.EmailAddress = input.email;
    if (input.phone !== undefined) {
      element.Phones = [...existing.Phones.filter((p) => p.PhoneType !== "DEFAULT"), { PhoneType: "DEFAULT", PhoneNumber: input.phone }];
    }
    if (input.address !== undefined) {
      const a = input.address;
      const street = { AddressType: "STREET", AddressLine1: own(a, "addressLine1") ?? null, AddressLine2: own(a, "addressLine2") ?? null, City: own(a, "city") ?? null, Region: own(a, "region") ?? null, PostalCode: own(a, "postalCode") ?? null, Country: own(a, "country") ?? null };
      element.Addresses = [...existing.Addresses.filter((x) => x.AddressType !== "STREET"), street];
    }
    const merged = mergeContact(s, element, existing);
    if (merged.errors.length > 0) s.validation(merged.errors, contactElement(element, existing));
    const stored = storeContact(s, merged.value, false);
    return renderContact(stored, { flags: contactFlags(s.rows("invoices")) });
  },
};
