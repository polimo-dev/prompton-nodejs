/**
 * The official PromptOn SDK for Node.js.
 *
 * PromptOn is the control plane for an app's LLM prompts, and it is config-fetch, not a proxy:
 * this SDK fetches use cases, renders locally, and batches monitoring
 * logs back. Your app calls the provider itself, with its own key and its own HTTP client, and
 * keeps running on the last use cases it received when PromptOn is unreachable.
 *
 * ```ts
 * import { PromptOn } from "prompton-sdk";
 *
 * const prompton = new PromptOn();
 * const useCase = prompton.useCase("greeting");
 * const messages = useCase.messages({ name: "Ada" });
 * ```
 */

export { PromptOn, UseCase } from "./client.js";
export type {
  LogOptions,
  FilledPrompt,
  FilledPromptOptions,
  UseCaseOptions,
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
  ALLOWED_FILTERS,
  ALLOWED_TAGS,
  lint,
  render,
  renderMessages,
  templateVariables,
} from "./template.js";
export type { Engine, LintReason, LintResult, Message, Variables } from "./template.js";

export { decodeUseCaseDocument, decodeUseCaseDocumentJson, SCHEMA_VERSION } from "./snapshotData.js";
export type {
  DecodeResult,
  DecodeWarning,
  InputVariable,
  PayloadPolicy,
  UseCaseDocument,
  UseCaseDeployment,
  UseCaseModel,
  UseCasePromptVersion,
  UseCaseDefinition,
} from "./snapshotData.js";

export {
  applyPayloadPolicy,
  DEFAULT_POLICY,
  keepPayload,
  normalizePolicy,
  sampleBucket,
  truncateBytes,
} from "./payload.js";
export type { LogRecord, NormalizedPolicy, PayloadOptions, PolicyInput } from "./payload.js";

export { isTruncatedStop, normalizeStopKind } from "./stopKind.js";
export type { StopKind } from "./stopKind.js";

export { isUuid, uuidv7, uuidv7Timestamp } from "./uuidv7.js";

export {
  buildRecord,
  classifyError,
  completeRecord,
  ERROR_KINDS,
  logId,
  Result,
  sdkBlock,
} from "./generation.js";
export type {
  ErrorKind,
  LogError,
  LogMeta,
  ResultLike,
} from "./generation.js";

export { backoffMs } from "./buffer.js";
export type { BufferStats, FlushResult, RejectedRecord, SendResult, Sender } from "./buffer.js";

export type { RefreshResult } from "./snapshot.js";
export type { UseCaseDocumentEntry, UseCasesInfo } from "./store.js";
export { loadUseCaseDocumentFile, writeUseCaseDocumentFile } from "./store.js";

export { consoleLogger, silentLogger } from "./logger.js";
export type { Logger } from "./logger.js";

export { SDK_NAME, USER_AGENT, VERSION } from "./version.js";

export { canonicalJson, jsonSize, sha256Hex } from "./json.js";
