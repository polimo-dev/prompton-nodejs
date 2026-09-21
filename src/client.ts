import {
  MissingVariableError,
  NoTemplateError,
  NotReadyError,
  PreparedRequestError,
  UnknownPromptError,
  UnknownTemplateError,
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
  DEFAULT_TEMPLATE,
  templateNamesFromSnapshot,
  resolvePromptFromSnapshot,
  type Resolution,
} from "./resolver.js";
import { decodePromptDocument, type PayloadPolicy } from "./snapshotData.js";
import { SnapshotManager, type RefreshResult } from "./snapshot.js";
import { SnapshotStore, writePromptDocumentFile, type PromptsInfo } from "./store.js";
import { render as renderTemplate, renderMessages, type Message } from "./template.js";
import type { DecisionTemplate } from "./snapshotData.js";
import { canonicalJson, textOf } from "./json.js";
import { throttled, type Logger } from "./logger.js";
import { VERSION } from "./version.js";

/** Options for {@link PromptOn.prompt}. */
export interface PromptOptions {
  /** Which template name to use. Default `default`. */
  template?: string;
}

/** Options for {@link PromptOn.renderPrompt}. */
export interface RenderPromptOptions extends PromptOptions {
  /** Variables to render the pinned prompt with, on the PromptOn server. */
  variables?: Record<string, unknown> | null;
}

/** What the render endpoint answered, plus the locally rendered prompt. */
export interface RenderedPrompt {
  key: string;
  kind: string;
  deployment: { id: string | null; revision: number | null };
  template: string | null;
  templateNames: string[];
  modelId: string | null;
  model: string | null;
  provider: string | null;
  api: string | null;
  requestPath: string | null;
  request: PreparedRequest | null;
  params: Record<string, unknown>;
  providerOptions: Record<string, unknown>;
  promptVersion: { id: string; number: number | null } | null;
  messages: Message[] | null;
  text: string | null;
  decision: DecisionTemplate | null;
  warnings: unknown[];
  etag: string | null;
  source: string | null;
}

/** Provider request prepared by the SDK. The SDK does not send it. */
export interface PreparedRequest {
  api: "chat_completions" | "decisions";
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

/** Per-call overrides for {@link Prompt.request}. */
export interface PreparedRequestOptions extends PromptOptions {
  /** Parameters layered over deployment params. Chat omits null; Decision metadata must be typed. */
  params?: Record<string, unknown> | null;
  /** Provider routing/options layered over the deployment provider options. */
  providerOptions?: Record<string, unknown> | null;
  /** Decisions-only metadata passed through to the Decisions API. */
  session_id?: string;
  /** Decisions-only trace metadata. */
  trace?: unknown;
  /** Decisions-only user metadata. */
  user?: string;
}

/** Options for {@link PromptOn.log}. */
export interface LogOptions {
  /** The prompt this log used; fills in the deployment and prompt evidence. */
  prompt?: Prompt | null;
  /** Override the payload policy; by default the prompt's policy from the document is used. */
  policy?: PayloadPolicy | null;
}

export class Prompt {
  private currentResolution: Resolution;

  constructor(
    initial: Resolution,
    private readonly selectTemplate: (template: string) => Resolution,
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
    return this.currentResolution.promptKey;
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

  get api(): string | null {
    return this.currentResolution.api;
  }

  get requestPath(): string | null {
    return this.currentResolution.requestPath;
  }

  get deployment(): { id: string | null; revision: number | null } {
    return {
      id: this.currentResolution.deploymentId,
      revision: this.currentResolution.deploymentRevision,
    };
  }

  get template(): string | null {
    return this.currentResolution.template;
  }

  get promptVersion(): { id: string; number: number | null } | null {
    if (this.currentResolution.promptVersionId === null) return null;
    return {
      id: this.currentResolution.promptVersionId,
      number: this.currentResolution.promptVersionNumber,
    };
  }

  get templateNames(): string[] {
    return this.currentResolution.availableTemplates;
  }

  get source(): Resolution["source"] {
    return this.currentResolution.source;
  }

  messages(variables?: Record<string, unknown> | null, options: PromptOptions = {}): Message[] {
    const resolution = this.selected(options.template);
    if (resolution.kind !== "chat" || !resolution.messages) {
      throw new NoTemplateError(resolution.promptKey);
    }
    const messages = renderMessages(resolution.messages, variables ?? {}, resolution.engine ?? "liquid");
    this.commit(resolution);
    return messages;
  }

  text(variables?: Record<string, unknown> | null, options: PromptOptions = {}): string {
    const resolution = this.selected(options.template);
    if (resolution.kind !== "text" || typeof resolution.textTemplate !== "string") {
      throw new NoTemplateError(resolution.promptKey);
    }
    const text = renderTemplate(resolution.textTemplate, variables ?? {}, resolution.engine ?? "liquid");
    this.commit(resolution);
    return text;
  }

  request(
    variables?: Record<string, unknown> | null,
    options: PreparedRequestOptions = {},
  ): PreparedRequest {
    const resolution = this.selected(options.template);
    const request = prepareProviderRequest(resolution, variables ?? {}, options);
    this.commit(resolution);
    return request;
  }

  track<T>(
    call: () => T | Promise<T>,
    meta: LogMeta = {},
    extractResult: (result: T) => ResultLike | null = defaultResult,
  ): Promise<T> {
    return this.trackPrompt(this.currentResolution, meta, call, extractResult);
  }

  private selected(template?: string): Resolution {
    if (template === undefined || template === this.currentResolution.template) return this.currentResolution;
    return this.selectTemplate(template);
  }

  private commit(resolution: Resolution): void {
    this.currentResolution = resolution;
  }
}

/**
 * What we know about one `(environment, prompt, prompt)` key: the last answer, when it was
 * fetched, and — after a `429`, a `5xx` or an unreachable server — the instant before which we
 * must not contact the server again.
 */
interface ResolveState {
  value: RenderedPrompt | null;
  fetchedAt: number;
  nextAllowedAt: number;
  failures: number;
  lastError: unknown;
  inFlight: Promise<RenderedPrompt> | null;
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
 * One instance holds one environment's prompt document and one monitoring-log buffer. Construction is
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
        "no API key (set PTN_API_KEY or pass apiKey): running from the disk cache and the bundled prompt document only, with no remote calls",
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
   * Waits for the first prompt document fetch to finish. Optional — lookup works from the disk cache
   * or the bundle without it — but a short-lived script wants it.
   */
  async ready(): Promise<RefreshResult> {
    return (
      this.readyPromise ??
      Promise.resolve<RefreshResult>({ status: "skipped", reason: "no remote configured" })
    );
  }

  // -------------------------------------------------------------------------
  // prompt lookup

  /**
   * Resolves a prompt from the cached prompt document. Synchronous and allocation-cheap: this is the
   * call that sits in the request path.
   *
   * Within the cache TTL nothing is fetched. Past it, a background refresh starts and this call
   * still answers from the document it already has.
   */
  prompt(prompt: string, options: PromptOptions = {}): Prompt {
    return new Prompt(
      this.promptFromDocument(prompt, options),
      (template) => this.promptFromDocument(prompt, { template }),
      (current, meta, call, extractResult) =>
        this.trackPrompt(current, meta, call, extractResult),
    );
  }

  private promptFromDocument(prompt: string, options: PromptOptions = {}): Resolution {
    this.snapshots.ensureFresh();
    const entry = this.store.get();
    if (!entry) {
      throw new NotReadyError(
        `no prompt document for environment ${this.config.environment}: PromptOn is unreachable and nothing is cached on disk or bundled`,
      );
    }
    return resolvePromptFromSnapshot(entry.data, prompt, {
      template: options.template ?? DEFAULT_TEMPLATE,
      source: entry.source,
      etag: entry.etag,
    });
  }

  /** The template names the live deployment pins, sorted. */
  templateNames(prompt: string): string[] {
    const entry = this.store.get();
    if (!entry) throw new NotReadyError("no prompt document is cached yet");
    return templateNamesFromSnapshot(entry.data, prompt);
  }

  /**
   * The prompt endpoint: the simple path and the smoke test. One round trip per call, so it belongs in
   * a low-traffic path or a start-up check, never in a hot loop — {@link prompt} is that path.
   *
   * The server is asked for the raw template when variables are absent, or for the rendered prompt
   * when variables are present. Answers are cached for the same TTL as the prompt document per
   * `(environment, prompt, template, variables)` key. On `429`, `5xx` or an unreachable server the
   * matching cached answer is served, and the server is left alone until `Retry-After` — or, absent
   * that, an exponential backoff ×2 from the cache TTL capped at five minutes — has elapsed.
   */
  async renderPrompt(
    prompt: string,
    options: RenderPromptOptions = {},
  ): Promise<RenderedPrompt> {
    const template = options.template ?? DEFAULT_TEMPLATE;
    return this.cachedResolve(prompt, template, options.variables);
  }

  /**
   * The caching and rate-limiting half of {@link renderPrompt}: at most one request per TTL per
   * key, at most one in flight per key, and no request at all while the server has told us to
   * wait.
   */
  private async cachedResolve(
    prompt: string,
    template: string,
    variables?: Record<string, unknown> | null,
  ): Promise<RenderedPrompt> {
    const variablesKey = variables === undefined || variables === null ? "" : canonicalJson(variables);
    const key = `${this.config.environment}|${prompt}|${template}|${variablesKey}`;
    const state = this.resolveCache.get(key);
    const now = Date.now();

    if (state?.value && now - state.fetchedAt < this.config.cacheTtlMs) return state.value;
    if (state?.inFlight) return state.inFlight;
    if (state && now < state.nextAllowedAt) {
      if (state.value) {
        this.quiet.warn(
          `prompt endpoint is paused for ${String(Math.ceil((state.nextAllowedAt - now) / 1000))}s, serving the cached answer for ${prompt}`,
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
    const pending = this.fetchInto(entry, prompt, template, variables);
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
    prompt: string,
    template: string,
    variables?: Record<string, unknown> | null,
  ): Promise<RenderedPrompt> {
    try {
      const value = await this.fetchResolve(prompt, template, variables);
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
          `prompt endpoint failed (${describeError(error)}), serving the cached answer for ${prompt} and retrying in ${String(Math.round(wait / 1000))}s`,
        );
        return entry.value;
      }
      throw error;
    } finally {
      entry.inFlight = null;
    }
  }

  private async fetchResolve(
    prompt: string,
    template: string,
    variables?: Record<string, unknown> | null,
  ): Promise<RenderedPrompt> {
    if (this.config.mode !== "live" || this.config.apiKey === null) {
      throw new NotReadyError(
        `prompt endpoint needs an API key and live mode (mode is ${this.config.mode})`,
      );
    }
    const body: Record<string, unknown> = {
      environment: this.config.environment,
      template,
    };
    if (variables !== undefined && variables !== null) body["variables"] = variables;

    const response = await request(this.config, {
      method: "POST",
      path: `/prompts/${encodeURIComponent(prompt)}/render`,
      body: JSON.stringify(body),
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (response.status === 200) {
      const body = parseJson(response.text);
      if (!body || typeof body !== "object") {
        throw new ApiError(200, "prompt endpoint returned an unreadable body", response.text);
      }
      return mapRenderedPrompt(body as Record<string, unknown>);
    }

    const details = errorDetails(response.text);
    if (response.status === 404) {
      const reason = details["reason"];
      if (reason === "unresolved") {
        throw new UnresolvedError(typeof details["key"] === "string" ? details["key"] : prompt);
      }
      if (reason === "unknown_template") {
        throw new UnknownTemplateError(
          typeof details["key"] === "string" ? details["key"] : prompt,
          typeof details["template"] === "string" ? details["template"] : template,
          Array.isArray(details["template_names"]) ? (details["template_names"] as string[]) : [],
        );
      }
      if (reason === "unknown_prompt" || typeof details["key"] === "string") {
        throw new UnknownPromptError(typeof details["key"] === "string" ? details["key"] : prompt);
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
   * Fills in `id`, `started_at`, `sdk` and, when a prompt is passed, the deployment and prompt
   * evidence; then applies the prompt's payload policy.
   *
   * **Never throws.** A record the server would reject — a missing `status`, a value that will not
   * encode — is dropped, counted in `stats().droppedInvalid` and warned about once, because a
   * monitoring log must not turn a successful generation into a failed request. Pass
   * `strictRecords: true` to raise {@link InvalidRecordError} instead, which is what a test wants.
   */
  log(record: LogRecord, options: LogOptions = {}): void {
    this.safely(this.config.strictRecords, () => {
      const promptResolution =
        options.prompt === undefined || options.prompt === null
          ? null
          : (options.prompt as unknown as { currentResolution: Resolution }).currentResolution;
      const complete = completeRecord({ ...record }, promptResolution);
      const policy =
        options.policy ??
        promptResolution?.payloadPolicy ??
        this.policyFor(complete["prompt_key"]);
      this.enqueue(complete, policy);
    });
  }

  /**
   * Times a provider call and logs it.
   *
   * Runs `call`, measures the latency, builds the record from the prompt and the result, and
   * queues it. Whatever `call` returns is returned unchanged; whatever it throws is logged as an
   * error record and then rethrown unchanged.
   *
   * The logging half never throws, `strictRecords` or not: an exception raised while building the
   * record would replace the provider's own, which is the one the caller needs to see.
   */
  private async trackPrompt<T>(
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
  // prompt document plumbing

  /** Where the current prompt document came from and how old it is. */
  promptsInfo(): PromptsInfo {
    return this.store.info();
  }

  /** Fetches a prompt document once, now, and waits for it. Never throws. */
  async refresh(options: { timeoutMs?: number } = {}): Promise<RefreshResult> {
    if (this.config.mode === "offline") {
      this.snapshots.reloadLocal();
      return { status: "skipped", reason: "offline mode reloaded the local prompt document" };
    }
    return this.snapshots.refresh(options);
  }

  /**
   * Installs a prompt document by hand — for tests, and for a process that ships its
   * configuration some other way. Recorded as `source: "manual"`.
   */
  loadPrompts(document: unknown, source: "manual" | "bundle" | "disk" = "manual"): void {
    const raw = typeof document === "string" ? document : JSON.stringify(document);
    const decoded = decodePromptDocument(typeof document === "string" ? JSON.parse(document) : document);
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
   * Writes the current prompt document to a file, so it can be committed as the bundle a cold start falls
   * back to. The bytes are exactly what the server sent, so the ETag still matches.
   */
  exportPrompts(path: string): void {
    const entry = this.store.get();
    if (!entry) throw new NotReadyError("there is no prompt document to export yet");
    writePromptDocumentFile(path, entry.raw, {
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

  private policyFor(prompt: unknown): PayloadPolicy | null {
    if (typeof prompt !== "string") return null;
    const entry = this.store.get();
    return entry?.data.prompts[prompt]?.payloadPolicy ?? null;
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

function prepareProviderRequest(
  resolution: Resolution,
  variables: Record<string, unknown>,
  options: PreparedRequestOptions,
): PreparedRequest {
  const api = expectApi(resolution);
  const path = expectRequestPath(resolution);

  if (api === "chat_completions") {
    if (["session_id", "trace", "user"].some((key) => Object.hasOwn(options, key))) {
      throw new PreparedRequestError("Decisions metadata options require the Decisions API");
    }
    if (resolution.kind !== "chat" || !resolution.messages) {
      throw new NoTemplateError(resolution.promptKey);
    }
    const messages = renderMessages(resolution.messages, variables, resolution.engine ?? "liquid");
    const params = requestParams(resolution.params, options.params, "chat");
    const provider = providerOptions({
      ...resolution.providerOptions,
      ...(options.providerOptions ?? {}),
    });
    rejectProviderOptionsForNonOpenRouter(resolution, provider);
    const body: Record<string, unknown> = {
      model: expectModel(resolution),
      messages,
      ...params,
    };
    if (resolution.provider === "openrouter") body["usage"] = { include: true };
    if (Object.keys(provider).length > 0) body["provider"] = provider;
    return { api, method: "POST", path, body };
  }

  if (api === "decisions") {
    if (resolution.kind !== "decision" || !resolution.decision) {
      throw new NoTemplateError(resolution.promptKey);
    }
    const decisionParams = decisionRequestParams(resolution.params, options.params);

    const decision = renderDecision(resolution.decision, variables, resolution.engine ?? "liquid");
    const provider = providerOptions({
      ...resolution.providerOptions,
      ...(options.providerOptions ?? {}),
    });
    rejectProviderOptionsForNonOpenRouter(resolution, provider);
    const body: Record<string, unknown> = {
      model: expectModel(resolution),
      state: decision.state,
      questions: decision.questions,
      ...decisionParams,
    };
    if (Object.keys(provider).length > 0) body["provider"] = provider;
    applyDecisionOption(body, "session_id", options.session_id);
    applyDecisionOption(body, "trace", options.trace);
    applyDecisionOption(body, "user", options.user);
    return { api, method: "POST", path, body };
  }

  throw new PreparedRequestError(
    `prompt ${resolution.promptKey} uses unsupported deployment api ${String(resolution.api)}`,
  );
}

const PROTECTED_REQUEST_FIELDS = new Set([
  "model", "messages", "state", "questions", "provider", "usage", "api", "request_path", "method", "path", "body",
]);

function expectApi(resolution: Resolution): PreparedRequest["api"] {
  if (resolution.pinnedKind === null) {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} cannot prepare a provider request because its pinned prompt version has no kind metadata`,
    );
  }
  if (resolution.api !== "chat_completions" && resolution.api !== "decisions") {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} cannot prepare a provider request because its deployment has no supported api metadata`,
    );
  }
  if (resolution.api === "chat_completions" && resolution.pinnedKind !== "chat") {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} has deployment api chat_completions but pinned version kind ${resolution.pinnedKind}`,
    );
  }
  if (resolution.api === "decisions" && resolution.pinnedKind !== "decision") {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} has deployment api decisions but pinned version kind ${resolution.pinnedKind}`,
    );
  }
  return resolution.api;
}

function expectRequestPath(resolution: Resolution): string {
  const path = resolution.requestPath;
  if (typeof path !== "string" || path.length === 0) {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} cannot prepare a provider request because its deployment has no request_path metadata`,
    );
  }
  if (!path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(path)) {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} has invalid request_path ${path}; expected an origin-relative path`,
    );
  }
  const expected = expectedRequestPath(resolution.provider, resolution.api);
  if (expected === null) {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} cannot prepare a provider request for provider ${String(resolution.provider)} and api ${String(resolution.api)}`,
    );
  }
  if (path !== expected) {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} has request_path ${path}, expected ${expected} for provider ${String(resolution.provider)} and api ${String(resolution.api)}`,
    );
  }
  return path;
}

function expectedRequestPath(provider: string | null, api: string | null): string | null {
  if (provider === "openrouter" && api === "chat_completions") return "/api/v1/chat/completions";
  if (provider === "openrouter" && api === "decisions") return "/api/alpha/decisions";
  if (provider === "openai" && api === "chat_completions") return "/v1/chat/completions";
  if (provider === "groq" && api === "chat_completions") return "/openai/v1/chat/completions";
  return null;
}

function rejectProviderOptionsForNonOpenRouter(
  resolution: Resolution,
  provider: Record<string, unknown>,
): void {
  if (resolution.provider === "openrouter" || Object.keys(provider).length === 0) return;
  throw new PreparedRequestError(
    `prompt ${resolution.promptKey} has provider options, but provider options are only supported for OpenRouter requests`,
  );
}

function expectModel(resolution: Resolution): string {
  if (typeof resolution.model !== "string" || resolution.model.length === 0) {
    throw new PreparedRequestError(
      `prompt ${resolution.promptKey} cannot prepare a provider request because its deployment model is missing`,
    );
  }
  return resolution.model;
}

function requestParams(
  base: Record<string, unknown>,
  override: Record<string, unknown> | null | undefined,
  api: string,
): Record<string, unknown> {
  const merged = { ...base, ...(override ?? {}) };
  for (const key of Object.keys(merged)) {
    if (PROTECTED_REQUEST_FIELDS.has(key)) {
      throw new PreparedRequestError(`${api} request params cannot override protected field ${key}`);
    }
  }
  return cleanRecord(merged);
}

const DECISION_PARAM_FIELDS = new Set(["session_id", "trace", "user"]);

function decisionRequestParams(
  base: Record<string, unknown>,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged = providerOptions({ ...base, ...(override ?? {}) });
  const unsupported = Object.keys(merged).filter((key) => !DECISION_PARAM_FIELDS.has(key));
  if (unsupported.length > 0) {
    throw new PreparedRequestError(
      `Decisions requests support only session_id, trace, user and providerOptions; unsupported parameter(s): ${unsupported.sort().join(", ")}`,
    );
  }
  validateDecisionMetadata(merged);
  return merged;
}

function validateDecisionMetadata(params: Record<string, unknown>): void {
  const sessionId = params["session_id"];
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId.length > 256)) {
    throw new PreparedRequestError("Decisions session_id must be a string of 256 characters or fewer");
  }
  const user = params["user"];
  if (user !== undefined && (typeof user !== "string" || user.length > 256)) {
    throw new PreparedRequestError("Decisions user must be a string of 256 characters or fewer");
  }
  const trace = params["trace"];
  if (trace !== undefined && !isPlainRecord(trace)) {
    throw new PreparedRequestError("Decisions trace must be an object");
  }
}

function applyDecisionOption(
  body: Record<string, unknown>,
  key: "session_id" | "trace" | "user",
  value: unknown,
): void {
  if (value === undefined) return;
  validateDecisionMetadata({ [key]: value });
  body[key] = value;
}

function cleanRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined));
}

function providerOptions(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function renderDecision(
  decision: NonNullable<Resolution["decision"]>,
  variables: Record<string, unknown>,
  engine: NonNullable<Resolution["engine"]>,
): { state: unknown; questions: Record<string, unknown> } {
  validateState(decision.state);
  validateQuestions(decision.questions);
  const state = renderDecisionValue(decision.state, variables, engine);
  const questions = renderQuestionGuidance(decision.questions, variables, engine);
  validateState(state);
  validateQuestions(questions);
  return { state, questions };
}

function renderQuestionGuidance(
  questions: Record<string, unknown>,
  variables: Record<string, unknown>,
  engine: NonNullable<Resolution["engine"]>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([name, question]) => {
    if (!isPlainRecord(question)) throw new PreparedRequestError(`Decisions question ${name} must be an object`);
    const rendered = { ...question };
    if ("instructions" in rendered) {
      rendered["instructions"] = renderDecisionValue(rendered["instructions"], variables, engine);
    }
    if ("criteria" in rendered) {
      rendered["criteria"] = renderDecisionValue(rendered["criteria"], variables, engine);
    }
    return [name, rendered];
  }));
}

function renderDecisionValue(
  value: unknown,
  variables: Record<string, unknown>,
  engine: NonNullable<Resolution["engine"]>,
): unknown {
  if (typeof value === "string") return renderTemplate(value, variables, engine);
  if (Array.isArray(value)) return value.map((item) => renderDecisionValue(item, variables, engine));
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderDecisionValue(item, variables, engine)]),
    );
  }
  return value;
}

function validateState(state: unknown): void {
  if (typeof state === "string" || Array.isArray(state) || isPlainRecord(state)) return;
  throw new PreparedRequestError("Decisions state must be a string, JSON object, or JSON array");
}

function validateQuestions(questions: unknown): asserts questions is Record<string, unknown> {
  if (!isPlainRecord(questions) || Object.keys(questions).length === 0) {
    throw new PreparedRequestError("Decisions questions must be a non-empty object");
  }
  for (const [name, question] of Object.entries(questions)) {
    if (name.trim() === "") throw new PreparedRequestError("Decisions question names must be non-empty strings");
    validateQuestion(name, question);
  }
}

function validateQuestion(name: string, question: unknown): void {
  if (!isPlainRecord(question)) throw new PreparedRequestError(`Decisions question ${name} must be an object`);
  if (Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key))) {
    throw new PreparedRequestError(`Decisions question ${name} accepts only type, instructions, and criteria`);
  }
  const type = question["type"];
  if (type === "choice") {
    validateInstructions(name, question);
    const criteria = question["criteria"];
    if (!isPlainRecord(criteria) || Object.keys(criteria).length === 0) {
      throw new PreparedRequestError(`Decisions choice question ${name} criteria must be a non-empty object`);
    }
    if (Object.keys(criteria).length > 255) {
      throw new PreparedRequestError(`Decisions choice question ${name} criteria must contain at most 255 choices`);
    }
    for (const [choice, guidance] of Object.entries(criteria)) {
      if (choice.trim() === "" || !(isGuidance(guidance) || guidance === null)) {
        throw new PreparedRequestError(`Decisions choice question ${name} criteria must map choices to guidance`);
      }
    }
    return;
  }
  if (type === "noul") {
    validateInstructions(name, question);
    const criteria = question["criteria"];
    if (criteria === undefined || criteria === null) return;
    if (!isPlainRecord(criteria) || Object.keys(criteria).length !== 2 || !Object.hasOwn(criteria, "true") || !Object.hasOwn(criteria, "false")) {
      throw new PreparedRequestError(`Decisions noul question ${name} criteria must include true and false`);
    }
    if (!isGuidance(criteria["true"]) || !isGuidance(criteria["false"])) {
      throw new PreparedRequestError(`Decisions noul question ${name} criteria values must be guidance`);
    }
    return;
  }
  if (type === "score") {
    validateInstructions(name, question);
    const criteria = question["criteria"];
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(isGuidance)) {
      throw new PreparedRequestError(`Decisions score question ${name} criteria must be a list of 2 to 10 guidance values`);
    }
    return;
  }
  throw new PreparedRequestError(`Decisions question ${name} has an unsupported type`);
}

function validateInstructions(name: string, question: Record<string, unknown>): void {
  if (!isGuidance(question["instructions"])) {
    throw new PreparedRequestError(`Decisions question ${name} must include instructions`);
  }
}

function isGuidance(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) || isPlainRecord(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function mapRenderedPrompt(body: Record<string, unknown>): RenderedPrompt {
  const deployment = (body["deployment"] ?? {}) as Record<string, unknown>;
  const version = body["prompt_version"];
  return {
    key: textOf(body["key"]),
    kind: textOf(body["kind"] ?? "chat"),
    deployment: {
      id: typeof deployment["id"] === "string" ? deployment["id"] : null,
      revision: typeof deployment["revision"] === "number" ? deployment["revision"] : null,
    },
    template: typeof body["template"] === "string" ? body["template"] : null,
    templateNames: Array.isArray(body["template_names"]) ? (body["template_names"] as string[]) : [],
    modelId: typeof body["model_id"] === "string" ? body["model_id"] : null,
    model: typeof body["model"] === "string" ? body["model"] : null,
    provider: typeof body["provider"] === "string" ? body["provider"] : null,
    api: typeof body["api"] === "string" ? body["api"] : null,
    requestPath: typeof body["request_path"] === "string" ? body["request_path"] : null,
    request: mapPreparedRequest(body["request"]),
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
    decision: mapDecision(body["decision"]),
    warnings: Array.isArray(body["warnings"]) ? body["warnings"] : [],
    etag: typeof body["etag"] === "string" ? body["etag"] : null,
    source: typeof body["source"] === "string" ? body["source"] : null,
  };
}

function mapPreparedRequest(value: unknown): PreparedRequest | null {
  if (!isPlainRecord(value)) return null;
  const api = value["api"];
  const method = typeof value["method"] === "string" ? value["method"].toUpperCase() : "POST";
  const path = value["path"];
  const body = value["body"];
  if ((api !== "chat_completions" && api !== "decisions") || method !== "POST" || typeof path !== "string") {
    return null;
  }
  return {
    api,
    method: "POST",
    path,
    body: isPlainRecord(body) ? { ...body } : {},
  };
}

function mapDecision(value: unknown): DecisionTemplate | null {
  if (!isPlainRecord(value) || !isPlainRecord(value["questions"])) return null;
  return {
    state: value["state"] ?? null,
    questions: { ...value["questions"] },
  };
}
