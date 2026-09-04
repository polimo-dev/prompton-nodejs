import { isUtf8 } from "node:buffer";
import { byteLength, canonicalJson, jsonSize, sha256Hex, sha256Prefix32, textOf } from "./json.js";
import type { PayloadPolicy } from "./snapshotData.js";
import type { Logger } from "./logger.js";

/**
 * The payload policy the SDK applies to a monitoring-log record before it is enqueued.
 *
 * The server re-validates with the same rules, but the SDK has to apply them first so the raw text
 * never travels over the network in the first place.
 *
 * Order, and it matters because the steps interact: keep decision, string wrapping, the mode
 * (`none` / `hash` / `full`), the `error.message` cap, `end_user_ref` hashing, then the app's
 * redaction hook last.
 */

/** A record in the shape `POST /logs` accepts. */
export type LogRecord = Record<string, unknown>;

/** The three knobs of a payload policy. */
export interface PolicyInput {
  mode?: string | null;
  sampleRate?: number | null;
  maxBytes?: number | null;
}

/** A policy with every field filled in. */
export interface NormalizedPolicy {
  mode: "full" | "hash" | "none";
  sampleRate: number;
  maxBytes: number;
}

/** Configuration the policy reads beyond the policy itself. */
export interface PayloadOptions {
  payloadDefaults?: Partial<NormalizedPolicy>;
  hashEndUser?: boolean;
  redact?: ((record: LogRecord) => LogRecord | null | undefined) | null;
  logger?: Logger;
}

const ERROR_MESSAGE_MAX = 2048;
const SAMPLE_SCALE = 10000;

/** The policy used when neither the use-case document nor the app supplies one. */
export const DEFAULT_POLICY: NormalizedPolicy = {
  mode: "full",
  sampleRate: 1.0,
  maxBytes: 262144,
};

/** Applies the payload policy to one record and returns the record to send. */
export function applyPayloadPolicy(
  record: LogRecord,
  policy: PolicyInput | PayloadPolicy | null | undefined,
  options: PayloadOptions = {},
): LogRecord {
  const normalized = normalizePolicy(policy, options.payloadDefaults);
  let out = applyMode({ ...record }, normalized);
  out = capErrorMessage(out);
  out = hashEndUserRef(out, options.hashEndUser === true);
  return redact(out, options);
}

/** Fills in a partial policy from the defaults and clamps `sample_rate` to 0..1. */
export function normalizePolicy(
  policy: PolicyInput | PayloadPolicy | null | undefined,
  defaults: Partial<NormalizedPolicy> | undefined,
): NormalizedPolicy {
  const base = { ...DEFAULT_POLICY, ...(defaults ?? {}) };
  const given: PolicyInput = policy ?? {};
  const mode = given.mode ?? base.mode;
  const sampleRate = given.sampleRate ?? base.sampleRate;
  const maxBytes = given.maxBytes ?? base.maxBytes;
  return {
    mode: mode === "hash" || mode === "none" ? mode : "full",
    sampleRate: typeof sampleRate === "number" ? Math.min(1, Math.max(0, sampleRate)) : 1.0,
    maxBytes: typeof maxBytes === "number" && maxBytes > 0 ? Math.trunc(maxBytes) : 262144,
  };
}

/**
 * Whether this record's raw text is kept. Errors and `stop_kind: "length"` always are — an error
 * you cannot see is worse than a storage bill, and a truncated answer is the one you most need the
 * text of. Otherwise the decision is a pure function of the id, so a resend decides the same way
 * and the server reaches the same answer independently.
 */
export function keepPayload(record: LogRecord, sampleRate: number): boolean {
  if (asText(record["status"]) === "error") return true;
  if (asText(record["stop_kind"]) === "length") return true;
  if (sampleRate >= 1.0) return true;
  if (sampleRate <= 0.0) return false;
  return sampleBucket(asText(record["id"]) ?? "") < roundHalfAwayFromZero(sampleRate * SAMPLE_SCALE);
}

/**
 * The sampling bucket 0..9999: the first four bytes of sha256(id) as an unsigned big-endian 32-bit
 * integer, modulo 10000.
 */
export function sampleBucket(id: string): number {
  return sha256Prefix32(id) % SAMPLE_SCALE;
}

// ---------------------------------------------------------------------------
// mode

function applyMode(record: LogRecord, policy: NormalizedPolicy): LogRecord {
  if (policy.mode === "none") return dropPayload(record);
  if (!keepPayload(record, policy.sampleRate)) return dropPayload(record);
  const wrapped = wrapPayload(record);
  return policy.mode === "hash" ? hashPayload(wrapped) : truncatePayload(wrapped, policy.maxBytes);
}

function dropPayload(record: LogRecord): LogRecord {
  const out = { ...record };
  delete out["input"];
  delete out["output"];
  return out;
}

function wrapPayload(record: LogRecord): LogRecord {
  const out = { ...record };
  if (typeof out["input"] === "string") out["input"] = { text: out["input"] };
  if (typeof out["output"] === "string") out["output"] = { content: out["output"] };
  return out;
}

function hashPayload(record: LogRecord): LogRecord {
  const out = { ...record };
  for (const key of ["input", "output"] as const) {
    const value = out[key];
    if (value === undefined || value === null) continue;
    const json = canonicalJson(value);
    out[key] = { sha256: sha256Hex(json), bytes: byteLength(json), hashed: true };
  }
  return out;
}

// ---------------------------------------------------------------------------
// full mode: truncation

function truncatePayload(record: LogRecord, maxBytes: number): LogRecord {
  const out = { ...record };
  if ("input" in out) {
    const truncated = truncateInput(out["input"], maxBytes);
    if (truncated === null || truncated === undefined) delete out["input"];
    else out["input"] = truncated;
  }
  if ("output" in out) {
    const truncated = truncateOutput(out["output"], maxBytes);
    if (truncated === null || truncated === undefined) delete out["output"];
    else out["output"] = truncated;
  }
  return out;
}

function truncateInput(input: unknown, maxBytes: number): unknown {
  if (!isRecord(input)) return input;
  const perMessage = Math.max(Math.trunc(maxBytes / 8), 64);
  const variableLimit = Math.max(Math.trunc(maxBytes / 4), 64);

  const out: Record<string, unknown> = { ...input };
  let truncated = false;

  if (Array.isArray(input["messages"])) {
    const [messages, hit] = truncateMessages(input["messages"], perMessage, maxBytes);
    out["messages"] = messages;
    truncated ||= hit;
  }
  if (typeof input["text"] === "string") {
    const [text, hit] = truncateBytes(input["text"], maxBytes);
    out["text"] = text;
    truncated ||= hit;
  }
  if (input["variables"] !== undefined && input["variables"] !== null) {
    const [variables, hit] = truncateVariables(input["variables"], variableLimit);
    out["variables"] = variables;
    truncated ||= hit;
  }
  if (truncated) out["truncated"] = true;
  return out;
}

function truncateOutput(output: unknown, maxBytes: number): unknown {
  if (!isRecord(output)) return output;
  const limit = Math.max(Math.trunc(maxBytes / 4), 64);
  const out: Record<string, unknown> = { ...output };
  let truncated = false;

  if (typeof output["content"] === "string") {
    const [content, hit] = truncateBytes(output["content"], limit);
    out["content"] = content;
    truncated ||= hit;
  }
  if (Array.isArray(output["tool_calls"])) {
    const [calls, hit] = truncateToolCalls(output["tool_calls"], limit);
    out["tool_calls"] = calls;
    truncated ||= hit;
  }
  if (truncated) out["truncated"] = true;
  return out;
}

function truncateVariables(variables: unknown, limit: number): [unknown, boolean] {
  const json = canonicalJson(variables);
  const size = byteLength(json);
  if (size <= limit) return [variables, false];
  return [{ truncated: true, sha256: sha256Hex(json), bytes: size }, true];
}

function truncateMessages(
  messages: unknown[],
  perMessage: number,
  totalLimit: number,
): [unknown[], boolean] {
  let truncated = false;
  const capped = messages.map((message) => {
    const [next, hit] = truncateMessage(message, perMessage);
    truncated ||= hit;
    return next;
  });
  if (listJsonSize(capped) <= totalLimit) return [capped, truncated];
  return [fitMessages(capped, totalLimit), true];
}

/**
 * Two steps. First the middle messages are emptied into byte-count stubs from the front, stopping
 * as soon as the list fits — the first message (the system prompt) and the last (the newest turn)
 * are always preserved, so a later middle message can survive intact. If stubbing is not enough,
 * the middle is dropped entirely and replaced by one marker message.
 */
function fitMessages(messages: unknown[], limit: number): unknown[] {
  const stubbed = stubMiddle(messages, limit);
  if (listJsonSize(stubbed) <= limit) return stubbed;
  return dropMiddle(messages, limit);
}

function stubMiddle(messages: unknown[], limit: number): unknown[] {
  const count = messages.length;
  let running = listJsonSize(messages);
  return messages.map((message, index) => {
    if (index > 0 && index < count - 1 && running > limit) {
      const stub = markTruncated(
        putMessageContent(message, `…[truncated ${String(messageContentBytes(message))} bytes]…`),
      );
      running = running - jsonSize(message) + jsonSize(stub);
      return stub;
    }
    return message;
  });
}

function dropMiddle(messages: unknown[], limit: number): unknown[] {
  if (messages.length === 0) return [];
  const [first, ...rest] = messages;
  const marker = {
    role: "system",
    content: markerText(rest.length),
    truncated: true,
  };
  const base = listJsonSize([first, marker]);
  if (base <= limit) {
    const keptTail = tailWithin(rest, limit - base);
    const dropped = rest.length - keptTail.length;
    return [first, { ...marker, content: markerText(dropped) }, ...keptTail];
  }
  const smaller = shrinkFirst(first);
  if (canonicalJson(smaller) === canonicalJson(first)) {
    const lastResort = { ...marker, content: markerText(rest.length + 1) };
    return listJsonSize([lastResort]) <= limit ? [lastResort] : [];
  }
  return dropMiddle([smaller, ...rest], limit);
}

function shrinkFirst(message: unknown): unknown {
  const bytes = messageContentBytes(message);
  if (bytes === 0) return minimalMessage(message);
  return truncateMessage(message, Math.trunc(bytes / 2))[0];
}

function minimalMessage(message: unknown): unknown {
  const role = isRecord(message) ? message["role"] : undefined;
  return role === undefined ? { truncated: true } : { role, truncated: true };
}

function tailWithin(messages: unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let left = budget;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const size = jsonSize(messages[index]) + 1;
    if (size > left) break;
    kept.unshift(messages[index]);
    left -= size;
  }
  return kept;
}

function markerText(dropped: number): string {
  return `…[${String(dropped)} messages truncated]…`;
}

function truncateMessage(message: unknown, limit: number): [unknown, boolean] {
  if (!isRecord(message)) return [message, false];
  const content = message["content"];
  if (typeof content === "string") {
    const [next, hit] = truncateBytes(content, limit);
    const out = { ...message, content: next };
    return [hit ? markTruncated(out) : out, hit];
  }
  if (content === null || content === undefined) return [message, false];
  const json = canonicalJson(content);
  if (byteLength(json) <= limit) return [message, false];
  const [next] = truncateBytes(json, limit);
  return [markTruncated({ ...message, content: next }), true];
}

function messageContentBytes(message: unknown): number {
  if (!isRecord(message)) return 0;
  const content = message["content"];
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") return byteLength(content);
  return jsonSize(content);
}

function putMessageContent(message: unknown, content: string): Record<string, unknown> {
  return isRecord(message) ? { ...message, content } : { content };
}

function markTruncated(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value, truncated: true };
}

function truncateToolCalls(calls: unknown[], limit: number): [unknown[], boolean] {
  if (jsonSize(calls) <= limit) return [calls, false];
  const overhead = jsonSize(calls.map((call) => putArguments(call, "")));
  const budget = Math.trunc(Math.max(limit - overhead, 0) / Math.max(calls.length, 1));
  return [shrinkToolCalls(calls, budget, limit), true];
}

function shrinkToolCalls(calls: unknown[], budget: number, limit: number): unknown[] {
  if (budget < 32) return [{ truncated: true, bytes: jsonSize(calls) }];
  const shrunk = calls.map((call) => {
    const args = toolCallArguments(call);
    if (args === null) return call;
    return putArguments(call, truncateBytes(args, budget)[0]);
  });
  if (jsonSize(shrunk) <= limit) return shrunk;
  return shrinkToolCalls(calls, Math.trunc(budget / 2), limit);
}

function toolCallArguments(call: unknown): string | null {
  if (!isRecord(call)) return null;
  const fn = call["function"];
  if (!isRecord(fn)) return null;
  return typeof fn["arguments"] === "string" ? fn["arguments"] : null;
}

function putArguments(call: unknown, args: string): unknown {
  if (toolCallArguments(call) === null) return call;
  const record = call as Record<string, unknown>;
  const fn = record["function"] as Record<string, unknown>;
  return { ...record, function: { ...fn, arguments: args } };
}

/** JSON size of a list: `[a,b,c]` — the elements plus the commas and the brackets. */
function listJsonSize(list: unknown[]): number {
  if (list.length === 0) return 2;
  return list.reduce<number>((total, element) => total + jsonSize(element) + 1, 1);
}

// ---------------------------------------------------------------------------
// string truncation

/**
 * UTF-8-safe truncation that keeps the head and the tail:
 * `<head>\n…[truncated N bytes]…\n<tail>`, where N is `original_bytes - limit`. The budget left
 * after the marker is split 60% head / 40% tail, then each side is trimmed back to a character
 * boundary, so the result is never longer than the cap and never contains a split character.
 */
export function truncateBytes(value: string, limit: number): [string, boolean] {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= limit) return [value, false];

  const marker = `\n…[truncated ${String(buffer.length - limit)} bytes]…\n`;
  const markerBytes = byteLength(marker);
  if (markerBytes > limit) {
    return [trimTrailingPartial(buffer.subarray(0, limit)), true];
  }
  const budget = limit - markerBytes;
  const headBytes = Math.trunc((budget * 6) / 10);
  const tailBytes = budget - headBytes;
  const head = trimTrailingPartial(buffer.subarray(0, headBytes));
  const tail = trimLeadingPartial(buffer.subarray(buffer.length - tailBytes));
  return [head + marker + tail, true];
}

function trimTrailingPartial(buffer: Buffer): string {
  let current = buffer;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (current.length === 0) return "";
    if (isUtf8(current)) return current.toString("utf8");
    current = current.subarray(0, current.length - 1);
  }
  return "";
}

function trimLeadingPartial(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length) {
    const byte = buffer[start] as number;
    if (byte >= 0x80 && byte < 0xc0) start += 1;
    else break;
  }
  return buffer.subarray(start).toString("utf8");
}

// ---------------------------------------------------------------------------
// tail of the pipeline

function capErrorMessage(record: LogRecord): LogRecord {
  const error = record["error"];
  if (!isRecord(error)) return record;
  const message = error["message"];
  if (typeof message !== "string" || byteLength(message) <= ERROR_MESSAGE_MAX) return record;
  const [capped] = truncateBytes(message, ERROR_MESSAGE_MAX);
  return { ...record, error: { ...error, message: capped } };
}

function hashEndUserRef(record: LogRecord, enabled: boolean): LogRecord {
  if (!enabled) return record;
  const ref = record["end_user_ref"];
  if (ref === null || ref === undefined) return record;
  return { ...record, end_user_ref: sha256Hex(textOf(ref)) };
}

function redact(record: LogRecord, options: PayloadOptions): LogRecord {
  const hook = options.redact;
  if (typeof hook !== "function") return record;
  try {
    const result = hook(record);
    if (isRecord(result)) return result;
    options.logger?.warn(
      `redact hook returned ${typeof result}; dropping the payload of this record`,
    );
    return dropPayload(record);
  } catch (error) {
    options.logger?.warn(
      `redact hook threw ${(error as Error).message}; dropping the payload of this record`,
    );
    return dropPayload(record);
  }
}

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Elixir's `round/1` rounds halves away from zero; JavaScript's rounds them up. */
function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
