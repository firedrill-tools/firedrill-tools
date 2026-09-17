// Synthetic Attio workspace (REST API v2 subset). Every operation computes from context.state: ids come from the
// `meta/counters` row, timestamps from virtual time, identity from the calling actor's attributes. Nothing here
// contacts Attio, and no e-mail, call or meeting is ever created or delivered.
import { guardRoutes } from "./lib/json-depth.mjs";
import { caller } from "./lib/access.mjs";
import { validation } from "./lib/common.mjs";
import { attributesList, entriesCreate, entriesDelete, entriesGet, entriesQuery, entriesUpdate, listsList, objectsList } from "./lib/lists.mjs";
import {
  notesCreate,
  notesDelete,
  notesGet,
  notesList,
  selfIdentify,
  tasksCreate,
  tasksDelete,
  tasksList,
  tasksUpdate,
  workspaceMembersList,
} from "./lib/notes-tasks.mjs";
import { selectOptionsList, statusesList } from "./lib/options.mjs";
import { recordsAssert, recordsCreate, recordsDelete, recordsGet, recordsQuery, recordsSearch, recordsUpdate } from "./lib/records.mjs";
import { defined, encodeResult, field, objectBody, operationInput, queryBoolean, queryInteger, queryValue } from "./lib/wire.mjs";

/**
 * Operations whose route carries a JSON body accept an optional `request_error` argument set by the decoder when the
 * body could not be mapped (for example a JSON array). The caller is authenticated first, then the request is refused
 * with Attio's validation error.
 */
function withBody(handler) {
  return (input, context) => {
    if (typeof input.request_error === "string") {
      caller(context);
      const text = input.request_error.trim();
      return validation(context, text.length > 0 ? text : "The request body could not be mapped to this endpoint.");
    }
    return handler(input, context);
  };
}

const encode = (result) => encodeResult(result);

function route(decode, strip) {
  return { decode, encode: strip === undefined ? encode : (result) => encodeResult(result, strip) };
}

function path(request, name) {
  return Object.hasOwn(request.path, name) && typeof request.path[name] === "string" ? request.path[name] : "";
}

/** Select-option and status routes: `/v2/{target}/{identifier}/attributes/{attribute}/(options|statuses)`. */
function attributeChildren(request, target) {
  return {
    arguments: defined({
      target,
      identifier: path(request, "identifier"),
      attribute: path(request, "attribute"),
      show_archived: queryBoolean(request.query, "show_archived"),
    }),
  };
}

/** `{ data: ... }` bodies (create/update/assert routes). */
function dataBody(request, members) {
  const body = objectBody(request);
  return operationInput(request, defined({ ...members, data: field(body.value, "data"), request_error: body.error }));
}

export default {
  operations: {
    "self.identify": selfIdentify,
    "objects.list": objectsList,
    "attributes.list": attributesList,
    "select-options.list": selectOptionsList,
    "statuses.list": statusesList,
    "records.query": withBody(recordsQuery),
    "records.get": recordsGet,
    "records.create": withBody(recordsCreate),
    "records.assert": withBody(recordsAssert),
    "records.update": withBody(recordsUpdate),
    "records.delete": recordsDelete,
    "records.search": withBody(recordsSearch),
    "lists.list": listsList,
    "entries.query": withBody(entriesQuery),
    "entries.create": withBody(entriesCreate),
    "entries.get": entriesGet,
    "entries.update": withBody(entriesUpdate),
    "entries.delete": entriesDelete,
    "notes.list": notesList,
    "notes.get": notesGet,
    "notes.create": withBody(notesCreate),
    "notes.delete": notesDelete,
    "tasks.list": tasksList,
    "tasks.create": withBody(tasksCreate),
    "tasks.update": withBody(tasksUpdate),
    "tasks.delete": tasksDelete,
    "workspace-members.list": workspaceMembersList,
  },
  http: guardRoutes({
    identify: route(() => ({ arguments: {} }), ["server_time"]),
    "list-objects": route(() => ({ arguments: {} })),
    "list-object-attributes": route((request) => ({
      arguments: defined({
        target: "objects",
        identifier: path(request, "identifier"),
        limit: queryInteger(request.query, "limit"),
        offset: queryInteger(request.query, "offset"),
        show_archived: queryBoolean(request.query, "show_archived"),
      }),
    })),
    "list-list-attributes": route((request) => ({
      arguments: defined({
        target: "lists",
        identifier: path(request, "identifier"),
        limit: queryInteger(request.query, "limit"),
        offset: queryInteger(request.query, "offset"),
        show_archived: queryBoolean(request.query, "show_archived"),
      }),
    })),
    "list-object-attribute-options": route((request) => attributeChildren(request, "objects")),
    "list-list-attribute-options": route((request) => attributeChildren(request, "lists")),
    "list-object-attribute-statuses": route((request) => attributeChildren(request, "objects")),
    "list-list-attribute-statuses": route((request) => attributeChildren(request, "lists")),
    "query-records": route((request) => {
      const body = objectBody(request);
      return {
        arguments: defined({
          object: path(request, "object"),
          filter: field(body.value, "filter"),
          sorts: field(body.value, "sorts"),
          limit: field(body.value, "limit"),
          offset: field(body.value, "offset"),
          filter_view_id: field(body.value, "filter_view_id"),
          request_error: body.error,
        }),
      };
    }),
    "get-record": route((request) => ({ arguments: { object: path(request, "object"), record_id: path(request, "record_id") } })),
    "create-record": route((request) => dataBody(request, { object: path(request, "object") })),
    "assert-record": route((request) =>
      dataBody(request, { object: path(request, "object"), matching_attribute: queryValue(request.query, "matching_attribute") ?? "" }),
    ),
    "update-record-append": route((request) =>
      dataBody(request, { object: path(request, "object"), record_id: path(request, "record_id"), mode: "append" }),
    ),
    "update-record-overwrite": route((request) =>
      dataBody(request, { object: path(request, "object"), record_id: path(request, "record_id"), mode: "overwrite" }),
    ),
    "delete-record": route((request) =>
      operationInput(request, { object: path(request, "object"), record_id: path(request, "record_id") }),
    ),
    "search-records": route((request) => {
      const body = objectBody(request);
      return {
        arguments: defined({
          query: field(body.value, "query"),
          objects: field(body.value, "objects"),
          request_as: field(body.value, "request_as"),
          limit: field(body.value, "limit"),
          request_error: body.error,
        }),
      };
    }),
    "list-lists": route(() => ({ arguments: {} })),
    "query-entries": route((request) => {
      const body = objectBody(request);
      return {
        arguments: defined({
          list: path(request, "list"),
          filter: field(body.value, "filter"),
          sorts: field(body.value, "sorts"),
          limit: field(body.value, "limit"),
          offset: field(body.value, "offset"),
          request_error: body.error,
        }),
      };
    }),
    "create-entry": route((request) => dataBody(request, { list: path(request, "list") })),
    "get-entry": route((request) => ({ arguments: { list: path(request, "list"), entry_id: path(request, "entry_id") } })),
    "update-entry-append": route((request) =>
      dataBody(request, { list: path(request, "list"), entry_id: path(request, "entry_id"), mode: "append" }),
    ),
    "update-entry-overwrite": route((request) =>
      dataBody(request, { list: path(request, "list"), entry_id: path(request, "entry_id"), mode: "overwrite" }),
    ),
    "delete-entry": route((request) => operationInput(request, { list: path(request, "list"), entry_id: path(request, "entry_id") })),
    "list-notes": route((request) => ({
      arguments: defined({
        limit: queryInteger(request.query, "limit"),
        offset: queryInteger(request.query, "offset"),
        parent_object: queryValue(request.query, "parent_object"),
        parent_record_id: queryValue(request.query, "parent_record_id"),
      }),
    })),
    "get-note": route((request) => ({ arguments: { note_id: path(request, "note_id") } })),
    "create-note": route((request) => dataBody(request, {})),
    "delete-note": route((request) => operationInput(request, { note_id: path(request, "note_id") })),
    "list-tasks": route((request) => ({
      arguments: defined({
        limit: queryInteger(request.query, "limit"),
        offset: queryInteger(request.query, "offset"),
        sort: queryValue(request.query, "sort"),
        linked_object: queryValue(request.query, "linked_object"),
        linked_record_id: queryValue(request.query, "linked_record_id"),
        assignee: queryValue(request.query, "assignee"),
        is_completed: queryBoolean(request.query, "is_completed"),
      }),
    })),
    "create-task": route((request) => dataBody(request, {})),
    "update-task": route((request) => dataBody(request, { task_id: path(request, "task_id") })),
    "delete-task": route((request) => operationInput(request, { task_id: path(request, "task_id") })),
    "list-workspace-members": route(() => ({ arguments: {} })),
  }),
};
