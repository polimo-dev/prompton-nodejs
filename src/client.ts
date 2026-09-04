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
  type SendOutcome,
} from "./buffer.js";
import {
  buildRecord,
  classifyError,
  completeRecord,
  generationId,
  type GenerationMeta,
  type ProviderOutcome,
} from "./generation.js";
import { applyPayloadPolicy, type GenerationRecord } from "./payload.js";
import {
  DEFAULT_PROMPT,
  promptNamesFromSnapshot,
  resolveFromSnapshot,
  type Resolution,
} from "./resolver.js";
import { decodeSnapshot, type PayloadPolicy } from "./snapshotData.js";
import { SnapshotManager, type RefreshResult } from "./snapshot.js";
import { SnapshotStore, writeSnapshotFile, type SnapshotInfo } from "./store.js";
import { render as renderTemplate, renderMessages, type Message } from "./template.js";
import { textOf } from "./json.js";
import { VERSION } from "./version.js";

/** Options for {@link PromptOn.resolve}. */
export interface ResolveOptions {
  /** Which prompt name to use. Default `default`. */
  prompt?: string;
}

/** Options for {@link PromptOn.resolveRemote}. */
export interface RemoteResolveOptions extends ResolveOptions {
  /** Variables to render the pinned prompt with, locally. */
  variables?: Record<string, unknown> | null;
}

/** What `POST /resolve` answered, plus the locally rendered prompt. */
export interface RemoteResolution {
  useCase: string;
  kind: string;
  deployment: { id: string | null; revision: number | null };
  prompt: string | null;
  prompts: string[];
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
}

/** Options for {@link PromptOn.log}. */
export interface LogOptions {
  /** The resolution this generation used; fills in the deployment and prompt evidence. */
  resolution?: Resolution | null;
  /** Override the payload policy; by default the use case's policy from the snapshot is used. */
  policy?: PayloadPolicy | null;
}

interface CachedResolve {
  value: RemoteResolution;
  fetchedAt: number;
}

/**
 * The SDK.
 *
 * One instance holds one environment's snapshot and one monitoring-log buffer. Construction is
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
  private readonly resolveCache = new Map<string, CachedResolve>();
  private readonly captured: GenerationRecord[] = [];
  private readyPromise: Promise<RefreshResult> | null = null;
  private exitHandler: (() => void) | null = null;
  private closed = false;

  constructor(options: PromptOnOptions = {}) {
    this.config = resolveConfig(options);
    this.snapshots = new SnapshotManager(this.config, this.store);
    this.buffer = new LogBuffer((records) => this.sendBatch(records), {
      ...this.config.log,
      logger: this.config.logger,
    });

    this.snapshots.loadLocal();

    if (this.config.mode === "live" && this.config.apiKey === null) {
      this.config.logger.warn(
        "no API key (set PTN_API_KEY or pass apiKey): running from the disk cache and the bundled snapshot only, with no remote calls",
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
      process.once("beforeExit", this.exitHandler);
    }
  }

  // -------------------------------------------------------------------------
  // configuration

  /**
   * Waits for the first snapshot fetch to finish. Optional — resolution works from the disk cache
   * or the bundle without it — but a short-lived script wants it.
   */
  async ready(): Promise<RefreshResult> {
    return (
      this.readyPromise ??
      Promise.resolve<RefreshResult>({ status: "skipped", reason: "no remote configured" })
    );
  }

  // -------------------------------------------------------------------------
  // resolution

  /**
   * Resolves a use case from the cached snapshot. Synchronous and allocation-cheap: this is the
   * call that sits in the request path.
   *
   * Within the cache TTL nothing is fetched. Past it, a background refresh starts and this call
   * still answers from the document it already has.
   */
  resolve(useCase: string, options: ResolveOptions = {}): Resolution {
    this.snapshots.ensureFresh();
    const entry = this.store.get();
    if (!entry) {
      throw new NotReadyError(
        `no snapshot for environment ${this.config.environment}: PromptOn is unreachable and nothing is cached on disk or bundled`,
      );
    }
    return resolveFromSnapshot(entry.data, useCase, {
      prompt: options.prompt ?? DEFAULT_PROMPT,
      source: entry.source,
      etag: entry.etag,
    });
  }

  /**
   * Renders the resolution's pinned prompt with this call's variables. Chat use cases give a
   * message list, text use cases a string; an embedding use case has no template.
   */
  render(resolution: Resolution, variables?: Record<string, unknown> | null): Message[] | string {
    const engine = resolution.engine ?? "liquid";
    if (resolution.kind === "chat" && resolution.messages) {
      return renderMessages(resolution.messages, variables ?? {}, engine);
    }
    if (resolution.kind === "text" && typeof resolution.textTemplate === "string") {
      return renderTemplate(resolution.textTemplate, variables ?? {}, engine);
    }
    throw new NoTemplateError(resolution.useCase);
  }

  /** {@link render} for a chat use case, typed as a message list. */
  renderChat(resolution: Resolution, variables?: Record<string, unknown> | null): Message[] {
    const rendered = this.render(resolution, variables);
    if (typeof rendered === "string") throw new NoTemplateError(resolution.useCase);
    return rendered;
  }

  /** {@link render} for a text use case, typed as a string. */
  renderText(resolution: Resolution, variables?: Record<string, unknown> | null): string {
    const rendered = this.render(resolution, variables);
    if (typeof rendered !== "string") throw new NoTemplateError(resolution.useCase);
    return rendered;
  }

  /** The prompt names the live deployment pins, sorted. */
  promptNames(useCase: string): string[] {
    const entry = this.store.get();
    if (!entry) throw new NotReadyError("no snapshot is cached yet");
    return promptNamesFromSnapshot(entry.data, useCase);
  }

  /**
   * `POST /resolve`: the simple path and the smoke test. One round trip per call, so it belongs in
   * a low-traffic path or a start-up check, never in a hot loop — {@link resolve} is that path.
   *
   * The server is asked for the raw template and the answer is cached for the same TTL as the
   * snapshot, so repeated calls with different variables cost one request; rendering happens
   * locally. On `429`, `5xx` or an unreachable server the cached answer is served.
   */
  async resolveRemote(
    useCase: string,
    options: RemoteResolveOptions = {},
  ): Promise<RemoteResolution> {
    const prompt = options.prompt ?? DEFAULT_PROMPT;
    const key = `${this.config.environment}|${useCase}|${prompt}`;
    const cached = this.resolveCache.get(key);
    const now = Date.now();

    let value: RemoteResolution;
    if (cached && now - cached.fetchedAt < this.config.cacheTtlMs) {
      value = cached.value;
    } else {
      try {
        value = await this.fetchResolve(useCase, prompt);
        this.resolveCache.set(key, { value, fetchedAt: now });
      } catch (error) {
        if (cached && isTransient(error)) {
          this.config.logger.warn(
            `POST /resolve failed (${(error as Error).message}), serving the cached answer for ${useCase}`,
          );
          value = cached.value;
        } else {
          throw error;
        }
      }
    }

    if (options.variables === undefined || options.variables === null) return value;
    const rendered: RemoteResolution = { ...value };
    if (value.messages) rendered.messages = renderMessages(value.messages, options.variables);
    if (typeof value.text === "string") rendered.text = renderTemplate(value.text, options.variables);
    return rendered;
  }

  private async fetchResolve(useCase: string, prompt: string): Promise<RemoteResolution> {
    if (this.config.mode !== "live" || this.config.apiKey === null) {
      throw new NotReadyError(
        `POST /resolve needs an API key and live mode (mode is ${this.config.mode})`,
      );
    }
    const response = await request(this.config, {
      method: "POST",
      path: "/resolve",
      body: JSON.stringify({
        use_case: useCase,
        environment: this.config.environment,
        prompt,
      }),
      timeoutMs: this.config.requestTimeoutMs,
    });

    if (response.status === 200) {
      const body = parseJson(response.text);
      if (!body || typeof body !== "object") {
        throw new ApiError(200, "POST /resolve returned an unreadable body", response.text);
      }
      return mapRemoteResolution(body as Record<string, unknown>);
    }

    const details = errorDetails(response.text);
    if (response.status === 404) {
      const reason = details["reason"];
      if (reason === "unresolved") throw new UnresolvedError(useCase);
      if (reason === "unknown_prompt") {
        throw new UnknownPromptError(
          useCase,
          typeof details["prompt"] === "string" ? details["prompt"] : prompt,
          Array.isArray(details["available_prompts"]) ? (details["available_prompts"] as string[]) : [],
        );
      }
      if (typeof details["use_case"] === "string") throw new UnknownUseCaseError(useCase);
    }
    if (response.status === 400 && typeof details["missing_variable"] === "string") {
      throw new MissingVariableError(details["missing_variable"]);
    }
    throw new ApiError(response.status, errorMessage(response), parseJson(response.text));
  }

  // -------------------------------------------------------------------------
  // monitoring logs

  /** A pre-issued UUIDv7, for an app that wants the id before the call. */
  generationId(): string {
    return generationId();
  }

  /**
   * Queues one monitoring-log record the app built itself and returns at once.
   *
   * Fills in `id`, `started_at`, `sdk` and, when a resolution is passed, the deployment and prompt
   * evidence; then applies the use case's payload policy. Throws only when a field the server
   * requires is missing, which is a bug at the call site rather than a runtime condition.
   */
  log(record: GenerationRecord, options: LogOptions = {}): void {
    const complete = completeRecord({ ...record }, options.resolution ?? null);
    const policy =
      options.policy ??
      options.resolution?.payloadPolicy ??
      this.policyFor(complete["use_case"]);
    this.enqueue(complete, policy);
  }

  /**
   * Times a provider call and logs it.
   *
   * Runs `call`, measures the latency, builds the record from the resolution and the outcome, and
   * queues it. Whatever `call` returns is returned unchanged; whatever it throws is logged as an
   * error record and then rethrown unchanged.
   */
  async withGeneration<T>(
    resolution: Resolution,
    meta: GenerationMeta,
    call: () => T | Promise<T>,
    extractOutcome: (result: T) => ProviderOutcome | null = defaultOutcome,
  ): Promise<T> {
    const id = meta.id ?? generationId();
    const startedAt = new Date();
    const startedNs = process.hrtime.bigint();

    try {
      const result = await call();
      const latencyMs = elapsedMs(startedNs);
      let outcome: ProviderOutcome | null = null;
      try {
        outcome = extractOutcome(result);
      } catch (error) {
        this.config.logger.warn(`outcome extractor threw: ${(error as Error).message}`);
      }
      this.enqueue(
        buildRecord({
          resolution,
          meta,
          id,
          startedAt,
          latencyMs,
          status: "ok",
          outcome,
          error: null,
        }),
        resolution.payloadPolicy,
      );
      return result;
    } catch (error) {
      const latencyMs = elapsedMs(startedNs);
      this.enqueue(
        buildRecord({
          resolution,
          meta,
          id,
          startedAt,
          latencyMs,
          status: "error",
          outcome: null,
          error: classifyError(error),
        }),
        resolution.payloadPolicy,
      );
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
  get logs(): readonly GenerationRecord[] {
    return this.captured;
  }

  /** Forgets the captured test-mode records. */
  clearLogs(): void {
    this.captured.length = 0;
  }

  // -------------------------------------------------------------------------
  // snapshot plumbing

  /** Where the current snapshot came from and how old it is. */
  snapshotInfo(): SnapshotInfo {
    return this.store.info();
  }

  /** Fetches a snapshot once, now, and waits for it. Never throws. */
  async refresh(options: { timeoutMs?: number } = {}): Promise<RefreshResult> {
    if (this.config.mode === "offline") {
      this.snapshots.reloadLocal();
      return { status: "skipped", reason: "offline mode reloaded the local snapshot" };
    }
    return this.snapshots.refresh(options);
  }

  /**
   * Installs a snapshot document by hand — for tests, and for a process that ships its
   * configuration some other way. Recorded as `resolution_source: "manual"`.
   */
  loadSnapshot(document: unknown, source: "manual" | "bundle" | "disk" = "manual"): void {
    const raw = typeof document === "string" ? document : JSON.stringify(document);
    const decoded = decodeSnapshot(typeof document === "string" ? JSON.parse(document) : document);
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
   * Writes the current snapshot to a file, so it can be committed as the bundle a cold start falls
   * back to. The bytes are exactly what the server sent, so the ETag still matches.
   */
  exportSnapshot(path: string): void {
    const entry = this.store.get();
    if (!entry) throw new NotReadyError("there is no snapshot to export yet");
    writeSnapshotFile(path, entry.raw, {
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
      process.removeListener("beforeExit", this.exitHandler);
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

  private enqueue(record: GenerationRecord, policy: PayloadPolicy | null): void {
    try {
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
    } catch (error) {
      this.config.logger.warn(`dropped a monitoring log: ${(error as Error).message}`);
    }
  }

  private async sendBatch(records: GenerationRecord[]): Promise<SendOutcome> {
    if (this.config.mode !== "live" || this.config.apiKey === null) {
      return { kind: "drop", reason: "no API key: monitoring logs cannot be sent" };
    }
    let response;
    try {
      response = await request(this.config, {
        method: "POST",
        path: "/generations",
        query: { environment: this.config.environment },
        body: JSON.stringify({ generations: records }),
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

function defaultOutcome(result: unknown): ProviderOutcome | null {
  if (result === null || result === undefined) return null;
  if (typeof result === "string") return { content: result };
  if (typeof result !== "object") return null;
  return result;
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

function mapRemoteResolution(body: Record<string, unknown>): RemoteResolution {
  const deployment = (body["deployment"] ?? {}) as Record<string, unknown>;
  const version = body["prompt_version"];
  return {
    useCase: textOf(body["use_case"]),
    kind: textOf(body["kind"] ?? "chat"),
    deployment: {
      id: typeof deployment["id"] === "string" ? deployment["id"] : null,
      revision: typeof deployment["revision"] === "number" ? deployment["revision"] : null,
    },
    prompt: typeof body["prompt"] === "string" ? body["prompt"] : null,
    prompts: Array.isArray(body["prompts"]) ? (body["prompts"] as string[]) : [],
    modelId: typeof body["model_id"] === "string" ? body["model_id"] : null,
    model: typeof body["model"] === "string" ? body["model"] : null,
    provider: typeof body["provider"] === "string" ? body["provider"] : null,
    params: (body["effective_params"] ?? {}) as Record<string, unknown>,
    providerOptions: (body["effective_provider_options"] ?? {}) as Record<string, unknown>,
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
  };
}
