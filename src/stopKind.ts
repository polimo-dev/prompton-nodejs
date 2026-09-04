/** PromptOn's normalised reason a generation stopped. */
export type StopKind = "stop" | "length" | "tool_call" | "content_filter" | "other";

const STOP = new Set(["stop", "end_turn", "stop_sequence"]);
const LENGTH = new Set(["length", "max_tokens"]);
const TOOL_CALL = new Set(["tool_call", "tool_calls", "tool_use"]);
const CONTENT_FILTER = new Set(["content_filter"]);

/**
 * Maps a provider's raw `finish_reason` onto a PromptOn `stop_kind`.
 *
 * Comparison lowercases and trims, so Google's `STOP` and `MAX_TOKENS` land correctly.
 * Normalisation is idempotent — feeding a `stop_kind` back in returns itself — which matters
 * because the server re-normalises whatever the client sent.
 *
 * Two traps: Google's `SAFETY` and `RECITATION` map to `other`, not `content_filter`; and
 * `tool_calls` is not a truncation.
 */
export function normalizeStopKind(reason: unknown): StopKind {
  if (typeof reason !== "string") return "other";
  const value = reason.trim().toLowerCase();
  if (STOP.has(value)) return "stop";
  if (LENGTH.has(value)) return "length";
  if (TOOL_CALL.has(value)) return "tool_call";
  if (CONTENT_FILTER.has(value)) return "content_filter";
  return "other";
}

/**
 * Whether the output was cut off. True only for `length`: the truncation rate, the evaluator and
 * the alerts all depend on that definition, and a tool call is not a truncation.
 */
export function isTruncatedStop(reason: unknown): boolean {
  return normalizeStopKind(reason) === "length";
}
