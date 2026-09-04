import {
  MissingVariableError,
  NoTemplateError,
  NotReadyError,
  UnknownPromptError,
  UnknownUseCaseError,
  UnresolvedError,
  ApiError,
} from "./errors.js";
import { resolveConfig, type PromptOnOptions, type ResolvedConfig } from "./config.js";
import { errorMessage, parseJson, request, retryAfterMs, TransportError } from "./http.js";
import {
  LogBuffer,
  type BufferStats,
  type FlushResult,
  type RejectedRecord,
  type SendResult,
} from "./buffer.js";
import {
  buildRecord,
  classifyError,
  completeRecord,
  logId,
  type LogMeta,
  type ResultLike,
} from "./generation.js";
import { applyPayloadPolicy, type LogRecord } from "./payload.js";
import {
  DEFAULT_PROMPT,
  promptNamesFromSnapshot,
  resolveFromSnapshot,
  type Resolution,
} from "./resolver.js";
import { decodeUseCaseDocument, type PayloadPolicy } from "./snapshotData.js";
import { SnapshotManager, type RefreshResult } from "./snapshot.js";
import { SnapshotStore, writeUseCaseDocumentFile, type UseCasesInfo } from "./store.js";
import { render as renderTemplate, renderMessages, type Message } from "./template.js";
import { textOf } from "./json.js";
import { throttled, type Logger } from "./logger.js";
import { VERSION } from "./version.js";

/** Options for {@link PromptOn.useCase}. */
export interface UseCaseOptions {
  /** Which prompt name to use. Default `default`. */
  prompt?: string;
}

/** Options for {@link PromptOn.filledPrompt}. */
export interface FilledPromptOptions extends UseCaseOptions {
  /** Variables to render the pinned prompt with, locally. */
  variables?: Record<string, unknown> | null;
}

/** What the prompt endpoint answered, plus the locally rendered prompt. */
export interface FilledPrompt {
  key: string;
  kind: string;
  deployment: { id: string | null; revision: number | null };
  prompt: string | null;
  promptNames: string[];
  modelId: string | null;
  model: string | null;
  provider: string | null;
  params: Record<string, unknown>;
  providerOptions: Record<string, unknown>;
  promptVersion: { id: string; number: number | null } | null;
  messages: Message[] | null;
  text: string | null;
  warnings: unknown[];
  etag: string | null;
  source: string | null;
}

/** Options for {@link PromptOn.log}. */
export interface LogOptions {
  /** The use case this log used; fills in the deployment and prompt evidence. */
  useCase?: UseCase | null;
  /** Override the payload policy; by default the use case's policy from the document is used. */
  policy?: PayloadPolicy | null;
}

export class UseCase {
  private currentResolution: Resolution;

  constructor(
    initial: Resolution,
    private readonly selectPrompt: (prompt: string) => Resolution,
    private readonly trackPrompt: <T>(
      current: Resolution,
      meta: LogMeta,
      call: () => T | Promise<T>,
      extractResult: (result: T) => ResultLike | null,
    ) => Promise<T>,
  ) {
    this.currentResolution = initial;
  }

  get key(): string {
    return this.currentResolution.useCase;
  }

  get kind(): string {
    return this.currentResolution.kind;
  }

  get model(): string | null {
    return this.currentResolution.model;
  }

  get modelId(): string | null {
    return this.currentResolution.modelId;
  }

  get provider(): string | null {
    return this.currentResolution.provider;
  }

  get params(): Record<string, unknown> {
    return this.currentResolution.params;
  }

  get providerOptions(): Record<string, unknown> {
    return this.currentResolution.providerOptions;
  }

  get deployment(): { id: string | null; revision: number | null } {
    return {
      id: this.currentResolution.deploymentId,
      revision: this.currentResolution.deploymentRevision,
    };
  }

  get prompt(): string | null {
    return this.currentResolution.prompt;
  }

  get promptVersion(): { id: string; number: number | null } | null {
    if (this.currentResolution.promptVersionId === null) return null;
    return {
      id: this.currentResolution.promptVersionId,
      number: this.currentResolution.promptVersionNumber,
    };
  }

  get promptNames(): string[] {
    return this.currentResolution.availablePrompts;
  }

  get source(): Resolution["source"] {
    return this.currentResolution.source;
  }

  messages(variables?: Record<string, unknown> | null, options: UseCaseOptions = {}): Message[] {
    const resolution = this.selected(options.prompt);
    if (resolution.kind !== "chat" || !resolution.messages) {
      throw new NoTemplateError(resolution.useCase);
    }
    const messages = renderMessages(resolution.messages, variables ?? {}, resolution.engine ?? "liquid");
    this.commit(resolution);
    return messages;
  }

  text(variables?: Record<string, unknown> | null, options: UseCaseOptions = {}): string {
    const resolution = this.selected(options.prompt);
    if (resolution.kind !== "text" || typeof resolution.textTemplate !== "string") {
      throw new NoTemplateError(resolution.useCase);
    }
    const text = renderTemplate(resolution.textTemplate, variables ?? {}, resolution.engine ?? "liquid");
    this.commit(resolution);
    return text;
  }

  track<T>(
    call: () => T | Promise<T>,
    meta: LogMeta = {},
    extractResult: (result: T) => ResultLike | null = defaultResult,
  ): Promise<T> {
    return this.trackPrompt(this.currentResolution, meta, call, extractResult);
  }

  private selected(prompt?: string): Resolution {
    if (prompt === undefined || prompt === this.currentResolution.prompt) return this.currentResolution;
    return this.selectPrompt(prompt);
  }

  private commit(resolution: Resolution): void {
    this.currentResolution = resolution;
  }
}

/**
 * What we know about one `(environment, use case, prompt)` key: the last answer, when it was
 * fetched, and — after a `429`, a `5xx` or an unreachable server — the instant before which we
 * must not contact the server again.
 */
interface ResolveState {
  value: FilledPrompt | null;
  fetchedAt: number;
  nextAllowedAt: number;
  failures: number;
  lastError: unknown;
  inFlight: Promise<FilledPrompt> | null;
}

/** Exponential backoff ×2 from the cache TTL, capped at five minutes. */
const RESOLVE_BACKOFF_CAP_MS = 300_000;

/**
 * One `beforeExit` listener for the whole process, however many clients exist. Registering one
 * per client trips Node's `MaxListenersExceededWarning` at eleven and reads like a leak.
 */
const exitFlushers = new Set<() => void>();
let exitHandlerInstalled = false;

function runExitFlushers(): void {
  for (const flush of exitFlushers) flush();
}

function addExitFlusher(flush: () => void): void {
  exitFlushers.add(flush);
  if (!exitHandlerInstalled) {
    exitHandlerInstalled = true;
    process.once("beforeExit", runExitFlushers);
  }
}

function removeExitFlusher(flush: () => void): void {
  exitFlushers.delete(flush);
  if (exitFlushers.size === 0 && exitHandlerInstalled) {
    exitHandlerInstalled = false;
    process.removeListener("beforeExit", runExitFlushers);
  }
}

/**
 * The SDK.
 *
 * One instance holds one environment's use-case document and one monitoring-log buffer. Construction is
 * synchronous and never blocks: the disk cache and the bundle are read on the spot, and the first
 * network fetch happens in the background.
 */
export class PromptOn {
  /** The configuration in force, with every default filled in. */
  readonly config: ResolvedConfig;
  /** The SDK version, as sent in `sdk.version` and the `User-Agent`. */
  static readonly version = VERSION;

  private readonly store = new SnapshotStore();
  private readonly snapshots: SnapshotManager;
  private readonly buffer: LogBuffer;
  private readonly resolveCache = new Map<string, ResolveState>();
  private readonly captured: LogRecord[] = [];
  private readonly quiet: Logger;
  private readyPromise: Promise<RefreshResult> | null = null;
  private exitHandler: (() => void) | null = null;
  private closed = false;

  constructor(options: PromptOnOptions = {}) {
    this.config = resolveConfig(options);
    this.quiet = throttled(this.config.logger, 60_000);
    this.snapshots = new SnapshotManager(this.config, this.store);
    this.buffer = new LogBuffer((records) => this.sendBatch(records), {
      ...this.config.log,
      logger: this.config.logger,
    });

    this.snapshots.loadLocal();

    if (this.config.mode === "live" && this.config.apiKey === null) {
      this.config.logger.warn(
        "no API key (set PTN_API_KEY or pass apiKey): running from the disk cache and the bundled use-case document only, with no remote calls",
      );
    }

    if (this.snapshots.remoteEnabled) {
      this.readyPromise = this.snapshots.refresh({
        timeoutMs: this.config.initialFetchTimeoutMs,
      });
      this.readyPromise.catch(() => undefined);
      this.snapshots.start();
    }

    if (this.config.flushOnExit && this.config.mode !== "test") {
      this.exitHandler = () => {
        void this.buffer.flush(2000).catch(() => undefined);
      };
      addExitFlusher(this.exitHandler);
    }
  }

  // -------------------------------------------------------------------------
  // configuration

  /**
   * Waits for the first use-case document fetch to finish. Optional — lookup works from the disk cache
   * or the bundle without it — but a short-lived script wants it.
   */
  async ready(): Promise<RefreshResult> {
    return (
      this.readyPromise ??
      Promise.resolve<RefreshResult>({ status: "skipped", reason: "no remote configured" })
    );
  }

  // -------------------------------------------------------------------------
  // use-case lookup

  /**
   * Resolves a use case from the cached use-case document. Synchronous and allocation-cheap: this is the
   * call that sits in the request path.
   *
   * Within the cache TTL nothing is fetched. Past it, a background refresh starts and this call
   * still answers from the document it already has.
   */
  useCase(useCase: string, options: UseCaseOptions = {}): UseCase {
    return new UseCase(
      this.useCaseFromDocument(useCase, options),
      (prompt) => this.useCaseFromDocument(useCase, { prompt }),
      (current, meta, call, extractResult) =>
        this.trackUseCase(current, meta, call, extractResult),
    );
  }

  private useCaseFromDocument(useCase: string, options: UseCaseOptions = {}): Resolution {
    this.snapshots.ensureFresh();
    const entry = this.store.get();
    if (!entry) {
      throw new NotReadyError(
        `no use-case document for environment ${this.config.environment}: PromptOn is unreachable and nothing is cached on disk or bundled`,
      );
    }
    return resolveFromSnapshot(entry.data, useCase, {
      prompt: options.prompt ?? DEFAULT_PROMPT,
      source: entry.source,
      etag: entry.etag,
    });
  }

  /** The prompt names the live deployment pins, sorted. */
  promptNames(useCase: string): string[] {
    const entry = this.store.get();
    if (!entry) throw new NotReadyError("no use-case document is cached yet");
    return promptNamesFromSnapshot(entry.data, useCase);
  }

  /**
   * The prompt endpoint: the simple path and the smoke test. One round trip per call, so it belongs in
   * a low-traffic path or a start-up check, never in a hot loop — {@link useCase} is that path.
   *
   * The server is asked for the raw template and the answer is cached for the same TTL as the
   * use-case document, so repeated calls with different variables cost one request; rendering happens
   * locally. On `429`, `5xx` or an unreachable server the cached answer is served, and the server
   * is left alone until `Retry-After` — or, absent that, an exponential backoff ×2 from the cache
   * TTL capped at five minutes — has elapsed.
   */
  async filledPrompt(
    useCase: string,
    options: FilledPromptOptions = {},
  ): Promise<FilledPrompt> {
    const prompt = options.prompt ?? DEFAULT_PROMPT;
    const value = await this.cachedResolve(useCase, prompt);

    if (options.variables === undefined || options.variables === null) return value;
    const rendered: FilledPrompt = { ...value };
    if (value.messages) rendered.messages = renderMessages(value.messages, options.variables);
    if (typeof value.text === "string") rendered.text = renderTemplate(value.text, options.variables);
    return rendered;
  }

  /**
   * The caching and rate-limiting half of {@link filledPrompt}: at most one request per TTL per
   * key, at most one in flight per key, and no request at all while the server has told us to
   * wait.
   */
  private async cachedResolve(useCase: string, prompt: string): Promise<FilledPrompt> {
    const key = `${this.config.environment}|${useCase}|${prompt}`;
    const state = this.resolveCache.get(key);
    const now = Date.now();

    if (state?.value && now - state.fetchedAt < this.config.cacheTtlMs) return state.value;
    if (state?.inFlight) return state.inFlight;
    if (state && now < state.nextAllowedAt) {
      if (state.value) {
        this.quiet.warn(
          `prompt endpoint is paused for ${String(Math.ceil((state.nextAllowedAt - now) / 1000))}s, serving the cached answer for ${useCase}`,
        );
        return state.value;
      }
      throw state.lastError;
    }

    const entry: ResolveState = {
      value: state?.value ?? null,
      fetchedAt: state?.fetchedAt ?? 0,
      nextAllowedAt: state?.nextAllowedAt ?? 0,
      failures: state?.failures ?? 0,
      lastError: state?.lastError,
      inFlight: null,
    };
    const pending = this.fetchInto(entry, useCase, prompt);
    entry.inFlight = pending;
    this.resolveCache.set(key, entry);
    return pending;
  }

  /**
   * The one request. Updates `entry` in place — it is the map's own object — so a concurrent
   * caller awaiting `entry.inFlight` sees exactly what the caller that started the request sees,
   * cached fallback included.
   */
  private async fetchInto(
    entry: ResolveState,
    useCase: string,
    prompt: string,
  ): Promise<FilledPrompt> {
    try {
      const value = await this.fetchResolve(useCase, prompt);
      entry.value = value;
      entry.fetchedAt = Date.now();
      entry.nextAllowedAt = 0;
      entry.failures = 0;
      entry.lastError = null;
      return value;
    } catch (error) {
      if (!isTransient(error)) throw error;
      const wait = Math.min(
        retryAfterOf(error) ?? this.config.cacheTtlMs * 2 ** Math.min(entry.failures, 20),
        RESOLVE_BACKOFF_CAP_MS,
      );
      entry.failures += 1;
      entry.nextAllowedAt = Date.now() + wait;
      entry.lastError = error;
      if (entry.value) {
        this.quiet.warn(
          `prompt endpoint failed (${describeError(error)}), serving the cached answer for ${useCase} and retrying in ${String(Math.round(wait / 1000))}s`,
        );
        return entry.value;
      }
      throw error;
    } finally {
      entry.inFlight = null;
    }
  }

  private async fetchResolve(useCase: string, prompt: string): Promise<FilledPrompt> {
    if (this.config.mode !== "live" || this.config.apiKey === null) {
      throw new NotReadyError(
        `prompt endpoint needs an API key and live mode (mode is ${this.config.mode})`,
      );
    }
    const response = await request(this.config, {
      method: "POST",
      path: `/use-cases/${encodeURIComponent(useCase)}/prompt`,
      body: JSON.stringify({
        environment: this.config.environment,
        prompt,
      }),
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (response.status === 200) {
      const body = parseJson(response.text);
      if (!body || typeof body !== "object") {
        throw new ApiError(200, "prompt endpoint returned an unreadable body", response.text);
      }
      return mapFilledPrompt(body as Record<string, unknown>);
    }

    const details = errorDetails(response.text);
    if (response.status === 404) {
      const reason = details["reason"];
      if (reason === "unresolved") {
        throw new UnresolvedError(typeof details["key"] === "string" ? details["key"] : useCase);
      }
      if (reason === "unknown_prompt") {
        throw new UnknownPromptError(
          typeof details["key"] === "string" ? details["key"] : useCase,
          typeof details["prompt"] === "string" ? details["prompt"] : prompt,
          Array.isArray(details["prompt_names"]) ? (details["prompt_names"] as string[]) : [],
        );
      }
      if (reason === "unknown_use_case" || typeof details["key"] === "string") {
        throw new UnknownUseCaseError(typeof details["key"] === "string" ? details["key"] : useCase);
      }
    }
    if (response.status === 400 && typeof details["missing_variable"] === "string") {
      throw new MissingVariableError(details["missing_variable"]);
    }
    throw new ApiError(
      response.status,
      errorMessage(response),
      parseJson(response.text),
      retryAfterMs(response),
    );
  }

  // -------------------------------------------------------------------------
  // monitoring logs

  /** A pre-issued UUIDv7, for an app that wants the id before the call. */
  logId(): string {
    return logId();
  }

  /**
   * Queues one monitoring-log record the app built itself and returns at once.
   *
   * Fills in `id`, `started_at`, `sdk` and, when a use case is passed, the deployment and prompt
   * evidence; then applies the use case's payload policy.
   *
   * **Never throws.** A record the server would reject — a missing `status`, a value that will not
   * encode — is dropped, counted in `stats().droppedInvalid` and warned about once, because a
   * monitoring log must not turn a successful generation into a failed request. Pass
   * `strictRecords: true` to raise {@link InvalidRecordError} instead, which is what a test wants.
   */
  log(record: LogRecord, options: LogOptions = {}): void {
    this.safely(this.config.strictRecords, () => {
      const useCaseResolution =
        options.useCase === undefined || options.useCase === null
          ? null
          : (options.useCase as unknown as { currentResolution: Resolution }).currentResolution;
      const complete = completeRecord({ ...record }, useCaseResolution);
      const policy =
        options.policy ??
        useCaseResolution?.payloadPolicy ??
        this.policyFor(complete["use_case"]);
      this.enqueue(complete, policy);
    });
  }

  /**
   * Times a provider call and logs it.
   *
   * Runs `call`, measures the latency, builds the record from the use case and the result, and
   * queues it. Whatever `call` returns is returned unchanged; whatever it throws is logged as an
   * error record and then rethrown unchanged.
   *
   * The logging half never throws, `strictRecords` or not: an exception raised while building the
   * record would replace the provider's own, which is the one the caller needs to see.
   */
  private async trackUseCase<T>(
    resolution: Resolution,
    meta: LogMeta,
    call: () => T | Promise<T>,
    extractResult: (result: T) => ResultLike | null = defaultResult,
  ): Promise<T> {
    const id = meta.id ?? logId();
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();

    try {
      const result = await call();
      const latencyMs = elapsedMs(startedNs);
      let providerResult: ResultLike | null = null;
      try {
        providerResult = extractResult(result);
      } catch (error) {
        this.config.logger.warn(`result extractor threw: ${(error as Error).message}`);
      }
      this.safely(false, () => {
        this.enqueue(
          buildRecord({
            resolution,
            meta,
            id,
            startedAt,
            latencyMs,
            status: "ok",
            result: providerResult,
            error: null,
          }),
          resolution.payloadPolicy,
        );
      });
      return result;
    } catch (error) {
      const latencyMs = elapsedMs(startedNs);
      this.safely(false, () => {
        this.enqueue(
          buildRecord({
            resolution,
            meta,
            id,
            startedAt,
            latencyMs,
            status: "error",
            result: null,
            error: classifyError(error),
          }),
          resolution.payloadPolicy,
        );
      });
      throw error;
    }
  }

  /** Sends everything queued and waits for the result. */
  async flush(timeoutMs = 5000): Promise<FlushResult> {
    if (this.config.mode === "test") {
      return { ...this.buffer.snapshot(), pending: 0 };
    }
    return this.buffer.flush(timeoutMs);
  }

  /** Buffer counters, for a health endpoint or an assertion. */
  stats(): BufferStats {
    return this.buffer.snapshot();
  }

  /** In test mode, every record that would have been sent, in order. */
  get logs(): readonly LogRecord[] {
    return this.captured;
  }

  /** Forgets the captured test-mode records. */
  clearLogs(): void {
    this.captured.length = 0;
  }

  // -------------------------------------------------------------------------
  // use-case document plumbing

  /** Where the current use-case document came from and how old it is. */
  useCasesInfo(): UseCasesInfo {
    return this.store.info();
  }

  /** Fetches a use-case document once, now, and waits for it. Never throws. */
  async refresh(options: { timeoutMs?: number } = {}): Promise<RefreshResult> {
    if (this.config.mode === "offline") {
      this.snapshots.reloadLocal();
      return { status: "skipped", reason: "offline mode reloaded the local use-case document" };
    }
    return this.snapshots.refresh(options);
  }

  /**
   * Installs a use-case document by hand — for tests, and for a process that ships its
   * configuration some other way. Recorded as `source: "manual"`.
   */
  loadUseCases(document: unknown, source: "manual" | "bundle" | "disk" = "manual"): void {
    const raw = typeof document === "string" ? document : JSON.stringify(document);
    const decoded = decodeUseCaseDocument(typeof document === "string" ? JSON.parse(document) : document);
    this.store.set({
      data: decoded.data,
      raw,
      etag: null,
      lastModified: null,
      source,
      fetchedAt: Date.now(),
      staleSince: null,
    });
  }

  /**
   * Writes the current use-case document to a file, so it can be committed as the bundle a cold start falls
   * back to. The bytes are exactly what the server sent, so the ETag still matches.
   */
  exportUseCases(path: string): void {
    const entry = this.store.get();
    if (!entry) throw new NotReadyError("there is no use-case document to export yet");
    writeUseCaseDocumentFile(path, entry.raw, {
      etag: entry.etag,
      last_modified: entry.lastModified,
      environment: entry.data.environment,
      project: entry.data.project,
      fetched_at: new Date(entry.fetchedAt).toISOString(),
    });
  }

  /** Stops the poll timer and the buffer timer, then flushes what is queued. */
  async close(timeoutMs = 5000): Promise<FlushResult> {
    if (this.closed) return { ...this.buffer.snapshot(), pending: this.buffer.pending };
    this.closed = true;
    this.snapshots.stop();
    if (this.exitHandler) {
      removeExitFlusher(this.exitHandler);
      this.exitHandler = null;
    }
    const result = await this.flush(timeoutMs);
    this.buffer.stop();
    return result;
  }

  // -------------------------------------------------------------------------

  private policyFor(useCase: unknown): PayloadPolicy | null {
    if (typeof useCase !== "string") return null;
    const entry = this.store.get();
    return entry?.data.useCases[useCase]?.payloadPolicy ?? null;
  }

  /**
   * Runs the monitoring-log path and swallows whatever it throws, so a bad record costs a counter
   * and a warning rather than the caller's request. `strict` re-raises, for tests.
   */
  private safely(strict: boolean, work: () => void): void {
    try {
      work();
    } catch (error) {
      if (strict) throw error;
      this.buffer.countInvalid();
      this.quiet.warn(`dropped a monitoring log: ${describeError(error)}`);
    }
  }

  private enqueue(record: LogRecord, policy: PayloadPolicy | null): void {
    const final = applyPayloadPolicy(record, policy, {
      payloadDefaults: this.config.payloadDefaults,
      hashEndUser: this.config.hashEndUser,
      redact: this.config.redact,
      logger: this.config.logger,
    });
    if (this.config.mode === "test") {
      this.captured.push(final);
      return;
    }
    this.buffer.enqueue(final);
  }

  private async sendBatch(records: LogRecord[]): Promise<SendResult> {
    if (this.config.mode !== "live" || this.config.apiKey === null) {
      return { kind: "drop", reason: "no API key: monitoring logs cannot be sent" };
    }
    let response;
    try {
      response = await request(this.config, {
        method: "POST",
        path: "/logs",
        query: { environment: this.config.environment },
        body: JSON.stringify({ logs: records }),
        timeoutMs: this.config.requestTimeoutMs,
      });
    } catch (error) {
      const reason = error instanceof TransportError ? error.message : String(error);
      return { kind: "retry", reason, retryInMs: null };
    }

    if (response.status >= 200 && response.status < 300) {
      const body = parseJson(response.text);
      const record = (body ?? {}) as Record<string, unknown>;
      return {
        kind: "accepted",
        accepted: typeof record["accepted"] === "number" ? record["accepted"] : 0,
        duplicates: typeof record["duplicates"] === "number" ? record["duplicates"] : 0,
        rejected: Array.isArray(record["rejected"]) ? (record["rejected"] as RejectedRecord[]) : [],
      };
    }
    if (response.status === 413) return { kind: "too_large" };
    if (response.status === 429 || response.status >= 500) {
      return {
        kind: "retry",
        reason: `HTTP ${String(response.status)}: ${errorMessage(response)}`,
        retryInMs: retryAfterMs(response),
      };
    }
    return { kind: "drop", reason: `HTTP ${String(response.status)}: ${errorMessage(response)}` };
  }
}

function defaultResult(result: unknown): ResultLike | null {
  if (result === null || result === undefined) return null;
  if (typeof result === "string") return { content: result };
  if (typeof result !== "object") return null;
  return result;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function elapsedMs(startedNs: bigint): number {
  return Number((process.hrtime.bigint() - startedNs) / 1_000_000n);
}

function errorDetails(text: string): Record<string, unknown> {
  const body = parseJson(text);
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const details = (error as Record<string, unknown>)["details"];
      if (details && typeof details === "object") return details as Record<string, unknown>;
    }
  }
  return {};
}

function isTransient(error: unknown): boolean {
  if (error instanceof TransportError) return true;
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500;
  return false;
}

/** How long the server asked us to wait, when it said so. */
function retryAfterOf(error: unknown): number | null {
  return error instanceof ApiError ? error.retryAfterMs : null;
}

function mapFilledPrompt(body: Record<string, unknown>): FilledPrompt {
  const deployment = (body["deployment"] ?? {}) as Record<string, unknown>;
  const version = body["prompt_version"];
  return {
    key: textOf(body["key"]),
    kind: textOf(body["kind"] ?? "chat"),
    deployment: {
      id: typeof deployment["id"] === "string" ? deployment["id"] : null,
      revision: typeof deployment["revision"] === "number" ? deployment["revision"] : null,
    },
    prompt: typeof body["prompt"] === "string" ? body["prompt"] : null,
    promptNames: Array.isArray(body["prompt_names"]) ? (body["prompt_names"] as string[]) : [],
    modelId: typeof body["model_id"] === "string" ? body["model_id"] : null,
    model: typeof body["model"] === "string" ? body["model"] : null,
    provider: typeof body["provider"] === "string" ? body["provider"] : null,
    params: (body["params"] ?? {}) as Record<string, unknown>,
    providerOptions: (body["provider_options"] ?? {}) as Record<string, unknown>,
    promptVersion:
      version && typeof version === "object"
        ? {
            id: textOf((version as Record<string, unknown>)["id"]),
            number:
              typeof (version as Record<string, unknown>)["number"] === "number"
                ? ((version as Record<string, unknown>)["number"] as number)
                : null,
          }
        : null,
    messages: Array.isArray(body["messages"]) ? (body["messages"] as Message[]) : null,
    text: typeof body["text"] === "string" ? body["text"] : null,
    warnings: Array.isArray(body["warnings"]) ? body["warnings"] : [],
    etag: typeof body["etag"] === "string" ? body["etag"] : null,
    source: typeof body["source"] === "string" ? body["source"] : null,
  };
}
