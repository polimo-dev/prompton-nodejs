import type { ResolvedConfig } from "./config.js";
import { errorMessage, request, TransportError } from "./http.js";
import { decodePromptDocumentJson } from "./snapshotData.js";
import {
  loadLocalPromptSnapshot,
  loadLocalSnapshot,
  promptDiskCachePath,
  writePromptDocumentFile,
  type PromptDocumentEntry,
  type SnapshotStore,
} from "./store.js";
import { throttled, type Logger } from "./logger.js";

/**
 * Keeps prompt documents current on demand, independently per prompt key.
 *
 * Runtime startup and idle periods do not fetch remote config. A prompt lookup fetches only that
 * key when its cached document is missing or stale, shares same-key concurrent fetches, and falls
 * back to the last valid key-specific document when PromptOn cannot answer within the deadline.
 */

/** What one refresh did. */
export type RefreshResult =
  | { status: "updated"; etag: string | null }
  | { status: "not_modified"; etag: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; retryInMs: number };

interface PromptState {
  entry: PromptDocumentEntry | null;
  lastAttemptAt: number;
  lastSuccessAt: number;
  lastError: Error | null;
  lastStatus: "updated" | "not_modified" | "failed" | "skipped";
  inFlight: Promise<PromptDocumentEntry> | null;
}

const CONFIG_FETCH_TIMEOUT_MS = 1000;
const CONFIG_FETCH_TTL_MS = 10_000;

export class SnapshotManager {
  private readonly config: ResolvedConfig;
  private readonly store: SnapshotStore;
  private readonly logger: Logger;
  private readonly quiet: Logger;

  private readonly promptStates = new Map<string, PromptState>();

  constructor(config: ResolvedConfig, store: SnapshotStore) {
    this.config = config;
    this.store = store;
    this.logger = config.logger;
    this.quiet = throttled(config.logger, 60_000);
  }

  /** Whether remote calls are possible at all. */
  get remoteEnabled(): boolean {
    return this.config.mode === "live" && this.config.apiKey !== null;
  }

  /** Reads the disk cache, then the bundle. Called once, synchronously, at construction. */
  loadLocal(): PromptDocumentEntry | null {
    const entry = loadLocalSnapshot(
      this.config.diskCachePath,
      this.config.bundlePath,
      this.config.environment,
      this.config.project,
      this.logger,
    );
    if (entry) this.store.set(entry);
    return entry;
  }

  /** Demand-driven SDKs do not start a background config poll. */
  start(): void {
    return;
  }

  /** Kept for API symmetry; there is no config poll timer to stop. */
  stop(): void {
    return;
  }

  /** Resolves the prompt document for exactly one prompt key, fetching on demand when allowed. */
  async entryForPrompt(prompt: string): Promise<PromptDocumentEntry> {
    const now = Date.now();
    const state = this.stateFor(prompt);
    const local = this.localEntryFor(prompt);
    const cached = state.entry ?? local;

    if (state.entry && now - state.lastSuccessAt < CONFIG_FETCH_TTL_MS) return state.entry;
    if (!this.remoteEnabled) return this.requireCached(prompt, cached);
    if (state.inFlight) return state.inFlight;
    if (state.lastAttemptAt > 0 && now - state.lastAttemptAt < CONFIG_FETCH_TTL_MS) {
      state.lastStatus = "skipped";
      return this.requireCached(prompt, cached, state.lastError);
    }

    state.lastAttemptAt = now;
    const pending = this.fetchPrompt(prompt, state, cached).finally(() => {
      state.inFlight = null;
    });
    state.inFlight = pending;
    return pending;
  }

  /** Fetches one prompt now. Without a prompt key there is no normal runtime remote refresh. */
  async refresh(options: { timeoutMs?: number; prompt?: string } = {}): Promise<RefreshResult> {
    const prompt = options.prompt;
    if (!prompt) {
      return { status: "skipped", reason: "config fetch is demand-driven; pass prompt to refresh one key" };
    }
    if (!this.remoteEnabled) {
      const reason =
        this.config.mode === "live"
          ? "no API key: the SDK is running from disk and bundle only"
          : `${this.config.mode} mode makes no remote calls`;
      return Promise.resolve({ status: "skipped", reason });
    }
    const state = this.stateFor(prompt);
    try {
      await this.entryForPrompt(prompt);
      if (state.lastStatus === "updated") return { status: "updated", etag: state.entry?.etag ?? null };
      if (state.lastStatus === "not_modified") return { status: "not_modified", etag: state.entry?.etag ?? null };
      if (state.lastStatus === "failed") {
        return {
          status: "failed",
          reason: state.lastError?.message ?? "config fetch failed",
          retryInMs: CONFIG_FETCH_TTL_MS,
        };
      }
      return { status: "skipped", reason: "served cached prompt inside the config fetch rate limit" };
    } catch (error) {
      return { status: "failed", reason: (error as Error).message, retryInMs: CONFIG_FETCH_TTL_MS };
    }
  }

  /** Reloads the disk cache and bundle (offline refresh). */
  reloadLocal(): PromptDocumentEntry | null {
    return this.loadLocal();
  }

  private stateFor(prompt: string): PromptState {
    const current = this.promptStates.get(prompt);
    if (current) return current;
    const created: PromptState = {
      entry: null,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      lastError: null,
      lastStatus: "skipped",
      inFlight: null,
    };
    this.promptStates.set(prompt, created);
    return created;
  }

  private localEntryFor(prompt: string): PromptDocumentEntry | null {
    const state = this.promptStates.get(prompt);
    if (state?.entry) return state.entry;
    const loaded = loadLocalPromptSnapshot(
      prompt,
      this.config.diskCachePath,
      this.config.bundlePath,
      this.config.environment,
      this.config.project,
      this.quiet,
    );
    if (loaded) {
      const promptState = this.stateFor(prompt);
      promptState.entry = loaded;
      promptState.lastSuccessAt = loaded.source === "remote" ? loaded.fetchedAt : 0;
      this.store.set(loaded);
      return loaded;
    }
    const entry = this.store.get();
    if (!entry) return null;
    if (entry.cacheKey && entry.cacheKey !== prompt) return null;
    if (entry.data.prompts[prompt] || !entry.cacheKey) return entry;
    return null;
  }

  private requireCached(
    prompt: string,
    entry: PromptDocumentEntry | null,
    cause: Error | null = null,
  ): PromptDocumentEntry {
    if (entry) return entry;
    const suffix = cause ? `: ${cause.message}` : "";
    throw new Error(
      `no prompt document for ${prompt} in environment ${this.config.environment}: PromptOn is unreachable and nothing is cached${suffix}`,
    );
  }

  private async fetchPrompt(
    prompt: string,
    state: PromptState,
    fallback: PromptDocumentEntry | null,
  ): Promise<PromptDocumentEntry> {
    const deadline = Date.now() + CONFIG_FETCH_TIMEOUT_MS;
    try {
      const entry = await this.withDeadline(this.fetchPromptOnce(prompt, state), CONFIG_FETCH_TIMEOUT_MS);
      // Synchronous decoding can delay the timer callback; check elapsed time before committing.
      if (Date.now() > deadline) throw new TransportError("request timed out", null);
      state.entry = entry;
      state.lastSuccessAt = Date.now();
      state.lastError = null;
      this.store.set(entry);
      this.mirrorToDisk(prompt, entry);
      return entry;
    } catch (error) {
      const captured = error instanceof Error ? error : new Error(String(error));
      state.lastError = captured;
      state.lastStatus = "failed";
      if (state.entry) {
        state.entry = { ...state.entry, staleSince: Date.now() };
        this.store.set(state.entry);
      }
      this.quiet.warn(
        `config fetch for prompt ${prompt} failed: ${captured.message}; ${fallback ? "serving the cached prompt" : "nothing is cached yet"}`,
      );
      return this.requireCached(prompt, fallback, captured);
    }
  }

  private async fetchPromptOnce(prompt: string, state: PromptState): Promise<PromptDocumentEntry> {
    const current = state.entry;
    const headers: Record<string, string> = {};
    if (current?.etag) headers["if-none-match"] = current.etag;

    const response = await request(this.config, {
      method: "GET",
      path: `/prompts/${encodeURIComponent(prompt)}`,
      query: { environment: this.config.environment },
      headers,
      timeoutMs: CONFIG_FETCH_TIMEOUT_MS,
    });

    if (response.status === 200) {
      state.lastStatus = "updated";
      return this.decodePrompt(prompt, response.text, response.headers);
    }
    if (response.status === 304) {
      if (!current) throw new Error("PromptOn returned 304 but this prompt has no cached document");
      state.lastStatus = "not_modified";
      return {
        ...current,
        source: "remote",
        fetchedAt: Date.now(),
        staleSince: null,
        etag: response.headers["etag"] ?? current.etag,
        lastModified: response.headers["last-modified"] ?? current.lastModified,
      };
    }
    throw new Error(`${String(response.status)} ${errorMessage(response)}`);
  }

  private decodePrompt(
    prompt: string,
    raw: string,
    headers: Record<string, string>,
  ): PromptDocumentEntry {
    let decoded;
    try {
      decoded = decodePromptDocumentJson(raw);
    } catch (error) {
      throw new Error(`could not decode the prompt document: ${(error as Error).message}`);
    }
    for (const warning of decoded.warnings) {
      this.quiet.warn(`snapshot decoded with a warning: ${warning.kind}`);
    }
    if (decoded.data.environment !== null && decoded.data.environment !== this.config.environment) {
      throw new Error(
        `the server returned a snapshot for environment ${decoded.data.environment}, this process reads ${this.config.environment}`,
      );
    }
    if (
      decoded.data.project !== null &&
      this.config.project !== null &&
      decoded.data.project !== this.config.project
    ) {
      throw new Error(
        `the server returned a snapshot for project ${decoded.data.project}, this process reads ${this.config.project}`,
      );
    }
    if (!decoded.data.prompts[prompt]) {
      throw new Error(`the server returned a prompt document without requested prompt ${prompt}`);
    }

    const etag = headers["etag"] ?? null;
    const entry: PromptDocumentEntry = {
      data: decoded.data,
      raw,
      etag,
      lastModified: headers["last-modified"] ?? null,
      source: "remote",
      fetchedAt: Date.now(),
      staleSince: null,
      cacheKey: prompt,
    };
    this.logger.info(
      `prompt config updated (prompt=${prompt}, environment=${String(decoded.data.environment)}, etag=${String(etag)})`,
    );
    return entry;
  }

  private async withDeadline<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | null = null;
    try {
      return await Promise.race([
        task,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new TransportError("request timed out", null)), timeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private mirrorToDisk(prompt: string, entry: PromptDocumentEntry): void {
    const basePath = this.config.diskCachePath;
    if (!basePath) return;
    const path = promptDiskCachePath(basePath, prompt);
    try {
      writePromptDocumentFile(path, entry.raw, {
        etag: entry.etag,
        last_modified: entry.lastModified,
        environment: entry.data.environment,
        project: entry.data.project,
        fetched_at: new Date(entry.fetchedAt).toISOString(),
      });
    } catch (error) {
      this.quiet.warn(`could not write the disk cache ${path}: ${(error as Error).message}`);
    }
  }

}
