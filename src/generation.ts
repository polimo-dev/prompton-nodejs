import { InvalidRecordError } from "./errors.js";
import type { GenerationRecord } from "./payload.js";
import type { Resolution } from "./resolver.js";
import { textOf } from "./json.js";
import { normalizeStopKind, type StopKind } from "./stopKind.js";
import type { Message } from "./template.js";
import { uuidv7 } from "./uuidv7.js";
import { SDK_NAME, VERSION } from "./version.js";

/** What a provider call reported back, in the shape the record builder understands. */
export interface ProviderOutcome {
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

/** Everything about this particular call that is not in the resolution or the outcome. */
export interface GenerationMeta {
  /** A pre-issued UUIDv7; one is generated when absent. */
  id?: string;
  /** The variables the prompt was rendered with. */
  variables?: Record<string, unknown> | null;
  /** The final message list sent to the provider, after the app attached any history. */
  inputMessages?: Message[] | Record<string, unknown>[] | null;
  /** The final prompt string, for a text use case. */
  inputText?: string | null;
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
export interface GenerationError {
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
export function generationId(): string {
  return uuidv7();
}

interface BuildInput {
  resolution: Resolution;
  meta: GenerationMeta;
  id: string;
  startedAt: Date;
  latencyMs: number;
  status: "ok" | "error";
  outcome: ProviderOutcome | null;
  error: GenerationError | null;
}

/** Assembles one record in the shape `POST /generations` accepts. */
export function buildRecord(input: BuildInput): GenerationRecord {
  const { resolution: r, meta, outcome } = input;
  const usage = outcome?.usage ?? null;

  const metadata: Record<string, unknown> = { ...(meta.metadata ?? {}) };
  if (outcome?.isByok !== undefined && outcome.isByok !== null) {
    metadata["is_byok"] = outcome.isByok;
  }

  const record: GenerationRecord = {
    id: input.id,
    use_case: r.useCase,
    deployment_id: r.deploymentId,
    deployment_revision: r.deploymentRevision,
    prompt: r.prompt,
    prompt_version_id: r.promptVersionId,
    model_id: r.modelId,
    resolution_source: r.source,
    context: { ...(meta.context ?? {}) },
    kind: r.kind,
    model: r.model,
    model_used: outcome?.modelUsed ?? null,
    provider: r.provider,
    upstream_provider: outcome?.upstreamProvider ?? null,
    params: { ...r.params, ...(meta.params ?? {}) },
    input: buildInputBlock(meta),
    output: buildOutputBlock(outcome),
    status: input.status,
    finish_reason: outcome?.finishReason ?? null,
    stop_kind: deriveStopKind(outcome),
    error: buildError(input.error),
    usage: {
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      cost_usd: outcome?.costUsd ?? null,
      cost_source: outcome?.costSource ?? "unknown",
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
  record: GenerationRecord,
  resolution: Resolution | null,
): GenerationRecord {
  const out: GenerationRecord = { ...record };
  out["id"] ??= generationId();
  out["started_at"] ??= new Date().toISOString();
  out["sdk"] ??= sdkBlock();

  if (resolution) {
    out["use_case"] ??= resolution.useCase;
    out["kind"] ??= resolution.kind;
    out["model"] ??= resolution.model;
    out["resolution_source"] ??= resolution.source;
    if (resolution.deploymentId !== null) out["deployment_id"] ??= resolution.deploymentId;
    if (resolution.deploymentRevision !== null) {
      out["deployment_revision"] ??= resolution.deploymentRevision;
    }
    if (resolution.prompt !== null) out["prompt"] ??= resolution.prompt;
    if (resolution.promptVersionId !== null) {
      out["prompt_version_id"] ??= resolution.promptVersionId;
    }
    if (resolution.modelId !== null) out["model_id"] ??= resolution.modelId;
    if (resolution.provider !== null) out["provider"] ??= resolution.provider;
  }

  for (const field of ["use_case", "model", "status", "started_at"]) {
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
export function classifyError(error: unknown): GenerationError {
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

    const out: GenerationError = { kind, message };
    if (status !== undefined) out.status = status;
    return out;
  }
  return { kind: "app", message: textOf(error) };
}

// ---------------------------------------------------------------------------

function buildInputBlock(meta: GenerationMeta): Record<string, unknown> | null {
  const input: Record<string, unknown> = {};
  if (meta.variables !== null && meta.variables !== undefined) input["variables"] = meta.variables;
  if (meta.inputMessages !== null && meta.inputMessages !== undefined) {
    input["messages"] = meta.inputMessages;
  }
  if (typeof meta.inputText === "string") input["text"] = meta.inputText;
  return Object.keys(input).length === 0 ? null : input;
}

function buildOutputBlock(outcome: ProviderOutcome | null): Record<string, unknown> | null {
  if (!outcome) return null;
  const output: Record<string, unknown> = {};
  if (outcome.content !== null && outcome.content !== undefined) output["content"] = outcome.content;
  if (outcome.toolCalls !== null && outcome.toolCalls !== undefined) {
    output["tool_calls"] = outcome.toolCalls;
  }
  return Object.keys(output).length === 0 ? null : output;
}

function buildError(error: GenerationError | null): Record<string, unknown> | null {
  if (!error) return null;
  const kind = typeof error.kind === "string" && ERROR_KIND_SET.has(error.kind) ? error.kind : "app";
  const out: Record<string, unknown> = { kind };
  if (typeof error.status === "number") out["status"] = error.status;
  if (error.message !== undefined && error.message !== null) out["message"] = textOf(error.message);
  return out;
}

function deriveStopKind(outcome: ProviderOutcome | null): string | null {
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
function dropNullKeys(record: GenerationRecord): GenerationRecord {
  const out: GenerationRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    out[key] = value;
  }
  return out;
}
