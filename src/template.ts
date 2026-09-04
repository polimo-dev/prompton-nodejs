import { canonicalJson } from "./json.js";
import { MissingVariableError, TemplateParseError, TemplateRenderError } from "./errors.js";

/**
 * The prompt template engine: the Liquid subset PromptOn allows.
 *
 * Tags: `for` (with `else`, `break`, `continue` and `forloop.*`), `if`/`elsif`/`else`, `unless`,
 * `assign`. Filters: `size`, `join`, `default`. Everything else is a parse error, and the `raw`
 * engine returns the source verbatim for prompts whose text genuinely contains `{{` or `{%`.
 *
 * A variable is *missing* when its key is absent from the variables map — a key present with a
 * `null` value is not missing: it renders as the empty string and `default` replaces it.
 */

/** Which engine a prompt version was committed with. */
export type Engine = "liquid" | "raw";

/** Tag names the parser accepts. */
export const ALLOWED_TAGS = ["assign", "break", "continue", "for", "if", "unless"] as const;

/** Filter names lint accepts. */
export const ALLOWED_FILTERS = ["size", "join", "default"] as const;

const CLOSING_TAGS = new Set(["endfor", "endif", "endunless"]);
const INNER_TAGS = new Set(["else", "elsif"]);
const KNOWN_TAGS = new Set<string>([
  ...ALLOWED_TAGS,
  ...CLOSING_TAGS,
  ...INNER_TAGS,
]);

const FILTER_SET = new Set<string>(ALLOWED_FILTERS);
const BUILTIN_VARIABLES = new Set(["forloop"]);
const LITERAL_WORDS = new Set(["true", "false", "nil", "null", "empty", "blank"]);

/** A chat message, as a prompt version stores it and as a provider expects it. */
export interface Message {
  role: string;
  content: string;
  [key: string]: unknown;
}

/** Variables a render is given. */
export type Variables = Record<string, unknown> | null | undefined;

/** One reason `lint()` rejected a template. */
export interface LintReason {
  kind: "whitespace_control" | "disallowed_tag" | "disallowed_filter" | "parse";
  value: string;
}

/** The result of `lint()`. */
export type LintResult = { ok: true } | { ok: false; reasons: LintReason[] };

// ---------------------------------------------------------------------------
// public API

/**
 * Renders a template. `engine: "raw"` returns the source verbatim without parsing it.
 *
 * Throws {@link MissingVariableError}, {@link TemplateParseError} or {@link TemplateRenderError}.
 */
export function render(source: string, variables: Variables, engine: Engine = "liquid"): string {
  if (engine === "raw") return source;
  return renderNodesToString(parse(source), variables);
}

/** Renders the `content` of every message, leaving `role` and any other key untouched. */
export function renderMessages(
  messages: readonly Message[],
  variables: Variables,
  engine: Engine = "liquid",
): Message[] {
  return messages.map((message) => ({
    ...message,
    content: render(message.content ?? "", variables, engine),
  }));
}

/**
 * The top-level input variables a template reads, sorted and deduplicated. Loop variables, assign
 * targets and `forloop` are excluded. This is the server's `detected_variables`.
 */
export function templateVariables(source: string): string[] {
  let nodes: Node[];
  try {
    nodes = parse(source);
  } catch {
    return regexVariables(source);
  }
  const referenced = new Set<string>();
  const bound = new Set<string>();
  collectVariables(nodes, referenced, bound);
  return [...referenced]
    .filter((name) => !bound.has(name) && !BUILTIN_VARIABLES.has(name))
    .sort();
}

/**
 * The static whitelist check the server applies when a prompt version is committed: allowed tags,
 * allowed filters, no whitespace control.
 */
export function lint(source: string): LintResult {
  const reasons: LintReason[] = [];
  for (const marker of whitespaceControlMarkers(source)) {
    reasons.push({ kind: "whitespace_control", value: marker });
  }
  const unknownTags = unknownTagNames(source);
  if (unknownTags.length > 0) {
    for (const tag of unknownTags) reasons.push({ kind: "disallowed_tag", value: tag });
  } else {
    try {
      const nodes = parse(source);
      for (const filter of collectFilters(nodes)) {
        if (!FILTER_SET.has(filter)) reasons.push({ kind: "disallowed_filter", value: filter });
      }
    } catch (error) {
      reasons.push({
        kind: "parse",
        value: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const unique: LintReason[] = [];
  for (const reason of reasons) {
    if (!unique.some((seen) => seen.kind === reason.kind && seen.value === reason.value)) {
      unique.push(reason);
    }
  }
  return unique.length === 0 ? { ok: true } : { ok: false, reasons: unique };
}

// ---------------------------------------------------------------------------
// lexer

type Token =
  | { type: "text"; value: string }
  | { type: "output"; value: string; trimLeft: boolean; trimRight: boolean }
  | { type: "tag"; name: string; rest: string; trimLeft: boolean; trimRight: boolean };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let text = "";

  const pushText = (trimRight: boolean): void => {
    if (trimRight) text = text.replace(/\s+$/u, "");
    if (text !== "") tokens.push({ type: "text", value: text });
    text = "";
  };

  while (index < source.length) {
    const open = source.indexOf("{", index);
    if (open === -1 || open === source.length - 1) {
      text += source.slice(index);
      break;
    }
    const marker = source[open + 1];
    if (marker !== "{" && marker !== "%") {
      text += source.slice(index, open + 1);
      index = open + 1;
      continue;
    }
    const closing = marker === "{" ? "}}" : "%}";
    const close = source.indexOf(closing, open + 2);
    if (close === -1) {
      throw new TemplateParseError(
        `unterminated ${marker === "{" ? "{{" : "{%"} at byte ${String(open)}`,
      );
    }
    let body = source.slice(open + 2, close);
    const trimLeft = body.startsWith("-");
    if (trimLeft) body = body.slice(1);
    const trimRight = body.endsWith("-");
    if (trimRight) body = body.slice(0, -1);

    text += source.slice(index, open);
    pushText(trimLeft);

    if (marker === "{") {
      tokens.push({ type: "output", value: body.trim(), trimLeft, trimRight });
    } else {
      const trimmed = body.trim();
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*([\s\S]*)$/u.exec(trimmed);
      if (!match) throw new TemplateParseError(`malformed tag: {%${body}%}`);
      tokens.push({
        type: "tag",
        name: match[1] as string,
        rest: (match[2] as string).trim(),
        trimLeft,
        trimRight,
      });
    }

    index = close + closing.length;
    if (trimRight) {
      const remainder = source.slice(index);
      const stripped = remainder.replace(/^\s+/u, "");
      index += remainder.length - stripped.length;
    }
  }
  pushText(false);
  return tokens;
}

// ---------------------------------------------------------------------------
// expressions

interface PathSegment {
  kind: "property" | "index";
  name?: string;
  index?: Expr;
}

type Expr =
  | { t: "literal"; value: unknown }
  | { t: "variable"; root: string; path: PathSegment[]; source: string }
  | { t: "filter"; source: Expr; name: string; args: Expr[] }
  | { t: "range"; from: Expr; to: Expr };

type Condition =
  | { t: "value"; expr: Expr }
  | { t: "compare"; op: string; left: Expr; right: Expr }
  | { t: "and" | "or"; left: Condition; right: Condition };

type Node =
  | { t: "text"; value: string }
  | { t: "output"; expr: Expr }
  | { t: "if"; branches: { condition: Condition; body: Node[] }[]; otherwise: Node[] | null }
  | { t: "unless"; condition: Condition; body: Node[]; otherwise: Node[] | null }
  | {
      t: "for";
      variable: string;
      source: Expr;
      body: Node[];
      otherwise: Node[] | null;
      limit: Expr | null;
      offset: Expr | null;
      reversed: boolean;
    }
  | { t: "assign"; target: string; expr: Expr }
  | { t: "break" }
  | { t: "continue" };

const EXPR_TOKEN =
  /\s*(?:("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\d+\.\d+|-?\d+)|(==|!=|<>|>=|<=|>|<)|(\.\.)|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[[^\]]*\])*)|(\|)|(:)|(,)|(\()|(\))|(\S))/uy;

interface ExprToken {
  kind: "string" | "number" | "operator" | "range" | "ident" | "pipe" | "colon" | "comma" | "paren";
  value: string;
}

function lexExpression(input: string): ExprToken[] {
  const tokens: ExprToken[] = [];
  EXPR_TOKEN.lastIndex = 0;
  while (EXPR_TOKEN.lastIndex < input.length) {
    const start = EXPR_TOKEN.lastIndex;
    const match = EXPR_TOKEN.exec(input);
    if (!match) {
      const remainder = input.slice(start).trim();
      if (remainder === "") break;
      throw new TemplateParseError(`unexpected token in expression: ${remainder}`);
    }
    if (match[1] !== undefined) tokens.push({ kind: "string", value: match[1] });
    else if (match[2] !== undefined) tokens.push({ kind: "number", value: match[2] });
    else if (match[3] !== undefined) tokens.push({ kind: "operator", value: match[3] });
    else if (match[4] !== undefined) tokens.push({ kind: "range", value: ".." });
    else if (match[5] !== undefined) tokens.push({ kind: "ident", value: match[5] });
    else if (match[6] !== undefined) tokens.push({ kind: "pipe", value: "|" });
    else if (match[7] !== undefined) tokens.push({ kind: "colon", value: ":" });
    else if (match[8] !== undefined) tokens.push({ kind: "comma", value: "," });
    else if (match[9] !== undefined) tokens.push({ kind: "paren", value: "(" });
    else if (match[10] !== undefined) tokens.push({ kind: "paren", value: ")" });
    else throw new TemplateParseError(`unexpected character in expression: ${match[11] as string}`);
  }
  return tokens;
}

class ExprParser {
  private readonly tokens: ExprToken[];
  private position = 0;

  constructor(input: string) {
    this.tokens = lexExpression(input);
  }

  atEnd(): boolean {
    return this.position >= this.tokens.length;
  }

  peek(): ExprToken | undefined {
    return this.tokens[this.position];
  }

  next(): ExprToken | undefined {
    const token = this.tokens[this.position];
    this.position += 1;
    return token;
  }

  expectEnd(context: string): void {
    if (!this.atEnd()) {
      throw new TemplateParseError(`unexpected trailing input in ${context}`);
    }
  }

  /** A term plus any `| filter` chain. */
  parseFiltered(): Expr {
    let expr = this.parseTerm();
    while (this.peek()?.kind === "pipe") {
      this.next();
      const name = this.next();
      if (!name || name.kind !== "ident") {
        throw new TemplateParseError("expected a filter name after |");
      }
      const args: Expr[] = [];
      if (this.peek()?.kind === "colon") {
        this.next();
        args.push(this.parseTerm());
        while (this.peek()?.kind === "comma") {
          this.next();
          args.push(this.parseTerm());
        }
      }
      expr = { t: "filter", source: expr, name: name.value, args };
    }
    return expr;
  }

  parseTerm(): Expr {
    const token = this.next();
    if (!token) throw new TemplateParseError("unexpected end of expression");
    if (token.kind === "string") return { t: "literal", value: unquote(token.value) };
    if (token.kind === "number") return { t: "literal", value: Number(token.value) };
    if (token.kind === "paren" && token.value === "(") {
      const from = this.parseTerm();
      const dots = this.next();
      if (!dots || dots.kind !== "range") throw new TemplateParseError("expected .. in a range");
      const to = this.parseTerm();
      const close = this.next();
      if (!close || close.value !== ")") throw new TemplateParseError("expected ) after a range");
      return { t: "range", from, to };
    }
    if (token.kind === "ident") return identifierExpr(token.value);
    throw new TemplateParseError(`unexpected token in expression: ${token.value}`);
  }

  /** `a`, `a == b`, and `and`/`or` chains, which Liquid evaluates right to left. */
  parseCondition(): Condition {
    const left = this.parseComparison();
    const token = this.peek();
    if (token && token.kind === "ident" && (token.value === "and" || token.value === "or")) {
      this.next();
      const right = this.parseCondition();
      return { t: token.value, left, right };
    }
    return left;
  }

  private parseComparison(): Condition {
    const left = this.parseFiltered();
    const token = this.peek();
    if (token && (token.kind === "operator" || (token.kind === "ident" && token.value === "contains"))) {
      this.next();
      const right = this.parseFiltered();
      return { t: "compare", op: token.value, left, right };
    }
    return { t: "value", expr: left };
  }
}

function identifierExpr(raw: string): Expr {
  if (LITERAL_WORDS.has(raw)) {
    switch (raw) {
      case "true":
        return { t: "literal", value: true };
      case "false":
        return { t: "literal", value: false };
      case "empty":
      case "blank":
        return { t: "literal", value: EMPTY };
      default:
        return { t: "literal", value: null };
    }
  }
  const path: PathSegment[] = [];
  const head = /^[A-Za-z_][A-Za-z0-9_-]*/u.exec(raw);
  if (!head) throw new TemplateParseError(`invalid identifier: ${raw}`);
  const root = head[0];
  let rest = raw.slice(root.length);
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const property = /^\.([A-Za-z_][A-Za-z0-9_-]*)/u.exec(rest);
      if (!property) throw new TemplateParseError(`invalid property access: ${raw}`);
      path.push({ kind: "property", name: property[1] });
      rest = rest.slice(property[0].length);
      continue;
    }
    if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close === -1) throw new TemplateParseError(`invalid index access: ${raw}`);
      const inner = rest.slice(1, close).trim();
      if (/^-?\d+$/u.test(inner)) {
        path.push({ kind: "index", index: { t: "literal", value: Number(inner) } });
      } else if (/^["']/u.test(inner)) {
        path.push({ kind: "property", name: unquote(inner) });
      } else {
        path.push({ kind: "index", index: identifierExpr(inner) });
      }
      rest = rest.slice(close + 1);
      continue;
    }
    throw new TemplateParseError(`invalid identifier: ${raw}`);
  }
  return { t: "variable", root, path, source: raw };
}

function unquote(literal: string): string {
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/gu, "$1");
}

/** Sentinel for Liquid's `empty` / `blank` literals. */
const EMPTY = Symbol("empty");

// ---------------------------------------------------------------------------
// parser

/** Parses a template into a node tree. Throws {@link TemplateParseError}. */
export function parse(source: string): Node[] {
  const tokens = tokenize(source);
  const state = { index: 0 };
  const nodes = parseNodes(tokens, state, null);
  if (state.index < tokens.length) {
    const token = tokens[state.index] as Token;
    const name = token.type === "tag" ? token.name : "output";
    throw new TemplateParseError(`Unexpected tag '${name}'`);
  }
  return nodes;
}

/**
 * A block body made of nothing but whitespace renders as nothing. That is the reference engine's
 * behaviour, and templates rely on it: `{% unless forloop.last %} {% endunless %}` emits no space.
 */
function parseBody(
  tokens: Token[],
  state: { index: number },
  stop: (name: string) => boolean,
): Node[] {
  const nodes = parseNodes(tokens, state, stop);
  const only = nodes.length === 1 ? nodes[0] : null;
  if (only && only.t === "text" && /^\s*$/u.test(only.value)) return [];
  return nodes;
}

function parseNodes(
  tokens: Token[],
  state: { index: number },
  stop: ((name: string) => boolean) | null,
): Node[] {
  const nodes: Node[] = [];
  while (state.index < tokens.length) {
    const token = tokens[state.index] as Token;
    if (token.type === "tag" && stop && stop(token.name)) return nodes;
    if (token.type === "tag" && !KNOWN_TAGS.has(token.name)) {
      throw new TemplateParseError(`Unexpected tag '${token.name}'`);
    }
    if (token.type === "tag" && (CLOSING_TAGS.has(token.name) || INNER_TAGS.has(token.name))) {
      return nodes;
    }
    state.index += 1;
    if (token.type === "text") {
      nodes.push({ t: "text", value: token.value });
    } else if (token.type === "output") {
      const parser = new ExprParser(token.value);
      const expr = parser.parseFiltered();
      parser.expectEnd("an output expression");
      nodes.push({ t: "output", expr });
    } else {
      nodes.push(parseTag(token, tokens, state));
    }
  }
  return nodes;
}

function parseTag(token: Token & { type: "tag" }, tokens: Token[], state: { index: number }): Node {
  switch (token.name) {
    case "if":
    case "unless":
      return parseConditional(token, tokens, state);
    case "for":
      return parseFor(token, tokens, state);
    case "assign": {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/u.exec(token.rest);
      if (!match) throw new TemplateParseError("malformed assign tag");
      const parser = new ExprParser(match[2] as string);
      const expr = parser.parseFiltered();
      parser.expectEnd("an assign tag");
      return { t: "assign", target: match[1] as string, expr };
    }
    case "break":
      return { t: "break" };
    case "continue":
      return { t: "continue" };
    default:
      throw new TemplateParseError(`Unexpected tag '${token.name}'`);
  }
}

function parseConditional(
  token: Token & { type: "tag" },
  tokens: Token[],
  state: { index: number },
): Node {
  const closing = token.name === "if" ? "endif" : "endunless";
  const branches: { condition: Condition; body: Node[] }[] = [];
  const parser = new ExprParser(token.rest);
  const condition = parser.parseCondition();
  parser.expectEnd(`an ${token.name} tag`);
  let body = parseBody(tokens, state, (name) => name === closing || INNER_TAGS.has(name));
  branches.push({ condition, body });
  let otherwise: Node[] | null = null;

  for (;;) {
    const current = tokens[state.index];
    if (!current || current.type !== "tag") {
      throw new TemplateParseError(`Expected '${closing}'`);
    }
    if (current.name === closing) {
      state.index += 1;
      break;
    }
    if (current.name === "elsif") {
      state.index += 1;
      const branchParser = new ExprParser(current.rest);
      const branchCondition = branchParser.parseCondition();
      branchParser.expectEnd("an elsif tag");
      body = parseBody(tokens, state, (name) => name === closing || INNER_TAGS.has(name));
      branches.push({ condition: branchCondition, body });
      continue;
    }
    if (current.name === "else") {
      state.index += 1;
      otherwise = parseBody(tokens, state, (name) => name === closing || INNER_TAGS.has(name));
      continue;
    }
    throw new TemplateParseError(`Expected '${closing}'`);
  }

  if (token.name === "unless") {
    const first = branches[0] as { condition: Condition; body: Node[] };
    if (branches.length > 1) throw new TemplateParseError("elsif is not allowed inside unless");
    return { t: "unless", condition: first.condition, body: first.body, otherwise };
  }
  return { t: "if", branches, otherwise };
}

function parseFor(
  token: Token & { type: "tag" },
  tokens: Token[],
  state: { index: number },
): Node {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/u.exec(token.rest);
  if (!match) throw new TemplateParseError("malformed for tag");
  let rest = (match[2] as string).trim();
  let reversed = false;
  let limit: Expr | null = null;
  let offset: Expr | null = null;

  for (;;) {
    const reversedMatch = /\breversed\s*$/u.exec(rest);
    if (reversedMatch) {
      reversed = true;
      rest = rest.slice(0, reversedMatch.index).trim();
      continue;
    }
    const paramMatch = /\b(limit|offset)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*|\d+)\s*$/u.exec(rest);
    if (paramMatch) {
      const parser = new ExprParser(paramMatch[2] as string);
      const value = parser.parseTerm();
      if (paramMatch[1] === "limit") limit = value;
      else offset = value;
      rest = rest.slice(0, paramMatch.index).trim();
      continue;
    }
    break;
  }

  const sourceParser = new ExprParser(rest);
  const source = sourceParser.parseFiltered();
  sourceParser.expectEnd("a for tag");

  const body = parseBody(tokens, state, (name) => name === "endfor" || name === "else");
  let otherwise: Node[] | null = null;
  for (;;) {
    const current = tokens[state.index];
    if (!current || current.type !== "tag") throw new TemplateParseError("Expected 'endfor'");
    if (current.name === "endfor") {
      state.index += 1;
      break;
    }
    if (current.name === "else") {
      state.index += 1;
      otherwise = parseBody(tokens, state, (name) => name === "endfor");
      continue;
    }
    throw new TemplateParseError("Expected 'endfor'");
  }

  return {
    t: "for",
    variable: match[1] as string,
    source,
    body,
    otherwise,
    limit,
    offset,
    reversed,
  };
}

// ---------------------------------------------------------------------------
// renderer

type Scope = Map<string, unknown>[];

type Signal = "break" | "continue" | null;

function renderNodesToString(nodes: Node[], variables: Variables): string {
  const scope: Scope = [new Map(Object.entries(variables ?? {}))];
  const out: string[] = [];
  renderNodes(nodes, scope, out);
  return out.join("");
}

/** Liquid's `assign` writes to the outermost scope, so it survives the loop it was made in. */
function setVariable(scope: Scope, name: string, value: unknown): void {
  (scope[0] as Map<string, unknown>).set(name, value);
}

function renderNodes(nodes: Node[], scope: Scope, out: string[]): Signal {
  for (const node of nodes) {
    const signal = renderNode(node, scope, out);
    if (signal) return signal;
  }
  return null;
}

function renderNode(node: Node, scope: Scope, out: string[]): Signal {
  switch (node.t) {
    case "text":
      out.push(node.value);
      return null;
    case "output":
      out.push(toOutput(evaluate(node.expr, scope)));
      return null;
    case "assign":
      setVariable(scope, node.target, evaluate(node.expr, scope));
      return null;
    case "break":
      return "break";
    case "continue":
      return "continue";
    case "if": {
      for (const branch of node.branches) {
        if (truthy(evaluateCondition(branch.condition, scope))) {
          return renderNodes(branch.body, scope, out);
        }
      }
      return node.otherwise ? renderNodes(node.otherwise, scope, out) : null;
    }
    case "unless": {
      if (!truthy(evaluateCondition(node.condition, scope))) {
        return renderNodes(node.body, scope, out);
      }
      return node.otherwise ? renderNodes(node.otherwise, scope, out) : null;
    }
    case "for":
      return renderFor(node, scope, out);
    default:
      return null;
  }
}

function renderFor(
  node: Extract<Node, { t: "for" }>,
  scope: Scope,
  out: string[],
): Signal {
  const raw = evaluate(node.source, scope);
  let items = toIterable(raw);
  if (node.offset) items = items.slice(Number(evaluate(node.offset, scope)) || 0);
  if (node.limit) items = items.slice(0, Number(evaluate(node.limit, scope)) || 0);
  if (node.reversed) items = [...items].reverse();

  if (items.length === 0) {
    return node.otherwise ? renderNodes(node.otherwise, scope, out) : null;
  }

  const frame = new Map<string, unknown>();
  scope.push(frame);
  try {
    for (let index = 0; index < items.length; index += 1) {
      frame.set(node.variable, items[index]);
      frame.set("forloop", {
        index: index + 1,
        index0: index,
        rindex: items.length - index,
        rindex0: items.length - index - 1,
        first: index === 0,
        last: index === items.length - 1,
        length: items.length,
      });
      const signal = renderNodes(node.body, scope, out);
      if (signal === "break") break;
    }
  } finally {
    scope.pop();
  }
  return null;
}

function toIterable(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>);
  return [value];
}

function evaluateCondition(condition: Condition, scope: Scope): unknown {
  switch (condition.t) {
    case "value":
      return evaluate(condition.expr, scope);
    case "and":
      return truthy(evaluateCondition(condition.left, scope))
        ? truthy(evaluateCondition(condition.right, scope))
        : false;
    case "or":
      return truthy(evaluateCondition(condition.left, scope))
        ? true
        : truthy(evaluateCondition(condition.right, scope));
    case "compare":
      return compare(
        condition.op,
        evaluate(condition.left, scope),
        evaluate(condition.right, scope),
      );
    default:
      return false;
  }
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case "==":
      return looseEqual(left, right);
    case "!=":
    case "<>":
      return !looseEqual(left, right);
    case ">":
      return orderable(left, right) ? (left as number) > (right as number) : false;
    case "<":
      return orderable(left, right) ? (left as number) < (right as number) : false;
    case ">=":
      return orderable(left, right) ? (left as number) >= (right as number) : false;
    case "<=":
      return orderable(left, right) ? (left as number) <= (right as number) : false;
    case "contains":
      if (typeof left === "string") return left.includes(toOutput(right));
      if (Array.isArray(left)) return left.some((item) => looseEqual(item, right));
      return false;
    default:
      throw new TemplateRenderError(`unsupported operator: ${op}`);
  }
}

function orderable(left: unknown, right: unknown): boolean {
  return (
    (typeof left === "number" && typeof right === "number") ||
    (typeof left === "string" && typeof right === "string")
  );
}

function looseEqual(left: unknown, right: unknown): boolean {
  if (left === EMPTY || right === EMPTY) {
    const other = left === EMPTY ? right : left;
    if (typeof other === "string") return other.length === 0;
    if (Array.isArray(other)) return other.length === 0;
    if (other && typeof other === "object") return Object.keys(other).length === 0;
    return other === null || other === undefined;
  }
  if (left === null || left === undefined) return right === null || right === undefined;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => looseEqual(item, right[i]));
  }
  return left === right;
}

function truthy(value: unknown): boolean {
  return value !== false && value !== null && value !== undefined;
}

function evaluate(expr: Expr, scope: Scope): unknown {
  switch (expr.t) {
    case "literal":
      return expr.value;
    case "variable":
      return lookup(expr, scope);
    case "range": {
      const from = Number(evaluate(expr.from, scope));
      const to = Number(evaluate(expr.to, scope));
      const items: number[] = [];
      for (let value = from; value <= to; value += 1) items.push(value);
      return items;
    }
    case "filter":
      return applyFilter(
        expr.name,
        evaluate(expr.source, scope),
        expr.args.map((arg) => evaluate(arg, scope)),
      );
    default:
      return null;
  }
}

function lookup(expr: Extract<Expr, { t: "variable" }>, scope: Scope): unknown {
  let found = false;
  let current: unknown = null;
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const frame = scope[i] as Map<string, unknown>;
    if (frame.has(expr.root)) {
      current = frame.get(expr.root);
      found = true;
      break;
    }
  }
  if (!found) throw new MissingVariableError(expr.source);

  for (const segment of expr.path) {
    if (segment.kind === "property") {
      const name = segment.name as string;
      if (current !== null && typeof current === "object" && !Array.isArray(current)) {
        const record = current as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, name)) {
          throw new MissingVariableError(expr.source);
        }
        current = record[name];
        continue;
      }
      const special = specialProperty(current, name);
      if (special !== undefined) {
        current = special;
        continue;
      }
      throw new MissingVariableError(expr.source);
    }
    const index = Number(evaluate(segment.index as Expr, scope));
    if (Array.isArray(current)) {
      const position = index < 0 ? current.length + index : index;
      current = position in current ? current[position] : null;
      continue;
    }
    if (current !== null && typeof current === "object") {
      const record = current as Record<string, unknown>;
      current = Object.prototype.hasOwnProperty.call(record, String(index))
        ? record[String(index)]
        : null;
      continue;
    }
    throw new MissingVariableError(expr.source);
  }
  return current;
}

function specialProperty(value: unknown, name: string): unknown {
  if (Array.isArray(value)) {
    if (name === "size") return value.length;
    if (name === "first") return value.length > 0 ? value[0] : null;
    if (name === "last") return value.length > 0 ? value[value.length - 1] : null;
    return undefined;
  }
  if (typeof value === "string") {
    if (name === "size") return [...value].length;
    return undefined;
  }
  return undefined;
}

function applyFilter(name: string, value: unknown, args: unknown[]): unknown {
  switch (name) {
    case "size":
      if (typeof value === "string") return [...value].length;
      if (Array.isArray(value)) return value.length;
      if (value !== null && typeof value === "object") return Object.keys(value).length;
      return 0;
    case "join": {
      const separator = args.length > 0 ? toOutput(args[0]) : " ";
      const items = Array.isArray(value) ? value : [value];
      return items.map((item) => toOutput(item)).join(separator);
    }
    case "default": {
      const fallback = args.length > 0 ? args[0] : null;
      return isBlank(value) ? fallback : value;
    }
    default:
      throw new TemplateRenderError(
        `filter "${name}" is not in the PromptOn subset (allowed: ${ALLOWED_FILTERS.join(", ")})`,
      );
  }
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Liquid's value rendering: strings unescaped, `null` as the empty string, booleans as words, a
 * list as its elements concatenated with no separator.
 *
 * JavaScript has one number type, so an integral float renders as `2`, not `2.0` — the one place
 * this SDK cannot match a language that distinguishes the two.
 */
function toOutput(value: unknown): string {
  if (value === null || value === undefined || value === EMPTY) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((item) => toOutput(item)).join("");
  return canonicalJson(value);
}

// ---------------------------------------------------------------------------
// static analysis helpers

function walkExpr(expr: Expr, visit: (expr: Expr) => void): void {
  visit(expr);
  if (expr.t === "filter") {
    walkExpr(expr.source, visit);
    for (const arg of expr.args) walkExpr(arg, visit);
  } else if (expr.t === "range") {
    walkExpr(expr.from, visit);
    walkExpr(expr.to, visit);
  } else if (expr.t === "variable") {
    for (const segment of expr.path) {
      if (segment.kind === "index" && segment.index) walkExpr(segment.index, visit);
    }
  }
}

function walkCondition(condition: Condition, visit: (expr: Expr) => void): void {
  switch (condition.t) {
    case "value":
      walkExpr(condition.expr, visit);
      return;
    case "compare":
      walkExpr(condition.left, visit);
      walkExpr(condition.right, visit);
      return;
    default:
      walkCondition(condition.left, visit);
      walkCondition(condition.right, visit);
  }
}

function walkNodes(nodes: Node[], visit: (node: Node) => void): void {
  for (const node of nodes) {
    visit(node);
    switch (node.t) {
      case "if":
        for (const branch of node.branches) walkNodes(branch.body, visit);
        if (node.otherwise) walkNodes(node.otherwise, visit);
        break;
      case "unless":
        walkNodes(node.body, visit);
        if (node.otherwise) walkNodes(node.otherwise, visit);
        break;
      case "for":
        walkNodes(node.body, visit);
        if (node.otherwise) walkNodes(node.otherwise, visit);
        break;
      default:
        break;
    }
  }
}

function collectFilters(nodes: Node[]): string[] {
  const names: string[] = [];
  const visitExpr = (expr: Expr): void => {
    if (expr.t === "filter" && !names.includes(expr.name)) names.push(expr.name);
  };
  walkNodes(nodes, (node) => {
    if (node.t === "output") walkExpr(node.expr, visitExpr);
    else if (node.t === "assign") walkExpr(node.expr, visitExpr);
    else if (node.t === "if") for (const b of node.branches) walkCondition(b.condition, visitExpr);
    else if (node.t === "unless") walkCondition(node.condition, visitExpr);
    else if (node.t === "for") walkExpr(node.source, visitExpr);
  });
  return names;
}

function collectVariables(nodes: Node[], referenced: Set<string>, bound: Set<string>): void {
  const visitExpr = (expr: Expr): void => {
    if (expr.t === "variable") referenced.add(expr.root);
  };
  walkNodes(nodes, (node) => {
    switch (node.t) {
      case "output":
        walkExpr(node.expr, visitExpr);
        break;
      case "assign":
        bound.add(node.target);
        walkExpr(node.expr, visitExpr);
        break;
      case "if":
        for (const branch of node.branches) walkCondition(branch.condition, visitExpr);
        break;
      case "unless":
        walkCondition(node.condition, visitExpr);
        break;
      case "for":
        bound.add(node.variable);
        walkExpr(node.source, visitExpr);
        break;
      default:
        break;
    }
  });
}

function whitespaceControlMarkers(source: string): string[] {
  const markers: string[] = [];
  const pattern = /\{\{-|\{%-|-\}\}|-%\}/gu;
  for (const match of source.matchAll(pattern)) {
    const marker = match[0];
    if (markers.includes(marker)) continue;
    if (marker === "{{-" || marker === "{%-") {
      markers.push(marker);
      continue;
    }
    if (new RegExp(`(\\{\\{|\\{%)(?:(?!\\}\\}|%\\}).)*?${escapeRegExp(marker)}`, "su").test(source)) {
      markers.push(marker);
    }
  }
  return markers;
}

function unknownTagNames(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/\{%-?\s*([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    const name = match[1] as string;
    if (!KNOWN_TAGS.has(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function regexVariables(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\{\{-?\s*([A-Za-z_][A-Za-z0-9_]*)/gu)) {
    names.add(match[1] as string);
  }
  for (const match of source.matchAll(
    /\{%-?\s*(?:if|unless|elsif)\s+([A-Za-z_][A-Za-z0-9_]*)|\{%-?\s*for\s+\w+\s+in\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
  )) {
    const name = match[1] ?? match[2];
    if (name) names.add(name);
  }
  return [...names]
    .filter((name) => !BUILTIN_VARIABLES.has(name) && !LITERAL_WORDS.has(name))
    .sort();
}
