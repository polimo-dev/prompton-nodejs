import { describe, expect, it } from "vitest";

import { backoffMs, LogBuffer, type SendOutcome } from "../src/buffer.js";
import type { GenerationRecord } from "../src/index.js";
import { recordingLogger } from "./helpers.js";

/**
 * The buffer's contract: batch, retry what PromptOn asks us to retry with the same ids, split a
 * 413, drop anything else, and never lose the newest records to a queue that is already full.
 */

function record(id: string, extra: GenerationRecord = {}): GenerationRecord {
  return {
    id,
    use_case: "greeting",
    model: "openai/gpt-4o-mini",
    status: "ok",
    started_at: "2026-09-04T09:00:00.000Z",
    ...extra,
  };
}

function accepted(count: number): SendOutcome {
  return { kind: "accepted", accepted: count, duplicates: 0, rejected: [] };
}

interface Harness {
  buffer: LogBuffer;
  batches: string[][];
  logger: ReturnType<typeof recordingLogger>;
}

function harness(
  script: (records: GenerationRecord[], call: number) => SendOutcome | Promise<SendOutcome>,
  options: Partial<ConstructorParameters<typeof LogBuffer>[1]> = {},
): Harness {
  const batches: string[][] = [];
  const logger = recordingLogger();
  const buffer = new LogBuffer(
    (records) => {
      batches.push(records.map((r) => String(r["id"])));
      return Promise.resolve(script(records, batches.length - 1));
    },
    {
      flushIntervalMs: 50,
      flushSize: 100,
      flushBytes: 1_000_000,
      maxQueue: 10_000,
      maxAttempts: 8,
      logger,
      ...options,
    },
  );
  return { buffer, batches, logger };
}

describe("batching", () => {
  it("sends on the size trigger without waiting for the timer", async () => {
    const { buffer, batches } = harness(() => accepted(2), { flushSize: 2 });
    buffer.enqueue(record("a"));
    buffer.enqueue(record("b"));
    await buffer.flush(1000);
    expect(batches).toEqual([["a", "b"]]);
  });

  it("never puts more than 200 records in one request", async () => {
    const { buffer, batches } = harness((records) => accepted(records.length), { flushSize: 500 });
    for (let i = 0; i < 450; i += 1) buffer.enqueue(record(`id-${String(i)}`));
    await buffer.flush(2000);
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
  });

  it("keeps a batch under the byte cap", async () => {
    const { buffer, batches } = harness((records) => accepted(records.length), {
      flushSize: 200,
    });
    const big = "x".repeat(1_500_000);
    for (let i = 0; i < 4; i += 1) buffer.enqueue(record(`id-${String(i)}`, { output: { content: big } }));
    await buffer.flush(2000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(["id-0", "id-1", "id-2", "id-3"]);
  });

  it("drops a single record that could never fit in a request", async () => {
    const { buffer, batches } = harness(() => accepted(0));
    buffer.enqueue(record("huge", { output: { content: "x".repeat(4_100_000) } }));
    expect(buffer.pending).toBe(0);
    expect(buffer.snapshot().droppedTooLarge).toBe(1);
    await buffer.flush(100);
    expect(batches).toEqual([]);
  });

  it("drops the oldest record when the queue is full, and counts it", async () => {
    const { buffer, batches } = harness((records) => accepted(records.length), {
      maxQueue: 3,
      flushSize: 100,
    });
    for (const id of ["a", "b", "c", "d", "e"]) buffer.enqueue(record(id));
    expect(buffer.snapshot().droppedQueueFull).toBe(2);
    await buffer.flush(1000);
    expect(batches).toEqual([["c", "d", "e"]]);
  });
});

describe("responses", () => {
  it("reads partial acceptance and never resends an accepted id", async () => {
    const { buffer, batches, logger } = harness(
      () => ({
        kind: "accepted",
        accepted: 1,
        duplicates: 0,
        rejected: [{ index: 0, id: "bad", code: "invalid_request", message: "id must be a UUID" }],
      }),
      { flushSize: 2 },
    );
    buffer.enqueue(record("bad"));
    buffer.enqueue(record("good"));
    const result = await buffer.flush(1000);

    expect(batches).toEqual([["bad", "good"]]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.pending).toBe(0);
    expect(logger.lines.join("\n")).toMatch(/rejected/u);
  });

  it("retries the same batch with the same ids after a 429", async () => {
    const { buffer, batches } = harness(
      (_records, call) =>
        call === 0 ? { kind: "retry", reason: "429", retryInMs: 0 } : accepted(2),
      { flushSize: 2 },
    );
    buffer.enqueue(record("a"));
    buffer.enqueue(record("b"));
    const result = await buffer.flush(2000);

    expect(batches).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(result.pending).toBe(0);
  });

  it("holds later records behind the batch that is being retried", async () => {
    const { buffer, batches } = harness(
      (_records, call) => (call === 0 ? { kind: "retry", reason: "503", retryInMs: 0 } : accepted(1)),
      { flushSize: 1 },
    );
    buffer.enqueue(record("first"));
    await buffer.flush(500);
    buffer.enqueue(record("second"));
    await buffer.flush(2000);
    expect(batches).toEqual([["first"], ["first"], ["second"]]);
  });

  it("splits a 413 batch in half", async () => {
    const { buffer, batches } = harness(
      (_records, call) => (call === 0 ? { kind: "too_large" } : accepted(2)),
      { flushSize: 4 },
    );
    for (const id of ["a", "b", "c", "d"]) buffer.enqueue(record(id));
    await buffer.flush(2000);
    expect(batches).toEqual([
      ["a", "b", "c", "d"],
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops a single record the server answers 413 for", async () => {
    const { buffer, batches } = harness(() => ({ kind: "too_large" }), { flushSize: 1 });
    buffer.enqueue(record("a"));
    const result = await buffer.flush(1000);
    expect(batches).toEqual([["a"]]);
    expect(result.droppedTooLarge).toBe(1);
    expect(result.pending).toBe(0);
  });

  it("drops a batch on any other 4xx without retrying, and counts it", async () => {
    const { buffer, batches, logger } = harness(() => ({ kind: "drop", reason: "HTTP 403" }), {
      flushSize: 2,
    });
    buffer.enqueue(record("a"));
    buffer.enqueue(record("b"));
    const result = await buffer.flush(1000);
    expect(batches).toEqual([["a", "b"]]);
    expect(result.droppedRejected).toBe(2);
    expect(result.pending).toBe(0);
    expect(logger.lines.join("\n")).toMatch(/not retried/u);
  });

  it("gives up after the attempt bound, drops the batch and counts it", async () => {
    const { buffer, batches } = harness(() => ({ kind: "retry", reason: "503", retryInMs: 0 }), {
      flushSize: 1,
      maxAttempts: 3,
    });
    buffer.enqueue(record("a"));
    const result = await buffer.flush(2000);
    expect(batches.length).toBe(3);
    expect(result.droppedRetriesExhausted).toBe(1);
    expect(result.pending).toBe(0);
  });

  it("treats a thrown transport error as a retry", async () => {
    const { buffer, batches } = harness((_records, call) => {
      if (call === 0) throw new Error("fetch failed");
      return accepted(1);
    }, { flushSize: 1 });
    buffer.enqueue(record("a"));
    await buffer.flush(3000);
    expect(batches).toEqual([["a"], ["a"]]);
  });
});

describe("backoff", () => {
  it("doubles from one second and caps at five minutes", () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(20)).toBe(300_000);
  });
});
