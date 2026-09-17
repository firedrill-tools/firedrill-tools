// Renders stored rows into the provider's resource shapes. Every value is computed from state.
import { etagFor } from "./names.mjs";
import { durationString, rfc3339 } from "./util.mjs";

const PEOPLE_SOURCE = (contact) => ({
  type: "CONTACT",
  id: contact.contactId.slice(1),
  etag: etagFor("contact", contact.contactId, contact.etagVersion),
  updateTime: rfc3339(contact.updateTimeUs),
});

const withMetadata = (person, sources, wanted) => {
  if (wanted.has("metadata")) person.metadata = { sources, objectType: "PERSON" };
  return person;
};

/** A private contact rendered under a personFields mask. */
export function renderContact(contact, wanted) {
  const resourceName = `people/${contact.contactId}`;
  const etag = etagFor("contact", contact.contactId, contact.etagVersion);
  const source = PEOPLE_SOURCE(contact);
  const meta = (primary) => ({ primary: primary === true, source: { type: "CONTACT", id: source.id } });
  const person = { resourceName, etag };
  withMetadata(person, [source], wanted);
  if (wanted.has("names") && contact.names.length > 0) {
    person.names = contact.names.map((name) => ({
      metadata: meta(true),
      displayName: name.displayName,
      familyName: name.familyName,
      givenName: name.givenName,
      ...(name.middleName === null || name.middleName === undefined ? {} : { middleName: name.middleName }),
      displayNameLastFirst: name.familyName ? `${name.familyName}, ${name.givenName ?? ""}`.trim() : name.displayName,
      unstructuredName: name.unstructuredName,
    }));
  }
  if (wanted.has("nicknames") && contact.nicknames.length > 0) {
    person.nicknames = contact.nicknames.map((value) => ({ metadata: meta(false), value }));
  }
  if (wanted.has("emailAddresses") && contact.emailAddresses.length > 0) {
    person.emailAddresses = contact.emailAddresses.map((entry) => ({
      metadata: meta(entry.primary),
      value: entry.value,
      type: entry.type,
      formattedType: formatType(entry.type),
      ...(entry.displayName === null || entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    }));
  }
  if (wanted.has("phoneNumbers") && contact.phoneNumbers.length > 0) {
    person.phoneNumbers = contact.phoneNumbers.map((entry) => ({
      metadata: meta(entry.primary),
      value: entry.value,
      ...(entry.canonicalForm === null || entry.canonicalForm === undefined ? {} : { canonicalForm: entry.canonicalForm }),
      type: entry.type,
      formattedType: formatType(entry.type),
    }));
  }
  if (wanted.has("organizations") && contact.organizations.length > 0) {
    person.organizations = contact.organizations.map((entry) => ({
      metadata: meta(entry.current === true),
      name: entry.name,
      ...(entry.title === null || entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.department === null || entry.department === undefined ? {} : { department: entry.department }),
      current: entry.current === true,
    }));
  }
  if (wanted.has("addresses") && contact.addresses.length > 0) {
    person.addresses = contact.addresses.map((entry) => ({
      metadata: meta(false),
      formattedValue: entry.formattedValue,
      type: entry.type,
      formattedType: formatType(entry.type),
      ...(entry.city === null || entry.city === undefined ? {} : { city: entry.city }),
      ...(entry.region === null || entry.region === undefined ? {} : { region: entry.region }),
      ...(entry.postalCode === null || entry.postalCode === undefined ? {} : { postalCode: entry.postalCode }),
      ...(entry.country === null || entry.country === undefined ? {} : { country: entry.country }),
    }));
  }
  if (wanted.has("biographies") && typeof contact.biography === "string" && contact.biography.length > 0) {
    person.biographies = [{ metadata: meta(true), value: contact.biography, contentType: "TEXT_PLAIN" }];
  }
  if (wanted.has("birthdays") && contact.birthday !== null && contact.birthday !== undefined) {
    const date = { month: contact.birthday.month, day: contact.birthday.day };
    if (typeof contact.birthday.year === "number") date.year = contact.birthday.year;
    person.birthdays = [{ metadata: meta(true), date }];
  }
  if (wanted.has("urls") && contact.urls.length > 0) {
    person.urls = contact.urls.map((entry) => ({ metadata: meta(false), value: entry.value, type: entry.type, formattedType: formatType(entry.type) }));
  }
  if (wanted.has("userDefined") && contact.userDefined.length > 0) {
    person.userDefined = contact.userDefined.map((entry) => ({ metadata: meta(false), key: entry.key, value: entry.value }));
  }
  if (wanted.has("memberships") && contact.memberships.length > 0) {
    person.memberships = contact.memberships.map((groupId) => ({
      metadata: meta(false),
      contactGroupMembership: { contactGroupId: groupId, contactGroupResourceName: `contactGroups/${groupId}` },
    }));
  }
  if (wanted.has("photos") && typeof contact.photoUrl === "string" && contact.photoUrl.length > 0) {
    person.photos = [{ metadata: meta(true), url: contact.photoUrl, default: false }];
  }
  return person;
}

const TYPE_LABELS = new Map([
  ["home", "Home"], ["work", "Work"], ["mobile", "Mobile"], ["other", "Other"], ["main", "Main"],
  ["homeFax", "Home Fax"], ["workFax", "Work Fax"], ["blog", "Blog"], ["profile", "Profile"], ["ftp", "FTP"],
]);
const formatType = (type) => (typeof type === "string" ? TYPE_LABELS.get(type) ?? type.charAt(0).toUpperCase() + type.slice(1) : undefined);

/** A colleague's domain profile: only the fields a directory record carries. */
export function renderProfile(user, wanted, isSelf) {
  const etag = etagFor("profile", user.id, 1);
  const person = { resourceName: `people/${user.id}`, etag };
  const source = { type: isSelf ? "PROFILE" : "DOMAIN_PROFILE", id: user.id.slice(-16), etag, updateTime: rfc3339(user.createTimeUs) };
  if (wanted.has("metadata")) {
    person.metadata = { sources: [source], objectType: "PERSON" };
    if (isSelf) person.metadata.sources[0].profileMetadata = { objectType: "PERSON", userTypes: ["GOOGLE_USER", "GOOGLE_APPS_USER"] };
  }
  const meta = { primary: true, source: { type: source.type, id: source.id } };
  if (wanted.has("names")) {
    person.names = [{
      metadata: meta,
      displayName: user.displayName,
      familyName: user.familyName,
      givenName: user.givenName,
      displayNameLastFirst: `${user.familyName}, ${user.givenName}`,
      unstructuredName: user.displayName,
    }];
  }
  if (wanted.has("emailAddresses")) {
    person.emailAddresses = [{ metadata: meta, value: user.primaryEmail, type: "work", formattedType: "Work" }];
  }
  if (wanted.has("organizations")) {
    person.organizations = [{
      metadata: meta,
      name: user.domain,
      title: user.jobTitle,
      department: user.department,
      current: true,
      type: "work",
      formattedType: "Work",
    }];
  }
  if (wanted.has("photos")) person.photos = [{ metadata: meta, url: user.photoUrl, default: false }];
  return person;
}

/** An "other contact": read-only, and only four mask entries can populate it. */
export function renderOtherContact(row, wanted) {
  const etag = etagFor("otherContact", row.otherContactId, 1);
  const source = { type: "OTHER_CONTACT", id: row.otherContactId.slice(1, 17), etag, updateTime: rfc3339(row.updateTimeUs) };
  const person = { resourceName: `otherContacts/${row.otherContactId}`, etag };
  if (wanted.has("metadata")) person.metadata = { sources: [source], objectType: "PERSON" };
  const meta = (primary) => ({ primary, source: { type: "OTHER_CONTACT", id: source.id } });
  if (wanted.has("names") && typeof row.displayName === "string" && row.displayName.length > 0) {
    person.names = [{ metadata: meta(true), displayName: row.displayName, unstructuredName: row.displayName }];
  }
  if (wanted.has("emailAddresses") && row.emailAddresses.length > 0) {
    person.emailAddresses = row.emailAddresses.map((entry, index) => ({
      metadata: meta(index === 0),
      value: entry.value,
      type: entry.type,
      formattedType: formatType(entry.type),
    }));
  }
  if (wanted.has("phoneNumbers") && row.phoneNumbers.length > 0) {
    person.phoneNumbers = row.phoneNumbers.map((entry, index) => ({ metadata: meta(index === 0), value: entry.value, type: entry.type }));
  }
  return person;
}

export function renderGroup(group, wanted, memberResourceNames) {
  const out = {
    resourceName: `contactGroups/${group.groupId}`,
    etag: etagFor("group", group.groupId, group.etagVersion),
  };
  if (wanted.has("metadata")) out.metadata = { updateTime: rfc3339(group.updateTimeUs) };
  if (wanted.has("groupType")) out.groupType = group.groupType;
  if (wanted.has("name")) {
    out.name = group.name;
    out.formattedName = group.formattedName;
  }
  out.memberCount = group.memberCount;
  if (memberResourceNames !== undefined) out.memberResourceNames = memberResourceNames;
  return out;
}

export function renderSubscription(row) {
  const out = {
    name: `subscriptions/${row.subscriptionId}`,
    uid: row.uid,
    targetResource: row.targetResource,
    eventTypes: [...row.eventTypes],
    notificationEndpoint: { pubsubTopic: row.notificationEndpoint.pubsubTopic },
    state: row.state,
    authority: row.authority,
    createTime: rfc3339(row.createTimeUs),
    updateTime: rfc3339(row.updateTimeUs),
    reconciling: row.reconciling === true,
    etag: etagFor("subscription", row.subscriptionId, row.etagVersion),
  };
  if (row.payloadOptions !== null && row.payloadOptions !== undefined) {
    out.payloadOptions = { includeResource: row.payloadOptions.includeResource === true };
    if (typeof row.payloadOptions.fieldMask === "string" && row.payloadOptions.fieldMask.length > 0) {
      out.payloadOptions.fieldMask = row.payloadOptions.fieldMask;
    }
  }
  if (typeof row.suspensionReason === "string" && row.suspensionReason.length > 0) out.suspensionReason = row.suspensionReason;
  if (typeof row.expireTimeUs === "number") out.expireTime = rfc3339(row.expireTimeUs);
  return out;
}

const SUBSCRIPTION_TYPE = "type.googleapis.com/google.apps.events.subscriptions.v1.Subscription";

/** The google.longrunning.Operation envelope every Workspace Events mutation returns. */
export function renderOperation(row, subscriptionRow) {
  const out = {
    name: `operations/${row.operationId}`,
    metadata: { "@type": row.metadataType },
    done: row.done === true,
  };
  if (row.resultKind === "subscription" && subscriptionRow !== null && subscriptionRow !== undefined) {
    out.response = { "@type": SUBSCRIPTION_TYPE, ...renderSubscription(subscriptionRow) };
  } else if (row.resultKind === "empty") {
    out.response = { "@type": "type.googleapis.com/google.protobuf.Empty" };
  } else if (row.resultKind === "error") {
    out.error = { code: 13, message: row.errorMessage ?? "Internal error encountered.", status: row.errorCode ?? "INTERNAL" };
  } else {
    out.response = { "@type": "type.googleapis.com/google.protobuf.Empty" };
  }
  return out;
}

const userRef = (user) =>
  user === undefined || user === null
    ? { domain: "", email: "", name: "", photoUrl: "" }
    : { domain: user.domain, email: user.primaryEmail, name: user.displayName, photoUrl: user.photoUrl };

export function renderProject(project, users) {
  const out = {
    scriptId: project.scriptId,
    title: project.title,
    createTime: rfc3339(project.createTimeUs),
    updateTime: rfc3339(project.updateTimeUs),
    creator: userRef(users.get(project.creatorUserId)),
    lastModifyUser: userRef(users.get(project.lastModifyUserId)),
    owner: userRef(users.get(project.ownerUserId)),
  };
  if (typeof project.parentId === "string" && project.parentId.length > 0) out.parentId = project.parentId;
  return out;
}

export function renderContent(scriptId, content, users) {
  return {
    scriptId,
    files: content.files.map((file) => ({
      name: file.name,
      type: file.type,
      source: file.source,
      createTime: rfc3339(file.createTimeUs),
      updateTime: rfc3339(file.updateTimeUs),
      lastModifyUser: userRef(users.get(file.lastModifyUserId)),
      functionSet: { values: file.functionNames.map((name) => ({ name })) },
    })),
  };
}

export function renderVersion(version) {
  return {
    scriptId: version.scriptId,
    versionNumber: version.versionNumber,
    description: version.description,
    createTime: rfc3339(version.createTimeUs),
  };
}

export function renderDeployment(row) {
  const config = { scriptId: row.scriptId, manifestFileName: row.manifestFileName, description: row.description };
  if (typeof row.versionNumber === "number") config.versionNumber = row.versionNumber;
  const entryPoint = { entryPointType: row.entryPointType };
  if (row.entryPointType === "WEB_APP") {
    entryPoint.webApp = {
      url: `https://script.google.com/macros/s/${row.deploymentId}/exec`,
      entryPointConfig: { access: row.webAppAccess, executeAs: row.webAppExecuteAs },
    };
  } else if (row.entryPointType === "EXECUTION_API") {
    entryPoint.executionApi = { entryPointConfig: { access: row.webAppAccess } };
  } else {
    entryPoint.addOn = { addOnType: "GENERIC", title: row.description };
  }
  return { deploymentId: row.deploymentId, deploymentConfig: config, updateTime: rfc3339(row.updateTimeUs), entryPoints: [entryPoint] };
}

export function renderProcess(row) {
  return {
    projectName: row.projectName,
    functionName: row.functionName,
    processType: row.processType,
    processStatus: row.processStatus,
    userAccessLevel: row.userAccessLevel,
    startTime: rfc3339(row.startTimeUs),
    duration: durationString(row.durationUs),
    runtimeVersion: row.runtimeVersion,
  };
}
