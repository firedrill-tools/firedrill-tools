// Synthetic Google Workspace developer APIs (People v1, Workspace Events v1, Apps Script v1) for Firedrill.
// Every operation computes from `context.state`: ids come from `meta/counters`, timestamps from virtual time,
// function sets and execution results from the stored sources. No Google service is contacted.
import { EVENTS_SERVICE, PEOPLE_SERVICE, Q, SCRIPT_SERVICE, decoder, jsonEncoder } from "./lib/wire.mjs";
import { createContact, deleteContact, updateContact } from "./ops/contacts-write.mjs";
import { createGroup, deleteGroup, getGroup, listGroups, modifyMembers } from "./ops/groups.mjs";
import { getContact, listConnections } from "./ops/people-read.mjs";
import { listProcesses, runScript } from "./ops/run.mjs";
import {
  createDeployment, createProject, createVersion, getContent, getProject, listDeployments, updateContent,
} from "./ops/script.mjs";
import { listOtherContacts, searchContacts } from "./ops/search.mjs";
import {
  createSubscription, deleteSubscription, getOperation, getSubscription, listSubscriptions, reactivateSubscription,
} from "./ops/subs.mjs";

const people = (method) => jsonEncoder(PEOPLE_SERVICE, `google.people.v1.${method}`);
const events = (method) => jsonEncoder(EVENTS_SERVICE, `google.apps.events.subscriptions.v1.${method}`);
const script = (method) => jsonEncoder(SCRIPT_SERVICE, `google.apps.script.v1.${method}`);

const PERSON_QUERY = { personFields: Q.str, "sources[]": Q.list };

// [operation id, handler, route id or null, decoder, encoder]
const TABLE = [
  ["people.get-contact", getContact, "people-get",
    decoder({ path: { person_id: { name: "resourceName", prefix: "people/" } }, query: PERSON_QUERY }), people("PeopleService.GetPerson")],
  ["people.list-connections", listConnections, "people-connections",
    decoder({
      path: { person_id: { name: "resourceName", prefix: "people/" } },
      query: { personFields: Q.str, pageSize: Q.int, pageToken: Q.str, sortOrder: Q.str, requestSyncToken: Q.bool, syncToken: Q.str },
    }),
    people("PeopleService.ListConnections")],
  ["people.create-contact", createContact, "people-create-contact",
    decoder({ custom: { param: "collection_method", method: "createContact", head: "people", notFoundArgs: { person: {} } }, query: { personFields: Q.str }, body: "json", bodyKey: "person" }),
    people("PeopleService.CreateContact")],
  ["people.update-contact", updateContact, "people-update-contact",
    decoder({
      custom: { param: "person_id", method: "updateContact", name: "resourceName", prefix: "people/", notFoundArgs: { resourceName: "people/me", updatePersonFields: "names", person: {} } },
      query: { updatePersonFields: Q.str, personFields: Q.str },
      body: "json",
      bodyKey: "person",
    }),
    people("PeopleService.UpdateContact")],
  ["people.delete-contact", deleteContact, "people-delete-contact",
    decoder({ custom: { param: "person_id", method: "deleteContact", name: "resourceName", prefix: "people/", notFoundArgs: { resourceName: "people/me" } } }),
    people("PeopleService.DeleteContact")],
  ["people.search-contacts", searchContacts, null, null, null],
  ["other-contacts.list", listOtherContacts, "other-contacts-list",
    decoder({ query: { readMask: Q.str, pageSize: Q.int, pageToken: Q.str } }), people("PeopleService.ListOtherContacts")],
  ["contact-groups.list", listGroups, "contact-groups-list",
    decoder({ query: { groupFields: Q.str, pageSize: Q.int, pageToken: Q.str, syncToken: Q.str } }),
    people("ContactGroupsService.ListContactGroups")],
  ["contact-groups.get", getGroup, "contact-groups-get",
    decoder({ path: { group_id: { name: "resourceName", prefix: "contactGroups/" } }, query: { maxMembers: Q.int, groupFields: Q.str } }),
    people("ContactGroupsService.GetContactGroup")],
  ["contact-groups.create", createGroup, null, null, null],
  ["contact-groups.delete", deleteGroup, "contact-groups-delete",
    decoder({ path: { group_id: { name: "resourceName", prefix: "contactGroups/" } }, query: { deleteContacts: Q.bool } }),
    people("ContactGroupsService.DeleteContactGroup")],
  ["contact-groups.modify-members", modifyMembers, "contact-group-members-modify",
    decoder({
      path: { group_id: { name: "resourceName", prefix: "contactGroups/" } },
      custom: { param: "members_method", method: "modify", head: "members", notFoundArgs: { resourceName: "contactGroups/myContacts" } },
      body: "json",
    }),
    people("ContactGroupsService.ModifyContactGroupMembers")],

  ["subscriptions.create", createSubscription, "subscriptions-create",
    decoder({ query: { validateOnly: Q.bool }, body: "json", bodyKey: "subscription" }), events("SubscriptionsService.CreateSubscription")],
  ["subscriptions.list", listSubscriptions, "subscriptions-list",
    decoder({ query: { filter: Q.str, pageSize: Q.int, pageToken: Q.str } }), events("SubscriptionsService.ListSubscriptions")],
  ["subscriptions.get", getSubscription, "subscriptions-get",
    decoder({ path: { subscription_id: { name: "name", prefix: "subscriptions/" } } }), events("SubscriptionsService.GetSubscription")],
  ["subscriptions.delete", deleteSubscription, "subscriptions-delete",
    decoder({ path: { subscription_id: { name: "name", prefix: "subscriptions/" } }, query: { validateOnly: Q.bool, allowMissing: Q.bool, etag: Q.str } }),
    events("SubscriptionsService.DeleteSubscription")],
  ["subscriptions.reactivate", reactivateSubscription, "subscriptions-reactivate",
    decoder({ custom: { param: "subscription_id", method: "reactivate", name: "name", prefix: "subscriptions/", notFoundArgs: { name: "subscriptions/unknown" } }, body: "json" }),
    events("SubscriptionsService.ReactivateSubscription")],
  ["operations.get", getOperation, "operations-get",
    decoder({ path: { operation_id: { name: "name", prefix: "operations/" } } }), events("SubscriptionsService.GetOperation")],

  ["script-projects.create", createProject, "script-projects-create", decoder({ body: "json" }), script("Projects.Create")],
  ["script-projects.get", getProject, "script-projects-get", decoder({ path: { script_id: "scriptId" } }), script("Projects.Get")],
  ["script-projects.get-content", getContent, "script-content-get",
    decoder({ path: { script_id: "scriptId" }, query: { versionNumber: Q.int } }), script("Projects.GetContent")],
  ["script-projects.update-content", updateContent, "script-content-update",
    decoder({ path: { script_id: "scriptId" }, body: "json" }), script("Projects.UpdateContent")],
  ["script-versions.create", createVersion, "script-versions-create",
    decoder({ path: { script_id: "scriptId" }, body: "json" }), script("Projects.Versions.Create")],
  ["deployments.create", createDeployment, "script-deployments-create",
    decoder({ path: { script_id: "scriptId" }, body: "json", bodyKey: "deploymentConfig" }), script("Projects.Deployments.Create")],
  ["deployments.list", listDeployments, "script-deployments-list",
    decoder({ path: { script_id: "scriptId" }, query: { pageSize: Q.int, pageToken: Q.str } }), script("Projects.Deployments.List")],
  ["scripts.run", runScript, "scripts-run",
    decoder({ custom: { param: "script_id", method: "run", name: "scriptId", notFoundArgs: { scriptId: "unknown", function: "unknown" } }, body: "json" }), script("Scripts.Run")],
  ["processes.list", listProcesses, "processes-list",
    decoder({
      query: {
        pageSize: Q.int,
        pageToken: Q.str,
        "userProcessFilter.scriptId": Q.str,
        "userProcessFilter.functionName": Q.str,
        "userProcessFilter.statuses[]": Q.list,
        "userProcessFilter.types[]": Q.list,
        "userProcessFilter.startTime": Q.str,
        "userProcessFilter.endTime": Q.str,
        "userProcessFilter.deploymentId": Q.str,
        "userProcessFilter.projectName": Q.str,
        "userProcessFilter.userAccessLevels[]": Q.list,
      },
      nest: { prefix: "userProcessFilter", name: "userProcessFilter" },
    }),
    script("Processes.ListUserProcesses")],
];

const operations = {};
const http = {};
for (const [operationId, handler, routeId, decode, encode] of TABLE) {
  operations[operationId] = handler;
  if (routeId !== null) http[routeId] = { decode, encode };
}

export default { operations, http };
