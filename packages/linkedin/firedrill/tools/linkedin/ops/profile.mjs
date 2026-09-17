// profile.userinfo, profile.me and people.get.
import { caller, checkWire, requireScope } from "../lib/auth.mjs";
import { badRequest, fail, notFound } from "../lib/errors.mjs";
import { fullName, liteProfile } from "../lib/render.mjs";

const PERSON_ID = /^[A-Za-z0-9_-]{10}$/;

export function userinfo(input, context) {
  const who = caller(context);
  if (!who.scopes.has("openid") || !who.scopes.has("profile")) fail(context, "ACCESS_DENIED", "Not enough permissions to access: GET /userinfo");
  const person = who.person;
  return {
    sub: person.id,
    name: fullName(person),
    given_name: person.firstName,
    family_name: person.lastName,
    ...(person.pictureUrl === null ? {} : { picture: person.pictureUrl }),
    locale: `${person.locale.language}-${person.locale.country}`,
    ...(who.scopes.has("email") && person.email !== null ? { email: person.email, email_verified: person.emailVerified } : {}),
  };
}

export function me(input, context) {
  const who = caller(context);
  requireScope(context, who, ["profile"], "GET /me");
  return liteProfile(who.person);
}

export function getPerson(input, context) {
  const who = caller(context);
  checkWire(context, input, "GET", false);
  requireScope(context, who, ["profile"], "GET /people");
  const personId = input.personId;
  if (typeof personId !== "string" || !PERSON_ID.test(personId)) badRequest(context, "Syntax exception in path variables");
  const person = context.state.get("people", personId);
  if (person === null) notFound(context, `Member ${personId} not found`);
  return liteProfile(person);
}
