import type { ResolvedConfig } from "./config.js";
import { errorMessage, request, retryAfterMs, TransportError } from "./http.js";
import { decodeUseCaseDocumentJson } from "./snapshotData.js";
import {
  loadLocalSnapshot,
  writeUseCaseDocumentFile,
  type UseCaseDocumentEntry,
  type SnapshotStore,
} from "./store.js";
import { throttled, type Logger } from "./logger.js";

/**
 * Keeps one snapshot document current.
 *
 * Within the cache TTL every resolve is served from memory with no HTTP call. Once the TTL has
 * passed the next resolve kicks off a background revalidation with `If-None-Match`, and a poll
 * timer does the same on its own. A refresh never blocks a generation and never fails one: while
 * it is in flight, and if it fails, the previous document keeps being served.
 */

/** What one refresh did. */
export type RefreshResult =
  | { status: "updated"; etag: string | null }
  | { status: "not_modified"; etag: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string; retryInMs: number };

const BACKOFF_CAP_MS = 300_000;

export class SnapshotManager {
  private readonly config: ResolvedConfig;
  private readonly store: SnapshotStore;
  private readonly logger: Logger;
  private readonly quiet: Logger;

  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<RefreshResult> | null = null;
  private lastAttemptAt = 0;
  private nextAllowedAt = 0;
  private failures = 0;

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
  loadLocal(): UseCaseDocumentEntry | null {
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

  /** Starts the background poll. Timers are unref'd, so they never hold the process open. */
  start(): void {
    if (this.timer || !this.config.poll || !this.remoteEnabled) return;
    this.timer = setInterval(() => {
      this.ensureFresh();
    }, this.config.cacheTtlMs);
    this.timer.unref?.();
  }

  /** Stops the background poll. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Stale-while-revalidate: when the TTL has passed, start a refresh in the background and return
   * at once. The caller keeps the document it already has.
   */
  ensureFresh(now: number = Date.now()): void {
    if (!this.remoteEnabled) return;
    if (this.inFlight) return;
    if (now < this.nextAllowedAt) return;
    if (now - this.lastAttemptAt < this.config.cacheTtlMs) return;
    void this.refresh().catch(() => undefined);
  }

  /** Fetches once, now, and waits for the outcome. Never throws. */
  refresh(options: { timeoutMs?: number } = {}): Promise<RefreshResult> {
    if (!this.remoteEnabled) {
      const reason =
        this.config.mode === "live"
          ? "no API key: the SDK is running from disk and bundle only"
          : `${this.config.mode} mode makes no remote calls`;
      return Promise.resolve({ status: "skipped", reason });
    }
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAt = Date.now();
    const pending = this.fetchOnce(options.timeoutMs ?? this.config.requestTimeoutMs).finally(
      () => {
        this.inFlight = null;
      },
    );
    this.inFlight = pending;
    return pending;
  }

  /** Reloads the disk cache and bundle (offline refresh). */
  reloadLocal(): UseCaseDocumentEntry | null {
    return this.loadLocal();
  }

  private async fetchOnce(timeoutMs: number): Promise<RefreshResult> {
    const current = this.store.get();
    const headers: Record<string, string> = {};
    if (current?.etag) headers["if-none-match"] = current.etag;

    try {
      const response = await request(this.config, {
        method: "GET",
        path: "/use-cases",
        query: { environment: this.config.environment },
        headers,
        timeoutMs,
      });

      if (response.status === 200) return this.install(response.text, response.headers);
      if (response.status === 304) {
        this.failures = 0;
        this.nextAllowedAt = 0;
        this.store.markFresh();
        return { status: "not_modified", etag: current?.etag ?? null };
      }
      if (response.status === 429) {
        const wait = retryAfterMs(response) ?? this.backoffMs();
        return this.fail(`rate limited (429)`, wait);
      }
      if (response.status >= 500) {
        const wait = retryAfterMs(response) ?? this.backoffMs();
        return this.fail(`server error ${String(response.status)}: ${errorMessage(response)}`, wait);
      }
      return this.fail(
        `${String(response.status)} ${errorMessage(response)}`,
        this.backoffMs(),
      );
    } catch (error) {
      const reason =
        error instanceof TransportError ? error.message : `unexpected error: ${String(error)}`;
      return this.fail(reason, this.backoffMs());
    }
  }

  private install(raw: string, headers: Record<string, string>): RefreshResult {
    let decoded;
    try {
      decoded = decodeUseCaseDocumentJson(raw);
    } catch (error) {
      return this.fail(`could not decode the snapshot: ${(error as Error).message}`, this.backoffMs());
    }
    for (const warning of decoded.warnings) {
      this.quiet.warn(`snapshot decoded with a warning: ${warning.kind}`);
    }
    if (decoded.data.environment !== null && decoded.data.environment !== this.config.environment) {
      return this.fail(
        `the server returned a snapshot for environment ${decoded.data.environment}, this process reads ${this.config.environment}`,
        this.backoffMs(),
      );
    }

    const etag = headers["etag"] ?? null;
    const entry: UseCaseDocumentEntry = {
      data: decoded.data,
      raw,
      etag,
      lastModified: headers["last-modified"] ?? null,
      source: "remote",
      fetchedAt: Date.now(),
      staleSince: null,
    };
    this.store.set(entry);
    this.failures = 0;
    this.nextAllowedAt = 0;
    this.mirrorToDisk(entry);
    this.logger.info(
      `snapshot updated (environment=${String(decoded.data.environment)}, etag=${String(etag)})`,
    );
    return { status: "updated", etag };
  }

  private mirrorToDisk(entry: UseCaseDocumentEntry): void {
    const path = this.config.diskCachePath;
    if (!path) return;
    try {
      writeUseCaseDocumentFile(path, entry.raw, {
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

  private fail(reason: string, retryInMs: number): RefreshResult {
    this.failures += 1;
    this.nextAllowedAt = Date.now() + retryInMs;
    this.store.markStale(Date.now());
    const served = this.store.get();
    const tail = served
      ? `serving the last good snapshot (${served.source})`
      : "nothing is cached yet";
    this.quiet.warn(
      `snapshot refresh failed: ${reason} — retrying in ${String(Math.round(retryInMs / 1000))}s, ${tail}`,
    );
    return { status: "failed", reason, retryInMs };
  }

  /** Exponential backoff ×2 from the cache TTL, capped at five minutes. */
  private backoffMs(): number {
    const exponent = Math.min(this.failures, 20);
    return Math.min(this.config.cacheTtlMs * 2 ** exponent, BACKOFF_CAP_MS);
  }
}
