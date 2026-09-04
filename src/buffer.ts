import type { GenerationRecord } from "./payload.js";
import { throttled, type Logger } from "./logger.js";

/**
 * The monitoring-log buffer: batches records, retries the ones PromptOn asks us to retry, and
 * never blocks or fails a provider call.
 *
 * Batches are at most 200 records and 4 MB (under the server's 5 MB body limit). A batch that
 * comes back `429` or `5xx` is retried with the same ids — they are idempotency keys, so a resend
 * is counted as a duplicate rather than stored twice. A `413` batch is split in half. Any other
 * `4xx` is dropped and counted: retrying a rejected batch forever only loses the ones behind it.
 */

/** One record the server refused, from the `rejected` array of a `202`. */
export interface RejectedRecord {
  index?: number;
  id?: string;
  code?: string;
  message?: string;
}

/** What one `POST /generations` did. */
export type SendOutcome =
  | { kind: "accepted"; accepted: number; duplicates: number; rejected: RejectedRecord[] }
  | { kind: "retry"; reason: string; retryInMs: number | null }
  | { kind: "too_large" }
  | { kind: "drop"; reason: string };

/** Sends one batch. Supplied by the client so the buffer stays transport-agnostic. */
export type Sender = (records: GenerationRecord[]) => Promise<SendOutcome>;

/** Counters a caller can assert on. */
export interface BufferStats {
  queued: number;
  queuedBytes: number;
  sent: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  droppedQueueFull: number;
  droppedTooLarge: number;
  droppedRejected: number;
  droppedRetriesExhausted: number;
  /** Records the SDK could not even build: a missing required field, or an unencodable value. */
  droppedInvalid: number;
}

/** What a `flush()` achieved. */
export interface FlushResult extends BufferStats {
  /** Records still queued when the flush gave up. */
  pending: number;
}

/** Buffer knobs, already defaulted by {@link resolveConfig}. */
export interface BufferOptions {
  flushIntervalMs: number;
  flushSize: number;
  flushBytes: number;
  maxQueue: number;
  maxAttempts: number;
  logger: Logger;
}

interface Entry {
  record: GenerationRecord;
  bytes: number;
}

const MAX_BATCH = 200;
const MAX_BATCH_BYTES = 4_000_000;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 300_000;

export class LogBuffer {
  private readonly options: BufferOptions;
  private readonly send: Sender;
  private readonly logger: Logger;
  private readonly quiet: Logger;

  private queue: Entry[] = [];
  private prebuilt: Entry[][] = [];
  private queuedBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private pumping: Promise<void> | null = null;
  private pausedUntil = 0;
  private attempts = 0;
  private closed = false;

  private stats = {
    sent: 0,
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    droppedQueueFull: 0,
    droppedTooLarge: 0,
    droppedRejected: 0,
    droppedRetriesExhausted: 0,
    droppedInvalid: 0,
  };

  constructor(send: Sender, options: BufferOptions) {
    this.send = send;
    this.options = options;
    this.logger = options.logger;
    this.quiet = throttled(options.logger, 60_000);
  }

  /** Queues one record. Returns immediately; the caller is never blocked and never fails. */
  enqueue(record: GenerationRecord): void {
    if (this.closed) {
      this.quiet.warn("the client is closed; this monitoring log was not queued");
      return;
    }
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    } catch (error) {
      this.stats.droppedTooLarge += 1;
      this.quiet.warn(`dropped a record that cannot be encoded: ${(error as Error).message}`);
      return;
    }
    if (bytes > MAX_BATCH_BYTES) {
      this.stats.droppedTooLarge += 1;
      this.quiet.warn(
        `dropped a ${String(bytes)}-byte record: one record cannot exceed the ${String(MAX_BATCH_BYTES)}-byte request limit`,
      );
      return;
    }

    this.queue.push({ record, bytes });
    this.queuedBytes += bytes;
    this.dropOldestOverflow();
    this.scheduleTimer();
    if (this.thresholdReached()) void this.pump().catch(() => undefined);
  }

  /**
   * Counts one record the client could not build or encode. Logging must never fail a generation,
   * so a bad record is dropped here rather than raised at the call site.
   */
  countInvalid(): void {
    this.stats.droppedInvalid += 1;
  }

  /** How many records are waiting. */
  get pending(): number {
    return this.queue.length + this.prebuilt.reduce((total, batch) => total + batch.length, 0);
  }

  /** A snapshot of the counters. */
  snapshot(): BufferStats {
    const prebuiltBytes = this.prebuilt.reduce(
      (total, batch) => total + batch.reduce((sum, entry) => sum + entry.bytes, 0),
      0,
    );
    return { ...this.stats, queued: this.pending, queuedBytes: this.queuedBytes + prebuiltBytes };
  }

  /**
   * Sends what is queued and waits for the result. Used at shutdown, in tests and in scripts.
   * Gives up after `timeoutMs` and reports what is still pending rather than blocking forever.
   */
  async flush(timeoutMs = 5000): Promise<FlushResult> {
    const deadline = Date.now() + timeoutMs;
    await this.pump(deadline);
    return { ...this.snapshot(), pending: this.pending };
  }

  /** Stops the timer. Any queued record stays queued for a later `flush()`. */
  stop(): void {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private scheduleTimer(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => {
      if (this.pending > 0) void this.pump().catch(() => undefined);
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  private thresholdReached(): boolean {
    return (
      this.prebuilt.length > 0 ||
      this.queue.length >= this.options.flushSize ||
      this.queuedBytes >= this.options.flushBytes
    );
  }

  private dropOldestOverflow(): void {
    while (this.queue.length > this.options.maxQueue) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.queuedBytes -= dropped.bytes;
      this.stats.droppedQueueFull += 1;
      this.quiet.warn(
        `monitoring-log queue is full (${String(this.options.maxQueue)}), dropping the oldest record`,
      );
    }
  }

  /** One drain cycle at a time; a second caller waits for the first. */
  private async pump(deadline?: number): Promise<void> {
    while (this.pumping) {
      await this.pumping;
      if (deadline === undefined) return;
      if (this.pending === 0) return;
      if (Date.now() >= deadline) return;
    }
    this.pumping = this.drain(deadline).finally(() => {
      this.pumping = null;
    });
    await this.pumping;
  }

  private async drain(deadline?: number): Promise<void> {
    for (;;) {
      if (this.pending === 0) return;

      const now = Date.now();
      if (now < this.pausedUntil) {
        if (deadline === undefined) return;
        if (this.pausedUntil > deadline) return;
        await sleep(this.pausedUntil - now);
      }
      if (deadline !== undefined && Date.now() >= deadline) return;

      const batch = this.take();
      if (batch.length === 0) return;

      let outcome: SendOutcome;
      try {
        outcome = await this.send(batch.map((entry) => entry.record));
      } catch (error) {
        outcome = { kind: "retry", reason: (error as Error).message, retryInMs: null };
      }
      const keepGoing = this.handle(batch, outcome);
      if (!keepGoing && deadline === undefined) return;
    }
  }

  private take(): Entry[] {
    const prebuilt = this.prebuilt.shift();
    if (prebuilt) return prebuilt;

    const batch: Entry[] = [];
    let bytes = 0;
    const limit = Math.min(this.options.flushSize, MAX_BATCH);
    while (this.queue.length > 0 && batch.length < limit) {
      const next = this.queue[0] as Entry;
      if (batch.length > 0 && bytes + next.bytes > MAX_BATCH_BYTES) break;
      this.queue.shift();
      this.queuedBytes -= next.bytes;
      bytes += next.bytes;
      batch.push(next);
    }
    return batch;
  }

  /** Returns whether draining should carry straight on. */
  private handle(batch: Entry[], outcome: SendOutcome): boolean {
    switch (outcome.kind) {
      case "accepted": {
        this.attempts = 0;
        this.pausedUntil = 0;
        this.stats.sent += batch.length;
        this.stats.accepted += outcome.accepted;
        this.stats.duplicates += outcome.duplicates;
        this.stats.rejected += outcome.rejected.length;
        if (outcome.rejected.length > 0) {
          this.logger.warn(
            `${String(outcome.rejected.length)} monitoring log(s) rejected: ${summarise(outcome.rejected)}`,
          );
        }
        return true;
      }
      case "too_large": {
        if (batch.length === 1) {
          this.stats.droppedTooLarge += 1;
          this.logger.error("dropping a single monitoring log the server answered 413 for");
          return true;
        }
        const middle = Math.floor(batch.length / 2);
        this.prebuilt.unshift(batch.slice(0, middle), batch.slice(middle));
        this.logger.warn(
          `batch of ${String(batch.length)} monitoring logs was too large (413), splitting it in half`,
        );
        return true;
      }
      case "drop": {
        this.stats.droppedRejected += batch.length;
        this.quiet.error(
          `dropping ${String(batch.length)} monitoring log(s): ${outcome.reason} — this is not retried`,
        );
        return true;
      }
      default: {
        this.attempts += 1;
        if (this.attempts >= this.options.maxAttempts) {
          this.stats.droppedRetriesExhausted += batch.length;
          this.attempts = 0;
          this.pausedUntil = 0;
          this.logger.error(
            `dropping ${String(batch.length)} monitoring log(s) after ${String(this.options.maxAttempts)} attempts: ${outcome.reason}`,
          );
          return true;
        }
        const wait = outcome.retryInMs ?? backoffMs(this.attempts);
        this.requeueFront(batch);
        this.pausedUntil = Date.now() + wait;
        this.quiet.warn(
          `monitoring logs not sent (${outcome.reason}), retrying the same batch in ${String(Math.round(wait / 1000))}s`,
        );
        return false;
      }
    }
  }

  private requeueFront(batch: Entry[]): void {
    this.prebuilt.unshift(batch);
  }
}

/** Exponential backoff ×2 from one second, capped at five minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0), RETRY_CAP_MS);
}

function summarise(rejected: RejectedRecord[]): string {
  return rejected
    .slice(0, 3)
    .map((entry) => `${entry.id ?? "?"}: ${entry.message ?? entry.code ?? "rejected"}`)
    .join("; ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
