import { InvalidRecordError } from "./errors.js";
import type { LogRecord } from "./payload.js";
import type { Resolution } from "./resolver.js";
import { textOf } from "./json.js";
import { normalizeStopKind, type StopKind } from "./stopKind.js";
import type { Message } from "./template.js";
import { uuidv7 } from "./uuidv7.js";
import { SDK_NAME, VERSION } from "./version.js";

/** What a provider call reported back, in the shape the record builder understands. */
export interface ResultLike {
  /** The completion text. */
  content?: string | null;
  /** Tool calls, in the provider's own shape. */
  toolCalls?: unknown[] | null;
  /** The provider's raw finish reason; `stop_kind` is derived from it when absent. */
  finishReason?: string | null;
  /** An already-normalised stop kind, if the caller has one. */
  stopKind?: StopKind | (string & {}) | null;
  /** The model the provider actually served, when it differs from the one requested. */
  modelUsed?: string | null;
  /** The upstream provider a router picked, e.g. `Anthropic`. */
  upstreamProvider?: string | null;
  usage?: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    raw?: unknown;
  } | null;
  costUsd?: number | null;
  costSource?: "provider" | "catalog" | "unknown" | null;
  /** Whether the call used the app's own provider key through a router. */
  isByok?: boolean | null;
}

export class Result implements ResultLike {
  content?: string | null;
  toolCalls?: unknown[] | null;
  finishReason?: string | null;
  stopKind?: StopKind | (string & {}) | null;
  modelUsed?: string | null;
  upstreamProvider?: string | null;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; raw?: unknown } | null;
  costUsd?: number | null;
  costSource?: "provider" | "catalog" | "unknown" | null;
  isByok?: boolean | null;
  result?: unknown;

  constructor(input: ResultLike & { result?: unknown } = {}) {
    Object.assign(this, input);
  }

  static fromOpenAI(answer: unknown): Result {
    const choice = first(get(answer, "choices"));
    const message = get(choice, "message");
    const usage = get(answer, "usage");
    return new Result({
      content: stringOrNull(get(message, "content")),
      toolCalls: arrayOrNull(get(message, "tool_calls")),
      finishReason: stringOrNull(get(choice, "finish_reason")),
      usage: {
        inputTokens: numberOrNull(get(usage, "prompt_tokens") ?? get(usage, "input_tokens")),
        outputTokens: numberOrNull(get(usage, "completion_tokens") ?? get(usage, "output_tokens")),
        raw: usage,
      },
      modelUsed: stringOrNull(get(answer, "model")),
      result: answer,
    });
  }

  static fromAnthropic(answer: unknown): Result {
    const usage = get(answer, "usage");
    return new Result({
      content: anthropicContent(get(answer, "content")),
      finishReason: stringOrNull(get(answer, "stop_reason")),
      usage: {
        inputTokens: numberOrNull(get(usage, "input_tokens")),
        outputTokens: numberOrNull(get(usage, "output_tokens")),
        raw: usage,
      },
      modelUsed: stringOrNull(get(answer, "model")),
      result: answer,
    });
  }

  static fromDecisions(answer: unknown): Result {
    const answers = get(answer, "answers");
    const usage = get(answer, "usage");
    return new Result({
      content: answers === undefined ? null : JSON.stringify(answers, null, 2),
      finishReason: "stop",
      stopKind: "stop",
      usage: {
        inputTokens: numberOrNull(get(usage, "input_tokens")),
        outputTokens: numberOrNull(get(usage, "output_tokens")),
        raw: usage,
      },
      costUsd: numberOrNull(get(usage, "cost")),
      costSource: "provider",
      modelUsed: stringOrNull(get(answer, "model")),
      result: answer,
    });
  }
}

/** Everything about this particular call that is not in the prompt lookup or the result. */
export interface LogMeta {
  /** A pre-issued UUIDv7; one is generated when absent. */
  id?: string;
  /** The variables the prompt was rendered with. */
  variables?: Record<string, unknown> | null;
  /** The final message list sent to the provider, after the app attached any history. */
  inputMessages?: Message[] | Record<string, unknown>[] | null;
  /** The final prompt string, for a text prompt. */
  inputText?: string | null;
  /** The rendered native Decision state and questions sent to the provider. */
  inputDecision?: { state: unknown; questions: Record<string, unknown> } | null;
  /** A stable pseudonymous id for the end user. Never a name or an email. */
  endUserRef?: string | null;
  /** Ties this generation to a job, request or conversation. */
  traceId?: string | null;
  /** Position within a trace. */
  sequence?: number | null;
  /** Free-form tags, at most 2 KB encoded. */
  context?: Record<string, unknown> | null;
  /** Free app keys, at most 4 KB encoded. */
  metadata?: Record<string, unknown> | null;
  /** The params actually used, layered over the resolution's. */
  params?: Record<string, unknown> | null;
}

/** The error kinds the ingest endpoint accepts. */
export const ERROR_KINDS = [
  "http_4xx",
  "http_5xx",
  "rate_limited",
  "timeout",
  "transport",
  "parse",
  "app",
] as const;

/** One of {@link ERROR_KINDS}. */
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** A provider failure, as the record records it. */
export interface LogError {
  kind?: ErrorKind | (string & {});
  status?: number;
  message?: string;
}

const ERROR_KIND_SET = new Set<string>(ERROR_KINDS);

/** The `sdk` block every record carries. */
export function sdkBlock(): { name: string; version: string } {
  return { name: SDK_NAME, version: VERSION };
}

/** A fresh monitoring-log id. UUIDv7, because the server's column is one. */
export function logId(): string {
  return uuidv7();
}

interface BuildInput {
  resolution: Resolution;
  meta: LogMeta;
  id: string;
  startedAt: Date;
  latencyMs: number;
  status: "ok" | "error";
  result: ResultLike | null;
  error: LogError | null;
}

/** Assembles one record in the shape `POST /logs` accepts. */
export function buildRecord(input: BuildInput): LogRecord {
  const { resolution: r, meta, result } = input;
  const usage = result?.usage ?? null;

  const metadata: Record<string, unknown> = { ...(meta.metadata ?? {}) };
  if (result?.isByok !== undefined && result.isByok !== null) {
    metadata["is_byok"] = result.isByok;
  }

  const record: LogRecord = {
    id: input.id,
    prompt_key: r.promptKey,
    deployment_id: r.deploymentId,
    deployment_revision: r.deploymentRevision,
    template: r.template,
    prompt_version_id: r.promptVersionId,
    model_id: r.modelId,
    source: r.source,
    context: { ...(meta.context ?? {}) },
    kind: r.kind,
    model: r.model,
    model_used: result?.modelUsed ?? null,
    provider: r.provider,
    upstream_provider: result?.upstreamProvider ?? null,
    params: { ...r.params, ...(meta.params ?? {}) },
    input: buildInputBlock(meta),
    output: buildOutputBlock(result),
    status: input.status,
    finish_reason: result?.finishReason ?? null,
    stop_kind: deriveStopKind(result),
    error: buildError(input.error),
    usage: {
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      cost_usd: result?.costUsd ?? null,
      cost_source: result?.costSource ?? "unknown",
      raw: usage?.raw ?? null,
    },
    latency_ms: input.latencyMs,
    started_at: input.startedAt.toISOString(),
    trace_id: meta.traceId ?? null,
    sequence: meta.sequence ?? null,
    end_user_ref: meta.endUserRef === null || meta.endUserRef === undefined ? null : String(meta.endUserRef),
    metadata,
    sdk: sdkBlock(),
  };

  return dropNullKeys(record);
}

/**
 * Fills in what the SDK knows and checks the five fields the server requires.
 *
 * Throws {@link InvalidRecordError} when one is missing — a record the server would reject with
 * nothing but an index to say why is worse than an exception at the call site.
 */
export function completeRecord(
  record: LogRecord,
  resolution: Resolution | null,
): LogRecord {
  const out: LogRecord = { ...record };
  out["id"] ??= logId();
  out["started_at"] ??= new Date().toISOString();
  out["sdk"] ??= sdkBlock();

  if (resolution) {
    out["prompt_key"] ??= resolution.promptKey;
    out["kind"] ??= resolution.kind;
    out["model"] ??= resolution.model;
    out["source"] ??= resolution.source;
    if (resolution.deploymentId !== null) out["deployment_id"] ??= resolution.deploymentId;
    if (resolution.deploymentRevision !== null) {
      out["deployment_revision"] ??= resolution.deploymentRevision;
    }
    if (resolution.template !== null) out["template"] ??= resolution.template;
    if (resolution.promptVersionId !== null) {
      out["prompt_version_id"] ??= resolution.promptVersionId;
    }
    if (resolution.modelId !== null) out["model_id"] ??= resolution.modelId;
    if (resolution.provider !== null) out["provider"] ??= resolution.provider;
  }

  for (const field of ["prompt_key", "model", "status", "started_at"]) {
    const value = out[field];
    if (value === null || value === undefined || value === "") {
      throw new InvalidRecordError(`monitoring log is missing the required field ${field}`);
    }
  }
  const status = out["status"];
  if (status !== "ok" && status !== "error") {
    throw new InvalidRecordError(`monitoring log status must be "ok" or "error", got ${String(status)}`);
  }
  return dropNullKeys(out);
}

/** Classifies whatever the app threw into one of the seven ingest error kinds. */
export function classifyError(error: unknown): LogError {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const status = typeof record["status"] === "number" ? record["status"] : undefined;
    const declared = typeof record["kind"] === "string" ? record["kind"] : undefined;
    const message =
      typeof record["message"] === "string" ? record["message"] : textOf(error);
    const name = typeof record["name"] === "string" ? record["name"] : "";

    let kind: ErrorKind;
    if (declared && ERROR_KIND_SET.has(declared)) kind = declared as ErrorKind;
    else if (status === 429) kind = "rate_limited";
    else if (status !== undefined && status >= 500) kind = "http_5xx";
    else if (status !== undefined && status >= 400) kind = "http_4xx";
    else if (name === "TimeoutError" || name === "AbortError") kind = "timeout";
    else if (name === "SyntaxError") kind = "parse";
    else if (name === "TypeError" && /fetch failed|network/iu.test(message)) kind = "transport";
    else kind = "app";

    const out: LogError = { kind, message };
    if (status !== undefined) out.status = status;
    return out;
  }
  return { kind: "app", message: textOf(error) };
}

// ---------------------------------------------------------------------------

function buildInputBlock(meta: LogMeta): Record<string, unknown> | null {
  const input: Record<string, unknown> = {};
  if (meta.variables !== null && meta.variables !== undefined) input["variables"] = meta.variables;
  if (meta.inputMessages !== null && meta.inputMessages !== undefined) {
    input["messages"] = meta.inputMessages;
  }
  if (typeof meta.inputText === "string") input["text"] = meta.inputText;
  if (meta.inputDecision !== null && meta.inputDecision !== undefined) input["decision"] = meta.inputDecision;
  return Object.keys(input).length === 0 ? null : input;
}

function buildOutputBlock(outcome: ResultLike | null): Record<string, unknown> | null {
  if (!outcome) return null;
  const output: Record<string, unknown> = {};
  if (outcome.content !== null && outcome.content !== undefined) output["content"] = outcome.content;
  if (outcome.toolCalls !== null && outcome.toolCalls !== undefined) {
    output["tool_calls"] = outcome.toolCalls;
  }
  return Object.keys(output).length === 0 ? null : output;
}

function buildError(error: LogError | null): Record<string, unknown> | null {
  if (!error) return null;
  const kind = typeof error.kind === "string" && ERROR_KIND_SET.has(error.kind) ? error.kind : "app";
  const out: Record<string, unknown> = { kind };
  if (typeof error.status === "number") out["status"] = error.status;
  if (error.message !== undefined && error.message !== null) out["message"] = textOf(error.message);
  return out;
}

function deriveStopKind(outcome: ResultLike | null): string | null {
  if (!outcome) return null;
  if (outcome.stopKind !== null && outcome.stopKind !== undefined) {
    return normalizeStopKind(outcome.stopKind);
  }
  if (outcome.finishReason !== null && outcome.finishReason !== undefined) {
    return normalizeStopKind(outcome.finishReason);
  }
  return null;
}

/** The SDK omits a top-level key whose value is null; nested nulls inside `usage` are sent. */
function dropNullKeys(record: LogRecord): LogRecord {
  const out: LogRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function get(value: unknown, key: string): unknown {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function first(value: unknown): unknown {
  return Array.isArray(value) && value.length > 0 ? value[0] : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayOrNull(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function anthropicContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") return null;
      const record = block as Record<string, unknown>;
      return (record["type"] === undefined || record["type"] === "text") &&
        typeof record["text"] === "string"
        ? record["text"]
        : null;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join("") : null;
}
