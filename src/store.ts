import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeUseCaseDocumentJson, type UseCaseDocument } from "./snapshotData.js";
import type { ResolutionSource } from "./resolver.js";
import type { Logger } from "./logger.js";

/**
 * The three tiers a snapshot can come from: memory (always), one local file written atomically,
 * and a file bundled into the app. No database, no Redis, no coordination between instances —
 * ETag polling makes a per-instance copy cheap.
 */

/** One snapshot, and where it came from. */
export interface UseCaseDocumentEntry {
  data: UseCaseDocument;
  /** The bytes the server sent, kept verbatim so the disk mirror and the export match the ETag. */
  raw: string;
  etag: string | null;
  lastModified: string | null;
  source: ResolutionSource;
  fetchedAt: number;
  /** When the last refresh started failing; `null` while the document is fresh. */
  staleSince: number | null;
}

/** What `useCasesInfo()` reports. */
export interface UseCasesInfo {
  etag: string | null;
  lastModified: string | null;
  source: ResolutionSource | "none";
  environment: string | null;
  project: string | null;
  fetchedAt: string | null;
  stale: boolean;
  ageSeconds: number | null;
}

/** Metadata kept beside a cached snapshot, because the body itself carries no timestamps. */
interface Sidecar {
  etag?: string | null;
  last_modified?: string | null;
  environment?: string | null;
  project?: string | null;
  fetched_at?: string | null;
}

/** In-memory holder of the current snapshot. */
export class SnapshotStore {
  private entry: UseCaseDocumentEntry | null = null;

  get(): UseCaseDocumentEntry | null {
    return this.entry;
  }

  set(entry: UseCaseDocumentEntry): void {
    this.entry = entry;
  }

  clear(): void {
    this.entry = null;
  }

  markStale(at: number): void {
    if (this.entry && this.entry.staleSince === null) {
      this.entry = { ...this.entry, staleSince: at };
    }
  }

  markFresh(): void {
    if (this.entry && (this.entry.staleSince !== null || this.entry.source !== "remote")) {
      this.entry = { ...this.entry, source: "remote", staleSince: null };
    }
  }

  info(): UseCasesInfo {
    const entry = this.entry;
    if (!entry) {
      return {
        etag: null,
        lastModified: null,
        source: "none",
        environment: null,
        project: null,
        fetchedAt: null,
        stale: true,
        ageSeconds: null,
      };
    }
    const base = entry.lastModified ? Date.parse(entry.lastModified) : entry.fetchedAt;
    const age = Number.isNaN(base) ? entry.fetchedAt : base;
    return {
      etag: entry.etag,
      lastModified: entry.lastModified,
      source: entry.source,
      environment: entry.data.environment,
      project: entry.data.project,
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      stale: entry.source !== "remote" || entry.staleSince !== null,
      ageSeconds: Math.max(Math.round((Date.now() - age) / 1000), 0),
    };
  }
}

/** Why a file on disk was not usable. */
export type LoadFailure =
  | { kind: "missing" }
  | { kind: "unreadable"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "environment_mismatch"; found: string | null; expected: string }
  | { kind: "project_mismatch"; found: string | null; expected: string };

/** The outcome of reading a snapshot file. */
export type LoadResult = { ok: true; entry: UseCaseDocumentEntry } | { ok: false; failure: LoadFailure };

/**
 * Reads a snapshot file and its sidecar.
 *
 * A document for another environment or another project is never used: a staging process must not
 * boot on a production bundle. A corrupt or half-written file is ignored, not an error.
 */
export function loadUseCaseDocumentFile(
  path: string,
  source: ResolutionSource,
  environment: string,
  project: string | null,
): LoadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return { ok: false, failure: { kind: "missing" } };
    return { ok: false, failure: { kind: "unreadable", message: (error as Error).message } };
  }

  let decoded;
  try {
    decoded = decodeUseCaseDocumentJson(raw);
  } catch (error) {
    return { ok: false, failure: { kind: "invalid", message: (error as Error).message } };
  }

  const sidecar = readSidecar(path);
  const fileEnvironment = decoded.data.environment ?? sidecar.environment ?? null;
  if (fileEnvironment !== environment) {
    return {
      ok: false,
      failure: { kind: "environment_mismatch", found: fileEnvironment, expected: environment },
    };
  }
  const fileProject = decoded.data.project ?? sidecar.project ?? null;
  if (project !== null && fileProject !== null && fileProject !== project) {
    return {
      ok: false,
      failure: { kind: "project_mismatch", found: fileProject, expected: project },
    };
  }

  const fetchedAt = sidecar.fetched_at ? Date.parse(sidecar.fetched_at) : Number.NaN;
  return {
    ok: true,
    entry: {
      data: decoded.data,
      raw,
      etag: sidecar.etag ?? null,
      lastModified: sidecar.last_modified ?? null,
      source,
      fetchedAt: Number.isNaN(fetchedAt) ? Date.now() : fetchedAt,
      staleSince: null,
    },
  };
}

/** The sidecar path for a snapshot file. */
export function sidecarPath(path: string): string {
  return `${path}.meta.json`;
}

/**
 * Writes the snapshot and its sidecar atomically: a temp file in the same directory, then a
 * rename. Several processes on one host may share the file; a reader either sees the old inode or
 * the new one, never a half-written body.
 */
export function writeUseCaseDocumentFile(
  path: string,
  raw: string,
  sidecar: Sidecar,
): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, raw);
  atomicWrite(sidecarPath(path), JSON.stringify(sidecar, null, 2) + "\n");
}

function atomicWrite(path: string, content: string): void {
  const temp = `${path}.tmp.${String(process.pid)}.${Math.random().toString(36).slice(2)}`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readSidecar(path: string): Sidecar {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sidecarPath(path), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // A missing or corrupt sidecar costs us the ETag, nothing more.
  }
  return {};
}

/** Human-readable reason a file was skipped, for the one log line it earns. */
export function describeFailure(path: string, source: string, failure: LoadFailure): string | null {
  switch (failure.kind) {
    case "missing":
      return null;
    case "unreadable":
      return `could not read the ${source} snapshot ${path}: ${failure.message}`;
    case "invalid":
      return `ignoring the ${source} snapshot ${path}: ${failure.message}`;
    case "environment_mismatch":
      return `refusing the ${source} snapshot ${path}: it is for environment ${String(failure.found)}, this process reads ${failure.expected}`;
    case "project_mismatch":
      return `refusing the ${source} snapshot ${path}: it is for project ${String(failure.found)}, this process reads ${failure.expected}`;
    default:
      return null;
  }
}

/** Loads memory → disk → bundle, in that order, and returns the first usable document. */
export function loadLocalSnapshot(
  diskCachePath: string | null,
  bundlePath: string | null,
  environment: string,
  project: string | null,
  logger: Logger,
): UseCaseDocumentEntry | null {
  const candidates: [string, ResolutionSource][] = [];
  if (diskCachePath) candidates.push([diskCachePath, "disk"]);
  if (bundlePath) candidates.push([bundlePath, "bundle"]);

  for (const [path, source] of candidates) {
    const result = loadUseCaseDocumentFile(path, source, environment, project);
    if (result.ok) {
      logger.info(`loaded snapshot from ${source} (${path})`);
      return result.entry;
    }
    const message = describeFailure(path, source, result.failure);
    if (message) logger.warn(message);
  }
  return null;
}
