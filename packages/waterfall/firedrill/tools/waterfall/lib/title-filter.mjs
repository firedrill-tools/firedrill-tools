// Boolean title filters: `"quoted terms"` or bare words joined by AND / OR / NOT with parentheses
// (precedence NOT > AND > OR). A single-pass tokenizer and an iterative shunting-yard pass compile a filter to RPN once;
// evaluation is a stack walk with case-insensitive `indexOf` per term (linear in the title length, no regex).
import { clip, fail } from "./core.mjs";

const MAX_DEPTH = 64;
const MAX_TERMS = 100;
const PRECEDENCE = { NOT: 3, AND: 2, OR: 1 };
const OPERATORS = new Map([["and", "AND"], ["or", "OR"], ["not", "NOT"]]);

function tokenize(context, text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
    } else if (char === "(" || char === ")") {
      tokens.push({ type: char });
      index += 1;
    } else if (char === '"') {
      const close = text.indexOf('"', index + 1);
      if (close < 0) fail(context, "VALIDATION_BAD_TITLE_FILTER", `Bad title filter: unterminated quote in ${clip(text)}`);
      const term = text.slice(index + 1, close).trim().toLowerCase();
      if (term.length === 0) fail(context, "VALIDATION_BAD_TITLE_FILTER_MISSING_STRING", "Bad title filter: empty quoted string");
      tokens.push({ type: "term", value: term });
      index = close + 1;
    } else {
      let end = index;
      while (end < text.length && !' \t\n\r()"'.includes(text[end])) end += 1;
      const word = text.slice(index, end);
      const operator = OPERATORS.get(word.toLowerCase());
      tokens.push(operator === undefined ? { type: "term", value: word.toLowerCase() } : { type: operator });
      index = end;
    }
  }
  return tokens;
}

/** Compile a filter string to RPN, raising the documented title-filter error codes. */
export function compileTitleFilter(context, text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 500) {
    fail(context, "VALIDATION_BAD_TITLE_FILTER", "Bad title filter: filter must be a string of 1 to 500 characters");
  }
  const tokens = tokenize(context, text);
  const output = [];
  const stack = [];
  let terms = 0;
  let depth = 0;
  let expectOperand = true;
  for (const token of tokens) {
    if (token.type === "term") {
      if (!expectOperand) fail(context, "VALIDATION_BAD_TITLE_FILTER", `Bad title filter: missing operator before ${clip(token.value, 60)}`);
      terms += 1;
      if (terms > MAX_TERMS) fail(context, "VALIDATION_BAD_TITLE_FILTER", `Bad title filter: more than ${MAX_TERMS} terms`);
      output.push(token);
      expectOperand = false;
    } else if (token.type === "(") {
      if (!expectOperand) fail(context, "VALIDATION_BAD_TITLE_FILTER", "Bad title filter: missing operator before (");
      depth += 1;
      if (depth > MAX_DEPTH) fail(context, "VALIDATION_BAD_TITLE_FILTER", `Bad title filter: nesting deeper than ${MAX_DEPTH}`);
      stack.push(token);
    } else if (token.type === ")") {
      if (expectOperand) fail(context, "VALIDATION_BAD_TITLE_FILTER_MISSING_STRING", "Bad title filter: missing string before )");
      let found = false;
      while (stack.length > 0) {
        const top = stack.pop();
        if (top.type === "(") {
          found = true;
          break;
        }
        output.push(top);
      }
      if (!found) fail(context, "VALIDATION_BAD_TITLE_FILTER_EXTRA_RIGHT_PARENTHESIS", "Bad title filter: extra right parenthesis");
      depth -= 1;
    } else if (token.type === "NOT") {
      if (!expectOperand) fail(context, "VALIDATION_BAD_TITLE_FILTER", "Bad title filter: missing operator before NOT");
      stack.push(token);
    } else {
      if (expectOperand) fail(context, "VALIDATION_BAD_TITLE_FILTER_MISSING_STRING", `Bad title filter: missing string before ${token.type}`);
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top.type === "(" || PRECEDENCE[top.type] < PRECEDENCE[token.type]) break;
        output.push(stack.pop());
      }
      stack.push(token);
      expectOperand = true;
    }
  }
  if (expectOperand) {
    fail(context, "VALIDATION_BAD_TITLE_FILTER_MISSING_STRING", tokens.length === 0 ? "Bad title filter: empty filter" : "Bad title filter: missing string at the end");
  }
  while (stack.length > 0) {
    const top = stack.pop();
    if (top.type === "(") fail(context, "VALIDATION_BAD_TITLE_FILTER_MISSING_RIGHT_PARENTHESIS", "Bad title filter: missing right parenthesis");
    output.push(top);
  }
  return output;
}

/** Evaluate compiled RPN against a lowercased title. */
export function matchesTitle(rpn, lowerTitle) {
  const stack = [];
  for (const token of rpn) {
    if (token.type === "term") stack.push(lowerTitle.indexOf(token.value) >= 0);
    else if (token.type === "NOT") stack.push(!stack.pop());
    else {
      const right = stack.pop();
      const left = stack.pop();
      stack.push(token.type === "AND" ? left && right : left || right);
    }
  }
  return stack.length === 1 && stack[0] === true;
}
