import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "./errors.js";
import { consoleLogger, silentLogger, type Logger } from "./logger.js";
import type { LogRecord, NormalizedPolicy } from "./payload.js";
import { USER_AGENT } from "./version.js";

/** How the SDK talks (or does not talk) to PromptOn. */
export type Mode = "live" | "test" | "offline";

/** Buffer knobs for monitoring logs. */
export interface LogOptions {
  /** Send a partial batch after this long. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Send as soon as this many records are queued. Default 100 (the hard cap per request is 200). */
  flushSize?: number;
  /** Send as soon as the queue holds this many encoded bytes. Default 1 MB. */
  flushBytes?: number;
  /** Drop the oldest record once the queue holds this many. Default 10 000. */
  maxQueue?: number;
  /** How many times one batch is retried before it is dropped and counted. Default 8. */
  maxAttempts?: number;
}

/** Everything the SDK can be told. Explicit option > environment variable > default. */
export interface PromptOnOptions {
  /** `ptn_<project>_…`. Without it the SDK makes no remote calls and works from disk or bundle. */
  apiKey?: string | null;
  /** PromptOn host or full API base. `/api/v1` is appended when it is not already there. */
  baseUrl?: string;
  /** Which environment's pins to read. Default `production`. */
  environment?: string;
  /** Project slug; parsed out of the API key when not given. Names the disk-cache file. */
  project?: string | null;
  /** How long a use-case document is served without revalidating. Default 10 000 ms. */
  cacheTtlMs?: number;
  /** Per-request timeout. Default 5000 ms. */
  requestTimeoutMs?: number;
  /** Timeout of the very first use-case document fetch, which never blocks a generation. Default 3000 ms. */
  initialFetchTimeoutMs?: number;
  /** `true` (default) for the standard path, `false` to disable, or an explicit file path. */
  diskCache?: boolean | string;
  /** A use-case document file committed into the app, used when memory and disk are empty. */
  bundlePath?: string | null;
  /** `live` (default), `offline` (disk and bundle only) or `test` (no HTTP, logs captured). */
  mode?: Mode;
  /** Send `end_user_ref` as an unkeyed sha256 hex. */
  hashEndUser?: boolean;
  /** Applied to every record last, after truncation. Return the record to send. */
  redact?: ((record: LogRecord) => LogRecord | null | undefined) | null;
  /** Payload policy used when the use-case document's use case declares none. */
  payloadDefaults?: Partial<NormalizedPolicy>;
  /**
   * Raise instead of dropping when {@link PromptOn.log} is handed a record the server would
   * reject. Off by default: logging must never fail a generation. Turn it on in tests to catch a
   * bad call site. Never applies to the wrapper, which must not replace the provider's own error.
   */
  strictRecords?: boolean;
  /** Monitoring-log buffer knobs. */
  log?: LogOptions;
  /** Poll for use-case document changes in the background. Default `true` outside test mode. */
  poll?: boolean;
  /** Flush the log buffer when the process is about to exit. Default `true`. */
  flushOnExit?: boolean;
  /** Injected `fetch`, for tests. Defaults to the global one. */
  fetch?: typeof globalThis.fetch;
  /** A logger, or `false` for silence. */
  logger?: Logger | false;
}

/** The options with every default filled in. */
export interface ResolvedConfig {
  apiKey: string | null;
  baseUrl: string;
  environment: string;
  project: string | null;
  cacheTtlMs: number;
  requestTimeoutMs: number;
  initialFetchTimeoutMs: number;
  diskCachePath: string | null;
  bundlePath: string | null;
  mode: Mode;
  hashEndUser: boolean;
  redact: ((record: LogRecord) => LogRecord | null | undefined) | null;
  payloadDefaults: Partial<NormalizedPolicy>;
  strictRecords: boolean;
  log: Required<LogOptions>;
  poll: boolean;
  flushOnExit: boolean;
  fetch: typeof globalThis.fetch;
  logger: Logger;
  userAgent: string;
}

/** The host used when neither an option nor `PTN_HOST` says otherwise. */
export const DEFAULT_HOST = "https://app.prompton.ai";

const DEFAULT_LOG: Required<LogOptions> = {
  flushIntervalMs: 2000,
  flushSize: 100,
  flushBytes: 1_000_000,
  maxQueue: 10_000,
  maxAttempts: 8,
};

/** Merges options, environment variables and defaults into the configuration the SDK runs on. */
export function resolveConfig(
  options: PromptOnOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const mode = options.mode ?? "live";
  if (mode !== "live" && mode !== "test" && mode !== "offline") {
    throw new ConfigError(`mode must be live, test or offline, got ${String(mode)}`);
  }

  const apiKey = firstString(options.apiKey, env["PTN_API_KEY"]);
  const environment =
    firstString(options.environment, env["PTN_ENVIRONMENT"]) ?? "production";
  const project = firstString(options.project, env["PTN_PROJECT"]) ?? projectFromApiKey(apiKey);
  const baseUrl = apiBase(firstString(options.baseUrl, env["PTN_HOST"]) ?? DEFAULT_HOST);

  const logger =
    options.logger === false ? silentLogger : (options.logger ?? consoleLogger);

  return {
    apiKey,
    baseUrl,
    environment,
    project,
    cacheTtlMs: positive(options.cacheTtlMs, 10_000, "cacheTtlMs"),
    requestTimeoutMs: positive(options.requestTimeoutMs, 5_000, "requestTimeoutMs"),
    initialFetchTimeoutMs: positive(options.initialFetchTimeoutMs, 3_000, "initialFetchTimeoutMs"),
    diskCachePath: diskCachePath(options.diskCache, project, environment, env),
    bundlePath: firstString(options.bundlePath, env["PTN_BUNDLE"]),
    mode,
    hashEndUser: options.hashEndUser === true,
    redact: options.redact ?? null,
    payloadDefaults: options.payloadDefaults ?? {},
    strictRecords: options.strictRecords === true,
    log: {
      flushIntervalMs: positive(options.log?.flushIntervalMs, DEFAULT_LOG.flushIntervalMs, "log.flushIntervalMs"),
      flushSize: positive(options.log?.flushSize, DEFAULT_LOG.flushSize, "log.flushSize"),
      flushBytes: positive(options.log?.flushBytes, DEFAULT_LOG.flushBytes, "log.flushBytes"),
      maxQueue: positive(options.log?.maxQueue, DEFAULT_LOG.maxQueue, "log.maxQueue"),
      maxAttempts: positive(options.log?.maxAttempts, DEFAULT_LOG.maxAttempts, "log.maxAttempts"),
    },
    poll: options.poll ?? mode === "live",
    flushOnExit: options.flushOnExit ?? true,
    fetch: options.fetch ?? globalThis.fetch,
    logger,
    userAgent: USER_AGENT,
  };
}

/** Appends `/api/v1` unless the URL already ends with it. */
export function apiBase(host: string): string {
  const trimmed = host.replace(/\/+$/u, "");
  if (/\/api\/v\d+$/u.test(trimmed)) return trimmed;
  return `${trimmed}/api/v1`;
}

/** `ptn_<project>_<random>` carries the project slug; the disk cache is named after it. */
export function projectFromApiKey(apiKey: string | null): string | null {
  if (!apiKey) return null;
  const match = /^ptn_([a-z0-9][a-z0-9_-]*)_[A-Za-z0-9]+$/u.exec(apiKey);
  return match ? (match[1] as string) : null;
}

/** Where a use-case document is cached when no explicit path is configured. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["PTN_CACHE_DIR"];
  if (explicit) return explicit;
  const xdg = env["XDG_CACHE_HOME"];
  if (xdg) return join(xdg, "prompton");
  let home = "";
  try {
    home = homedir();
  } catch {
    home = "";
  }
  if (home) {
    if (process.platform === "darwin") return join(home, "Library", "Caches", "prompton");
    if (process.platform === "win32") {
      const local = env["LOCALAPPDATA"];
      if (local) return join(local, "prompton", "Cache");
    }
    return join(home, ".cache", "prompton");
  }
  return join(tmpdir(), "prompton");
}

function diskCachePath(
  option: boolean | string | undefined,
  project: string | null,
  environment: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (option === false) return null;
  if (typeof option === "string" && option !== "") return option;
  const configured = env["PTN_DISK_CACHE"];
  if (configured) return configured;
  const name = `use-cases-${project ?? "default"}-${environment}.json`;
  return join(defaultCacheDir(env), name);
}

function firstString(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value !== "") return value;
    if (value === null) return null;
  }
  return null;
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive number, got ${String(value)}`);
  }
  return value;
}
