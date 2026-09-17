// A bounded GraphQL subset: lexer, recursive-descent parser, variable coercion, named and inline
// fragments, @include/@skip, aliases, __typename, and an executor that projects a selection set
// against a type catalog of resolvers. No dependency on the `graphql` package; pure functions.
// Errors are thrown as GraphQLError { kind: "syntax" | "validation" | "not_implemented" } and
// mapped to declared Tool errors by the caller.
import { clipValue } from "./errors.mjs";

export class GraphQLError extends Error {
  constructor(kind, message, path) {
    super(message);
    this.name = "GraphQLError";
    this.kind = kind;
    this.path = path;
  }
}

const syntax = (message) => new GraphQLError("syntax", `Syntax Error: ${message}`);
const validation = (message, path) => new GraphQLError("validation", message, path);
const notImplemented = (message, path) => new GraphQLError("not_implemented", message, path);

export const MAX_DEPTH = 8;
export const MAX_NODES = 2000;
export const MAX_TOP_LEVEL_FIELDS = 100;
/** Parse-time bounds: nothing in the parser or the AST walks that follow it recurses deeper than these. */
export const MAX_LITERAL_DEPTH = 64;
export const MAX_TYPE_DEPTH = 32;
export const MAX_SELECTION_NESTING = 32;
/**
 * Fragment spreads and inline fragments expanded inside one another while collecting a selection set (a spread chain
 * `...A` → `...B` → … or inline fragments inside spread fragments). Field collection recurses once per level, so the
 * chain is bounded here rather than only by MAX_NODES.
 */
export const MAX_FRAGMENT_NESTING = 32;
/**
 * Fragment expansion budget per operation: field entries placed or merged while collecting selection sets, selection-set
 * references united when fields with one response key merge, and argument nodes compared for such merges. Spreads of an
 * already applied fragment add nothing and merged lists hold each AST selection set once, so legitimate documents stay far
 * below it; the budget bounds what remains (many distinct overlapping fields) before anything is allocated.
 */
export const MAX_EXPANDED_SELECTIONS = 200000;
/** Nesting bound for JSON variable values (objects and arrays), checked iteratively before any recursive use. */
export const MAX_VARIABLE_DEPTH = 64;
/** Resolved fields per operation (after list expansion); bounds fan-out such as nested connections of connections. */
export const MAX_RESOLVED_FIELDS = 50000;
/**
 * Encoded size budget for `data` (UTF-8 bytes of its JSON). The framework refuses HTTP route responses over 1 MiB after the
 * operation ran, so the executor counts bytes as it places each value and stops with GRAPHQL_VALIDATION_FAILED once the
 * budget is passed; the partial result never grows more than one field value past it.
 */
export const MAX_RESPONSE_BYTES = 900_000;

/** UTF-8 length of `text` as a JSON string literal (quotes and escapes included), computed without allocating. */
function jsonStringBytes(text) {
  let bytes = 2;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x20) bytes += 6;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

/** Encoded size of a leaf value placed into the result (a scalar, or a plain JSON value a resolver returned). */
function leafBytes(value) {
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (value === null || value === undefined) return 4;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 4 : jsonStringBytes(encoded);
}

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

const PUNCTUATORS = new Set(["!", "$", "&", "(", ")", ":", "=", "@", "[", "]", "{", "|", "}"]);

function isNameStart(character) {
  return /[_A-Za-z]/.test(character);
}

function isNameChar(character) {
  return /[_0-9A-Za-z]/.test(character);
}

function describe(token) {
  if (token.kind === "EOF") return "<EOF>";
  if (token.kind === "String" || token.kind === "BlockString") return JSON.stringify(token.value);
  if (token.kind === "Name" || token.kind === "Int" || token.kind === "Float") return `${token.kind} "${token.value}"`;
  return JSON.stringify(token.value);
}

export function tokenize(source) {
  const tokens = [];
  let index = 0;
  const length = source.length;
  while (index < length) {
    const character = source[index];
    if (character === "﻿" || character === " " || character === "\t" || character === "\n" || character === "\r" || character === ",") {
      index += 1;
      continue;
    }
    if (character === "#") {
      while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    if (character === "." ) {
      if (source.slice(index, index + 3) === "...") {
        tokens.push({ kind: "Punctuator", value: "...", at: index });
        index += 3;
        continue;
      }
      throw syntax(`Unexpected character ".".`);
    }
    if (PUNCTUATORS.has(character)) {
      tokens.push({ kind: "Punctuator", value: character, at: index });
      index += 1;
      continue;
    }
    if (isNameStart(character)) {
      let end = index + 1;
      while (end < length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: "Name", value: source.slice(index, end), at: index });
      index = end;
      continue;
    }
    if (character === "-" || /[0-9]/.test(character)) {
      let end = index + 1;
      while (end < length && /[0-9]/.test(source[end])) end += 1;
      let isFloat = false;
      if (source[end] === ".") {
        isFloat = true;
        end += 1;
        if (!/[0-9]/.test(source[end] ?? "")) throw syntax(`Invalid number, expected digit but got: ${clipValue(source[end] === undefined ? "<EOF>" : JSON.stringify(source[end]))}.`);
        while (end < length && /[0-9]/.test(source[end])) end += 1;
      }
      if (source[end] === "e" || source[end] === "E") {
        isFloat = true;
        end += 1;
        if (source[end] === "+" || source[end] === "-") end += 1;
        if (!/[0-9]/.test(source[end] ?? "")) throw syntax("Invalid number, expected digit in exponent.");
        while (end < length && /[0-9]/.test(source[end])) end += 1;
      }
      const text = source.slice(index, end);
      if (text === "-" || isNameChar(source[end] ?? " ")) throw syntax(`Invalid number, unexpected digit after ${clipValue(text)}.`);
      tokens.push({ kind: isFloat ? "Float" : "Int", value: text, at: index });
      index = end;
      continue;
    }
    if (character === '"') {
      if (source.slice(index, index + 3) === '"""') {
        const close = source.indexOf('"""', index + 3);
        if (close < 0) throw syntax("Unterminated string.");
        tokens.push({ kind: "BlockString", value: blockStringValue(source.slice(index + 3, close)), at: index });
        index = close + 3;
        continue;
      }
      let end = index + 1;
      let value = "";
      for (;;) {
        if (end >= length || source[end] === "\n" || source[end] === "\r") throw syntax("Unterminated string.");
        const current = source[end];
        if (current === '"') break;
        if (current === "\\") {
          const escape = source[end + 1];
          const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
          if (escape === "u") {
            const hex = source.slice(end + 2, end + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw syntax(`Invalid Unicode escape sequence: "\\u${clipValue(hex)}".`);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            end += 6;
            continue;
          }
          if (simple[escape] === undefined) throw syntax(`Invalid character escape sequence: "\\${clipValue(escape ?? "")}".`);
          value += simple[escape];
          end += 2;
          continue;
        }
        value += current;
        end += 1;
      }
      tokens.push({ kind: "String", value, at: index });
      index = end + 1;
      continue;
    }
    throw syntax(`Unexpected character ${clipValue(JSON.stringify(character))}.`);
  }
  tokens.push({ kind: "EOF", value: "", at: length });
  return tokens;
}

function blockStringValue(raw) {
  const lines = raw.replace(/\\"""/g, '"""').split(/\r\n|\n|\r/);
  let commonIndent = null;
  for (const line of lines.slice(1)) {
    const indent = line.length - line.trimStart().length;
    if (indent < line.length && (commonIndent === null || indent < commonIndent)) commonIndent = indent;
  }
  const trimmed = lines.map((line, position) => (position === 0 || commonIndent === null ? line : line.slice(commonIndent)));
  while (trimmed.length > 0 && trimmed[0].trim().length === 0) trimmed.shift();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim().length === 0) trimmed.pop();
  return trimmed.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

class Parser {
  constructor(source) {
    this.tokens = tokenize(source);
    this.position = 0;
    // Current nesting while parsing: selection sets (fields and inline fragments), selection sets opened by fields
    // (the executed query depth), list/object literals and list type wrappers. Each is checked before descending.
    this.selectionNesting = 0;
    this.fieldDepth = 0;
    this.literalDepth = 0;
    this.typeDepth = 0;
  }

  peek() {
    return this.tokens[this.position];
  }

  next() {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  is(kind, value) {
    const token = this.peek();
    return token.kind === kind && (value === undefined || token.value === value);
  }

  expect(kind, value) {
    const token = this.peek();
    if (token.kind === kind && (value === undefined || token.value === value)) return this.next();
    throw syntax(`Expected ${clipValue(value === undefined ? kind : JSON.stringify(value))}, found ${clipValue(describe(token))}.`);
  }

  expectKeyword(keyword) {
    const token = this.peek();
    if (token.kind === "Name" && token.value === keyword) return this.next();
    throw syntax(`Expected "${clipValue(keyword)}", found ${clipValue(describe(token))}.`);
  }

  document() {
    const definitions = [];
    while (!this.is("EOF")) definitions.push(this.definition());
    if (definitions.length === 0) throw syntax("Unexpected <EOF>.");
    return { definitions };
  }

  definition() {
    if (this.is("Punctuator", "{")) {
      return { kind: "Operation", operation: "query", name: null, variableDefinitions: [], directives: [], selectionSet: this.selectionSet() };
    }
    const token = this.peek();
    if (token.kind === "Name") {
      if (token.value === "query" || token.value === "mutation" || token.value === "subscription") return this.operation();
      if (token.value === "fragment") return this.fragment();
    }
    throw syntax(`Unexpected ${clipValue(describe(token))}.`);
  }

  operation() {
    const operation = this.next().value;
    const name = this.is("Name") ? this.next().value : null;
    const variableDefinitions = this.is("Punctuator", "(") ? this.variableDefinitions() : [];
    const directives = this.directives();
    return { kind: "Operation", operation, name, variableDefinitions, directives, selectionSet: this.selectionSet() };
  }

  variableDefinitions() {
    this.expect("Punctuator", "(");
    const definitions = [];
    while (!this.is("Punctuator", ")")) {
      this.expect("Punctuator", "$");
      const name = this.expect("Name").value;
      this.expect("Punctuator", ":");
      const type = this.typeReference();
      let defaultValue;
      if (this.is("Punctuator", "=")) {
        this.next();
        defaultValue = this.value(true);
      }
      definitions.push({ name, type, defaultValue, directives: this.directives() });
    }
    this.expect("Punctuator", ")");
    return definitions;
  }

  typeReference() {
    let type;
    if (this.is("Punctuator", "[")) {
      if (this.typeDepth >= MAX_TYPE_DEPTH) throw syntax(`Type reference nesting exceeds the maximum depth of ${String(MAX_TYPE_DEPTH)}.`);
      this.next();
      this.typeDepth += 1;
      const inner = this.typeReference();
      this.typeDepth -= 1;
      this.expect("Punctuator", "]");
      type = { kind: "List", type: inner };
    } else {
      type = { kind: "Named", name: this.expect("Name").value };
    }
    if (this.is("Punctuator", "!")) {
      this.next();
      return { kind: "NonNull", type };
    }
    return type;
  }

  fragment() {
    this.expectKeyword("fragment");
    const name = this.expect("Name").value;
    if (name === "on") throw syntax('Unexpected Name "on".');
    this.expectKeyword("on");
    const typeCondition = this.expect("Name").value;
    const directives = this.directives();
    return { kind: "Fragment", name, typeCondition, directives, selectionSet: this.selectionSet() };
  }

  /** `{ selection+ }`. `opensField` is true when a field owns this set, which is one level of executed query depth. */
  selectionSet(opensField = false) {
    if (this.selectionNesting >= MAX_SELECTION_NESTING) throw syntax(`Selection set nesting exceeds the maximum depth of ${String(MAX_SELECTION_NESTING)}.`);
    // Operation and fragment roots are depth 1, like the executor; every field selection set adds one. A fragment
    // spread later can only sit at depth 1 or deeper, so rejecting here never refuses a document the executor accepts.
    const depth = this.fieldDepth + 1;
    if (opensField && depth > MAX_DEPTH) throw validation(`Query depth ${String(depth)} exceeds the maximum of ${String(MAX_DEPTH)}.`);
    this.expect("Punctuator", "{");
    this.selectionNesting += 1;
    if (opensField) this.fieldDepth += 1;
    const selections = [];
    if (this.is("Punctuator", "}")) throw syntax(`Expected Name, found ${clipValue(describe(this.peek()))}.`);
    while (!this.is("Punctuator", "}")) selections.push(this.selection());
    this.expect("Punctuator", "}");
    this.selectionNesting -= 1;
    if (opensField) this.fieldDepth -= 1;
    return selections;
  }

  selection() {
    if (this.is("Punctuator", "...")) {
      this.next();
      if (this.is("Name") && this.peek().value !== "on") {
        const name = this.next().value;
        return { kind: "FragmentSpread", name, directives: this.directives() };
      }
      let typeCondition = null;
      if (this.is("Name", "on")) {
        this.next();
        typeCondition = this.expect("Name").value;
      }
      const directives = this.directives();
      return { kind: "InlineFragment", typeCondition, directives, selectionSet: this.selectionSet() };
    }
    const first = this.expect("Name").value;
    let alias = null;
    let name = first;
    if (this.is("Punctuator", ":")) {
      this.next();
      alias = first;
      name = this.expect("Name").value;
    }
    const args = this.is("Punctuator", "(") ? this.arguments() : [];
    const directives = this.directives();
    const selectionSet = this.is("Punctuator", "{") ? this.selectionSet(true) : null;
    return { kind: "Field", alias, name, arguments: args, directives, selectionSet };
  }

  arguments() {
    this.expect("Punctuator", "(");
    const args = [];
    while (!this.is("Punctuator", ")")) {
      const name = this.expect("Name").value;
      this.expect("Punctuator", ":");
      args.push({ name, value: this.value(false) });
    }
    this.expect("Punctuator", ")");
    if (args.length === 0) throw syntax('Expected Name, found ")".');
    return args;
  }

  directives() {
    const directives = [];
    while (this.is("Punctuator", "@")) {
      this.next();
      const name = this.expect("Name").value;
      directives.push({ name, arguments: this.is("Punctuator", "(") ? this.arguments() : [] });
    }
    return directives;
  }

  value(constant) {
    const token = this.peek();
    if (token.kind === "Punctuator") {
      if (token.value === "$") {
        if (constant) throw syntax('Unexpected variable "$" in constant value.');
        this.next();
        return { kind: "Variable", name: this.expect("Name").value };
      }
      if (token.value === "[" || token.value === "{") {
        if (this.literalDepth >= MAX_LITERAL_DEPTH) throw syntax(`List and object values nest deeper than the maximum depth of ${String(MAX_LITERAL_DEPTH)}.`);
        this.next();
        this.literalDepth += 1;
        let node;
        if (token.value === "[") {
          const values = [];
          while (!this.is("Punctuator", "]")) values.push(this.value(constant));
          node = { kind: "List", values };
        } else {
          const fields = [];
          while (!this.is("Punctuator", "}")) {
            const name = this.expect("Name").value;
            this.expect("Punctuator", ":");
            fields.push({ name, value: this.value(constant) });
          }
          node = { kind: "Object", fields };
        }
        this.next();
        this.literalDepth -= 1;
        return node;
      }
      throw syntax(`Unexpected ${clipValue(describe(token))}.`);
    }
    this.next();
    if (token.kind === "Int") return { kind: "Int", value: Number(token.value) };
    if (token.kind === "Float") return { kind: "Float", value: Number(token.value) };
    if (token.kind === "String" || token.kind === "BlockString") return { kind: "String", value: token.value };
    if (token.kind === "Name") {
      if (token.value === "true" || token.value === "false") return { kind: "Boolean", value: token.value === "true" };
      if (token.value === "null") return { kind: "Null" };
      return { kind: "Enum", value: token.value };
    }
    throw syntax(`Unexpected ${clipValue(describe(token))}.`);
  }
}

export function parse(source) {
  return new Parser(source).document();
}

export function printType(type) {
  if (type.kind === "NonNull") return `${printType(type.type)}!`;
  if (type.kind === "List") return `[${printType(type.type)}]`;
  return type.name;
}

// ---------------------------------------------------------------------------------------------
// Operation selection and variables
// ---------------------------------------------------------------------------------------------

function collectSpreads(node, into) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSpreads(item, into);
    return;
  }
  if (typeof node !== "object") return;
  if (node.kind === "FragmentSpread") into.push(node.name);
  for (const value of Object.values(node)) if (typeof value === "object") collectSpreads(value, into);
}

export function selectOperation(document, operationName) {
  const operations = document.definitions.filter((definition) => definition.kind === "Operation");
  const fragments = new Map();
  for (const definition of document.definitions) {
    if (definition.kind !== "Fragment") continue;
    if (fragments.has(definition.name)) throw validation(`There can be only one fragment named "${clipValue(definition.name)}".`);
    fragments.set(definition.name, definition);
  }
  if (operations.length === 0) throw validation("Document does not contain any operations.");
  // NoUnusedFragments: every fragment must be reachable from some operation in the document.
  const reachable = new Set();
  const pending = [];
  for (const candidate of operations) collectSpreads(candidate, pending);
  while (pending.length > 0) {
    const name = pending.pop();
    if (reachable.has(name)) continue;
    reachable.add(name);
    const fragment = fragments.get(name);
    if (fragment !== undefined) collectSpreads(fragment.selectionSet, pending);
  }
  for (const name of fragments.keys()) {
    if (!reachable.has(name)) throw validation(`Fragment "${clipValue(name)}" is never used.`);
  }
  if (operations.length > 1 && operations.some((candidate) => candidate.name === null)) {
    throw validation("This anonymous operation must be the only defined operation.");
  }
  let operation;
  if (operationName === undefined || operationName === null) {
    if (operations.length > 1) throw validation("Must provide operation name if query contains multiple operations.");
    operation = operations[0];
  } else {
    operation = operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) throw validation(`Unknown operation named "${clipValue(operationName)}".`);
  }
  if (operation.operation === "subscription") throw validation("Subscriptions are not supported.");
  return { operation, fragments };
}

/** Own-property test for caller-named keys (fields, arguments, variables, types); inherited names never match. */
function hasOwn(table, name) {
  return typeof table === "object" && table !== null && Object.prototype.hasOwnProperty.call(table, name);
}

const SCALAR_CHECKS = {
  Int: (value) => Number.isInteger(value),
  Float: (value) => typeof value === "number" && Number.isFinite(value),
  String: (value) => typeof value === "string",
  ID: (value) => typeof value === "string",
  Boolean: (value) => typeof value === "boolean",
};

function coerceValue(type, value, name) {
  if (type.kind === "NonNull") {
    if (value === null || value === undefined) throw validation(`Variable "$${clipValue(name)}" of non-null type "${clipValue(printType(type))}" must not be null.`);
    return coerceValue(type.type, value, name);
  }
  if (value === null || value === undefined) return null;
  if (type.kind === "List") {
    const list = Array.isArray(value) ? value : [value];
    return list.map((item) => coerceValue(type.type, item, name));
  }
  const check = hasOwn(SCALAR_CHECKS, type.name) ? SCALAR_CHECKS[type.name] : undefined;
  if (check !== undefined) {
    if (!check(value)) throw validation(`Variable "$${clipValue(name)}" got invalid value ${clipValue(JSON.stringify(value))}; ${clipValue(type.name)} cannot represent a non ${clipValue(type.name === "Int" || type.name === "Float" ? "numeric" : type.name.toLowerCase())} value: ${clipValue(JSON.stringify(value))}`);
    return value;
  }
  // Enum or input object: enums arrive as strings, input objects as objects.
  if (typeof value === "string" || (typeof value === "object" && !Array.isArray(value))) return value;
  throw validation(`Variable "$${clipValue(name)}" got invalid value ${clipValue(JSON.stringify(value))}; Expected type "${clipValue(type.name)}".`);
}

function literalValue(node) {
  switch (node.kind) {
    case "Int":
    case "Float":
    case "String":
    case "Boolean":
    case "Enum":
      return node.value;
    case "Null":
      return null;
    case "List":
      return node.values.map(literalValue);
    case "Object":
      return Object.fromEntries(node.fields.map((field) => [field.name, literalValue(field.value)]));
    default:
      throw validation("Variables cannot be used inside a default value.");
  }
}

function collectVariableUses(node, into) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectVariableUses(item, into);
    return;
  }
  if (typeof node !== "object") return;
  if (node.kind === "Variable") into.add(node.name);
  for (const value of Object.values(node)) if (typeof value === "object") collectVariableUses(value, into);
}

/**
 * Nesting depth of a JSON value (objects and arrays count one level each), computed with an explicit stack and abandoned
 * as soon as it passes `limit`, so a deeply nested caller value never reaches a recursive walk (JSON.stringify, filters).
 */
export function exceedsDepth(value, limit) {
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    if (depth > limit) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}

export function coerceVariables(operation, fragments, variables) {
  const provided = variables ?? {};
  const values = new Map();
  for (const definition of operation.variableDefinitions) {
    const name = definition.name;
    if (values.has(name)) throw validation(`There can be only one variable named "$${clipValue(name)}".`);
    const supplied = hasOwn(provided, name) ? provided[name] : undefined;
    if (supplied === undefined) {
      if (definition.defaultValue !== undefined) {
        values.set(name, literalValue(definition.defaultValue));
        continue;
      }
      if (definition.type.kind === "NonNull") throw validation(`Variable "$${clipValue(name)}" of required type "${clipValue(printType(definition.type))}" was not provided.`);
      values.set(name, null);
      continue;
    }
    if (exceedsDepth(supplied, MAX_VARIABLE_DEPTH)) throw validation(`Variable "$${clipValue(name)}" nests lists and objects deeper than the maximum depth of ${String(MAX_VARIABLE_DEPTH)}.`);
    values.set(name, coerceValue(definition.type, supplied, name));
  }
  for (const name of Object.keys(provided)) {
    if (!values.has(name)) throw validation(`Variable "$${clipValue(name)}" is not defined by operation "${clipValue(operation.name ?? "anonymous")}".`);
  }
  const used = new Set();
  collectVariableUses(operation.selectionSet, used);
  collectVariableUses(operation.directives, used);
  for (const fragment of fragments.values()) collectVariableUses(fragment, used);
  for (const name of values.keys()) {
    if (!used.has(name)) throw validation(operation.name === null ? `Variable "$${clipValue(name)}" is never used.` : `Variable "$${clipValue(name)}" is never used in operation "${clipValue(operation.name)}".`);
  }
  return values;
}

// ---------------------------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------------------------

function resolveValue(node, variables) {
  switch (node.kind) {
    case "Variable":
      if (!variables.has(node.name)) throw validation(`Variable "$${clipValue(node.name)}" is not defined.`);
      return variables.get(node.name);
    case "Null":
      return null;
    case "List":
      return node.values.map((value) => resolveValue(value, variables));
    case "Object":
      return Object.fromEntries(node.fields.map((field) => [field.name, resolveValue(field.value, variables)]));
    default:
      return node.value;
  }
}

function argumentValues(node, variables, fieldPath) {
  const args = {};
  for (const argument of node.arguments ?? []) {
    if (hasOwn(args, argument.name)) throw validation(`There can be only one argument named "${clipValue(argument.name)}".`, fieldPath);
    args[argument.name] = resolveValue(argument.value, variables);
  }
  return args;
}

function directiveIncludes(directives, variables, path) {
  for (const directive of directives) {
    if (directive.name !== "include" && directive.name !== "skip") throw validation(`Unknown directive "@${clipValue(directive.name)}".`, path);
    const args = argumentValues(directive, variables, path);
    if (typeof args.if !== "boolean") throw validation(`Directive "@${clipValue(directive.name)}" argument "if" of type "Boolean!" is required, but it was not provided.`, path);
    if (directive.name === "include" && !args.if) return false;
    if (directive.name === "skip" && args.if) return false;
  }
  return true;
}

/**
 * Structural equality of two argument values (JSON-like: null, scalars, arrays, plain objects), iterative and
 * short-circuiting on identity, so a shared variable value compares in O(1). Object key order does not matter.
 * `charge(n)` is called with the number of compared nodes before the comparison continues.
 */
function valuesEqual(left, right, charge) {
  const stack = [[left, right]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (a === b) continue;
    charge(1);
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let index = 0; index < a.length; index += 1) stack.push([a[index], b[index]]);
      continue;
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      stack.push([a[key], b[key]]);
    }
  }
  return true;
}

const ARGUMENT_CHECKS = {
  Int: (value) => Number.isInteger(value),
  Float: (value) => typeof value === "number",
  String: (value) => typeof value === "string",
  ID: (value) => typeof value === "string",
  Boolean: (value) => typeof value === "boolean",
  Object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  List: (value) => Array.isArray(value),
  Enum: (value) => typeof value === "string",
};

export class Executor {
  constructor(schema, variables, fragments) {
    this.schema = schema;
    this.session = schema.session;
    this.variables = variables;
    this.fragments = fragments;
    this.nodes = 0;
    this.complexity = 0;
    this.bytes = 0;
    // selection set → type name → collected fields. Directives, variables and fragments are fixed for one operation,
    // so a selection set collects to the same fields every time; list items and repeated spreads reuse the result.
    this.collected = new Map();
    // Content keys (selection-set ids) for merged lists built separately that hold the same sets.
    this.collectedByKey = new Map();
    this.setIds = new Map();
    this.singleLists = new Map();
    this.argPairs = new Map();
    this.expansion = 0;
    this.fragmentNesting = 0;
  }

  /**
   * Adds `count` to the fragment expansion budget before the work it stands for is done: every field entry placed or
   * merged while collecting, every selection-set reference united into a merged field and every argument node compared
   * for a response-key overlap. A fragment spread many times or merged across aliases therefore fails with
   * GRAPHQL_VALIDATION_FAILED instead of growing the merged selection lists.
   */
  expand(count) {
    this.expansion += count;
    if (this.expansion > MAX_EXPANDED_SELECTIONS) {
      throw validation(`Query is too complex: fragment expansion and field merging exceed ${String(MAX_EXPANDED_SELECTIONS)} selections.`);
    }
  }

  /** The single-set selection list for one AST selection set, with a stable identity (so its collection is cached). */
  listOf(selectionSet) {
    let list = this.singleLists.get(selectionSet);
    if (list === undefined) {
      list = Object.freeze([selectionSet]);
      this.singleLists.set(selectionSet, list);
    }
    return list;
  }

  /** Same arguments? Distinct argument objects are compared once per pair and the result remembered. */
  sameArgs(left, right) {
    if (left === right) return true;
    let known = this.argPairs.get(left);
    if (known === undefined) {
      known = new Map();
      this.argPairs.set(left, known);
    }
    const hit = known.get(right);
    if (hit !== undefined) return hit;
    const equal = valuesEqual(left, right, (count) => this.expand(count));
    known.set(right, equal);
    return equal;
  }

  /**
   * Flattens fragments and directives into response-key ordered fields for one type. `selectionSets` is a list of AST
   * selection sets (one for an operation, fragment or field; several once fields with the same response key merged),
   * each set present once. The result is cached per list identity and per list content, so list items and repeated
   * merges reuse it.
   */
  collectFields(typeName, selectionSets, path, visitedFragments = new Set()) {
    let byType = this.collected.get(selectionSets);
    if (byType === undefined) {
      let key = "";
      for (const set of selectionSets) {
        let id = this.setIds.get(set);
        if (id === undefined) {
          id = this.setIds.size;
          this.setIds.set(set, id);
        }
        key += `${String(id)},`;
      }
      byType = this.collectedByKey.get(key);
      if (byType === undefined) {
        byType = new Map();
        this.collectedByKey.set(key, byType);
      }
      this.collected.set(selectionSets, byType);
    }
    const cached = byType.get(typeName);
    if (cached !== undefined) return cached;
    const fields = this.collectFieldsOnce(typeName, selectionSets, path, visitedFragments);
    byType.set(typeName, fields);
    return fields;
  }

  collectFieldsOnce(typeName, selectionSets, path, visitedFragments) {
    const fields = new Map();
    // Named fragments already applied to this collection: spreading one again adds nothing (its fields are merged
    // already), so repeated spreads never repeat work.
    const applied = new Set();
    const add = (responseKey, entry) => {
      this.expand(1);
      const existing = fields.get(responseKey);
      if (existing === undefined) {
        // A fresh entry per map (without the source's merge set), so merging below never touches a cached collection.
        fields.set(responseKey, { name: entry.name, args: entry.args, selections: entry.selections });
        return;
      }
      if (existing.name !== entry.name || !this.sameArgs(existing.args, entry.args)) {
        throw validation(`Fields "${clipValue(responseKey)}" conflict because they have differing arguments or names. Use different aliases on the fields to fetch both.`, path);
      }
      if ((existing.selections === null) !== (entry.selections === null)) {
        throw validation(`Fields "${clipValue(responseKey)}" conflict because they have differing selections. Use different aliases on the fields to fetch both.`, path);
      }
      if (existing.selections === null || existing.selections === entry.selections) return;
      // Union of selection-set references, each AST set at most once: the same subtree merged again adds nothing, so a
      // merged list never outgrows the number of selection sets written in the document. The first merge into an entry
      // copies its (possibly shared, cached) list once; later merges append, so merging k fields costs O(k) in total.
      this.expand(entry.selections.length);
      if (existing.present === undefined) {
        this.expand(existing.selections.length);
        existing.present = new Set(existing.selections);
        existing.selections = [...existing.selections];
      }
      for (const set of entry.selections) {
        if (existing.present.has(set)) continue;
        existing.present.add(set);
        existing.selections.push(set);
      }
    };
    for (const selectionSet of selectionSets) {
      for (const selection of selectionSet) {
        // Every visited selection counts, including fragment spreads, inline fragments and skipped selections.
        this.nodes += 1;
        if (this.nodes > MAX_NODES) throw validation(`Query has more than ${clipValue(String(MAX_NODES))} selection nodes.`);
        if (!directiveIncludes(selection.directives, this.variables, path)) continue;
        if (selection.kind === "Field") {
          const responseKey = selection.alias ?? selection.name;
          add(responseKey, { name: selection.name, args: argumentValues(selection, this.variables, [...path, responseKey]), selections: selection.selectionSet === null ? null : this.listOf(selection.selectionSet) });
          continue;
        }
        let fragmentSelections;
        let typeCondition;
        let spreadChain;
        if (selection.kind === "FragmentSpread") {
          const fragment = this.fragments.get(selection.name);
          if (fragment === undefined) throw validation(`Unknown fragment "${clipValue(selection.name)}".`, path);
          if (visitedFragments.has(selection.name)) throw validation(`Cannot spread fragment "${clipValue(selection.name)}" within itself.`, path);
          if (applied.has(selection.name)) continue;
          if (!directiveIncludes(fragment.directives, this.variables, path)) continue;
          applied.add(selection.name);
          fragmentSelections = fragment.selectionSet;
          typeCondition = fragment.typeCondition;
          // The spread's own chain only: a fresh set, so sibling selections never inherit this fragment.
          spreadChain = new Set([...visitedFragments, selection.name]);
        } else {
          fragmentSelections = selection.selectionSet;
          typeCondition = selection.typeCondition;
          spreadChain = visitedFragments;
        }
        if (typeCondition !== null && typeCondition !== typeName) {
          if (!hasOwn(this.schema.types, typeCondition)) throw validation(`Unknown type "${clipValue(typeCondition)}".`, path);
          throw validation(`Fragment cannot be spread here as objects of type "${clipValue(typeName)}" can never be of type "${clipValue(typeCondition)}".`, path);
        }
        if (this.fragmentNesting >= MAX_FRAGMENT_NESTING) throw validation(`Fragment spreads and inline fragments nest deeper than the maximum depth of ${String(MAX_FRAGMENT_NESTING)}.`, path);
        this.fragmentNesting += 1;
        const collected = this.collectFields(typeName, this.listOf(fragmentSelections), path, spreadChain);
        this.fragmentNesting -= 1;
        for (const [key, entry] of collected) add(key, entry);
      }
    }
    return fields;
  }

  checkArguments(typeName, fieldName, definition, args, path) {
    const declared = definition.args ?? {};
    for (const name of Object.keys(args)) {
      if (!hasOwn(declared, name)) throw notImplemented(`Unknown argument "${clipValue(name)}" on field "${clipValue(typeName)}.${clipValue(fieldName)}".`, path);
    }
    const coerced = {};
    for (const [name, spec] of Object.entries(declared)) {
      const value = hasOwn(args, name) ? args[name] : undefined;
      if (value === undefined) {
        if (spec.required === true) throw validation(`Field "${clipValue(fieldName)}" argument "${clipValue(name)}" of type "${clipValue(spec.type)}!" is required, but it was not provided.`, path);
        continue;
      }
      if (value === null) {
        if (spec.required === true) throw validation(`Argument "${clipValue(name)}" of non-null type "${clipValue(spec.type)}!" must not be null.`, path);
        coerced[name] = null;
        continue;
      }
      const check = ARGUMENT_CHECKS[spec.type];
      if (check !== undefined && !check(value)) throw validation(`Argument "${clipValue(name)}" has invalid value ${clipValue(JSON.stringify(value))}.`, path);
      if (spec.enum !== undefined && !spec.enum.includes(value)) throw validation(`Value "${clipValue(String(value))}" does not exist in "${clipValue(spec.enumName ?? "enum")}" enum.`, path);
      coerced[name] = value;
    }
    return coerced;
  }

  /** Adds `bytes` to the running response size and fails once the encoded `data` would pass MAX_RESPONSE_BYTES. */
  charge(bytes) {
    this.bytes += bytes;
    if (this.bytes > MAX_RESPONSE_BYTES) {
      throw validation(`Query result is too large: the response would exceed ${String(MAX_RESPONSE_BYTES)} bytes. Select fewer fields or request fewer nodes with "first".`);
    }
  }

  project(typeName, parent, selectionSets, depth, path) {
    if (depth > MAX_DEPTH) throw validation(`Query depth ${clipValue(String(depth))} exceeds the maximum of ${clipValue(String(MAX_DEPTH))}.`, path);
    const type = hasOwn(this.schema.types, typeName) ? this.schema.types[typeName] : undefined;
    if (type === undefined) throw notImplemented(`Type "${clipValue(typeName)}" is not implemented by this Tool.`, path);
    const result = {};
    this.charge(2);
    const fields = this.collectFields(typeName, selectionSets, path);
    if (depth === 1 && fields.size > MAX_TOP_LEVEL_FIELDS) throw validation(`Operation selects more than ${clipValue(String(MAX_TOP_LEVEL_FIELDS))} top-level fields.`);
    for (const [responseKey, entry] of fields) {
      const fieldPath = [...path, responseKey];
      // `"key":` plus the separating comma.
      this.charge(jsonStringBytes(responseKey) + 2);
      if (entry.name === "__typename") {
        if (entry.selections !== null) throw validation('Field "__typename" must not have a selection since type "String!" has no subfields.', fieldPath);
        this.charge(jsonStringBytes(typeName));
        result[responseKey] = typeName;
        continue;
      }
      if (entry.name.startsWith("__")) throw notImplemented("Introspection is not implemented by this Tool.", fieldPath);
      // Own fields only: `constructor`, `toString` and other Object.prototype names are unimplemented fields.
      const definition = hasOwn(type.fields, entry.name) ? type.fields[entry.name] : undefined;
      if (definition === undefined) throw notImplemented(`Field "${clipValue(typeName)}.${clipValue(entry.name)}" is not implemented by this Tool.`, fieldPath);
      const args = this.checkArguments(typeName, entry.name, definition, entry.args, fieldPath);
      this.complexity += 1;
      if (this.complexity > MAX_RESOLVED_FIELDS) throw validation(`Query is too complex: it resolves more than ${String(MAX_RESOLVED_FIELDS)} fields.`);
      const value = definition.resolve(parent, args, { path: fieldPath, executor: this });
      result[responseKey] = this.complete(value, entry, depth, fieldPath);
    }
    return result;
  }

  complete(value, entry, depth, path) {
    if (value === null || value === undefined) {
      this.charge(4);
      return null;
    }
    if (Array.isArray(value)) {
      this.charge(2 + value.length);
      return value.map((item, index) => this.complete(item, entry, depth, [...path, index]));
    }
    if (typeof value === "object" && typeof value.__type === "string") {
      if (entry.selections === null) throw validation(`Field "${clipValue(entry.name)}" of type "${clipValue(value.__type)}" must have a selection of subfields. Did you mean "${clipValue(entry.name)} { ... }"?`, path);
      return this.project(value.__type, value, entry.selections, depth + 1, path);
    }
    if (entry.selections !== null) throw validation(`Field "${clipValue(entry.name)}" must not have a selection since its type has no subfields.`, path);
    this.charge(leafBytes(value));
    return value;
  }
}

/**
 * Executes one prepared operation against `schema` ({ types: { Query, Mutation, ... } }).
 * Root fields are resolved with a `null` parent, in document order; returns { data, complexity }.
 */
export function execute(operation, fragments, variables, schema) {
  const executor = new Executor(schema, variables, fragments);
  const rootType = operation.operation === "mutation" ? "Mutation" : "Query";
  if (!directiveIncludes(operation.directives, variables, [])) return { data: {}, complexity: 0 };
  const data = executor.project(rootType, null, executor.listOf(operation.selectionSet), 1, []);
  return { data, complexity: executor.complexity };
}
