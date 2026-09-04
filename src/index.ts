/**
 * The official PromptOn SDK for Node.js.
 *
 * PromptOn is the control plane for an app's LLM prompts, and it is config-fetch, not a proxy:
 * this SDK fetches a snapshot of your pins, resolves and renders locally, and batches monitoring
 * logs back. Your app calls the provider itself, with its own key and its own HTTP client, and
 * keeps running on the last snapshot it received when PromptOn is unreachable.
 *
 * ```ts
 * import { PromptOn } from "prompton-sdk";
 *
 * const prompton = new PromptOn();
 * const resolution = prompton.resolve("greeting");
 * const messages = prompton.renderChat(resolution, { name: "Ada" });
 * ```
 */

export { PromptOn } from "./client.js";
export type {
  LogOptions,
  RemoteResolution,
  RemoteResolveOptions,
  ResolveOptions,
} from "./client.js";

export { DEFAULT_HOST, apiBase, defaultCacheDir, projectFromApiKey, resolveConfig } from "./config.js";
export type { LogOptions as LogBufferOptions, Mode, PromptOnOptions, ResolvedConfig } from "./config.js";

export {
  ApiError,
  ConfigError,
  InvalidRecordError,
  MissingVariableError,
  NoTemplateError,
  NotReadyError,
  PromptOnError,
  TemplateParseError,
  TemplateRenderError,
  UnknownPromptError,
  UnknownUseCaseError,
  UnresolvedError,
} from "./errors.js";
export type { PromptOnErrorCode } from "./errors.js";

export { TransportError } from "./http.js";

export {
  DEFAULT_PROMPT,
  mergeParams,
  promptNamesFromSnapshot,
  resolveFromSnapshot,
} from "./resolver.js";
export type { Resolution, ResolutionSource, ResolutionWarning } from "./resolver.js";

export {
  ALLOWED_FILTERS,
  ALLOWED_TAGS,
  lint,
  render,
  renderMessages,
  templateVariables,
} from "./template.js";
export type { Engine, LintReason, LintResult, Message, Variables } from "./template.js";

export { decodeSnapshot, decodeSnapshotJson, SCHEMA_VERSION } from "./snapshotData.js";
export type {
  DecodeResult,
  DecodeWarning,
  InputVariable,
  PayloadPolicy,
  SnapshotData,
  SnapshotDeployment,
  SnapshotModel,
  SnapshotPromptVersion,
  SnapshotUseCase,
} from "./snapshotData.js";

export {
  applyPayloadPolicy,
  DEFAULT_POLICY,
  keepPayload,
  normalizePolicy,
  sampleBucket,
  truncateBytes,
} from "./payload.js";
export type { GenerationRecord, NormalizedPolicy, PayloadOptions, PolicyInput } from "./payload.js";

export { isTruncatedStop, normalizeStopKind } from "./stopKind.js";
export type { StopKind } from "./stopKind.js";

export { isUuid, uuidv7, uuidv7Timestamp } from "./uuidv7.js";

export {
  buildRecord,
  classifyError,
  completeRecord,
  ERROR_KINDS,
  generationId,
  sdkBlock,
} from "./generation.js";
export type {
  ErrorKind,
  GenerationError,
  GenerationMeta,
  ProviderOutcome,
} from "./generation.js";

export { backoffMs } from "./buffer.js";
export type { BufferStats, FlushResult, RejectedRecord, SendOutcome, Sender } from "./buffer.js";

export type { RefreshResult } from "./snapshot.js";
export type { SnapshotEntry, SnapshotInfo } from "./store.js";
export { loadSnapshotFile, writeSnapshotFile } from "./store.js";

export { consoleLogger, silentLogger } from "./logger.js";
export type { Logger } from "./logger.js";

export { SDK_NAME, USER_AGENT, VERSION } from "./version.js";

export { canonicalJson, jsonSize, sha256Hex } from "./json.js";
