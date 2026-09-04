import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  applyPayloadPolicy,
  canonicalJson,
  isUuid,
  keepPayload,
  normalizePolicy,
  sampleBucket,
  truncateBytes,
  uuidv7,
  uuidv7Timestamp,
} from "../src/index.js";
import { recordingLogger } from "./helpers.js";

/** Behaviour of the payload policy and the id generator beyond the conformance cases. */

describe("truncateBytes", () => {
  it("leaves a string under the cap alone", () => {
    expect(truncateBytes("hello", 64)).toEqual(["hello", false]);
  });

  it("keeps head and tail and never exceeds the cap", () => {
    const [out, truncated] = truncateBytes("x".repeat(500), 100);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(100);
    expect(out).toContain("…[truncated 400 bytes]…");
    expect(out.startsWith("x")).toBe(true);
    expect(out.endsWith("x")).toBe(true);
  });

  it("never splits a multi-byte character", () => {
    const [out] = truncateBytes("한".repeat(300), 101);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(101);
    expect(Buffer.from(out, "utf8").toString("utf8")).toBe(out);
    expect(out).not.toContain("�");
  });

  it("keeps only the head when the cap is smaller than the marker", () => {
    const [out, truncated] = truncateBytes("abcdefghij", 4);
    expect(truncated).toBe(true);
    expect(out).toBe("abcd");
  });
});

describe("policy normalisation", () => {
  it("keeps a sample rate of zero rather than treating it as absent", () => {
    expect(normalizePolicy({ sampleRate: 0 }, undefined).sampleRate).toBe(0);
  });

  it("clamps the sample rate and falls back on an unknown mode", () => {
    expect(normalizePolicy({ sampleRate: 5, mode: "weird" }, undefined)).toEqual({
      mode: "full",
      sampleRate: 1,
      maxBytes: 262144,
    });
  });

  it("takes the app's defaults when the snapshot has no policy", () => {
    expect(normalizePolicy(null, { maxBytes: 1024 })).toEqual({
      mode: "full",
      sampleRate: 1,
      maxBytes: 1024,
    });
  });
});

describe("sampling", () => {
  it("keeps errors and length truncations whatever the rate", () => {
    expect(keepPayload({ status: "error" }, 0)).toBe(true);
    expect(keepPayload({ status: "ok", stop_kind: "length" }, 0)).toBe(true);
    expect(keepPayload({ status: "ok" }, 0)).toBe(false);
  });

  it("decides from the id alone, so a resend decides the same way", () => {
    const id = "0198f2a1-0000-7000-8000-00000000100f";
    expect(sampleBucket(id)).toBe(7030);
    expect(keepPayload({ id, status: "ok" }, 0.5)).toBe(false);
    expect(keepPayload({ id, status: "ok" }, 0.8)).toBe(true);
  });
});

describe("the tail of the pipeline", () => {
  it("hashes end_user_ref when asked", () => {
    const out = applyPayloadPolicy(
      { id: "x", end_user_ref: "user-42", status: "ok" },
      null,
      { hashEndUser: true },
    );
    expect(out["end_user_ref"]).toBe(createHash("sha256").update("user-42").digest("hex"));
  });

  it("runs the redaction hook after truncation", () => {
    const seen: unknown[] = [];
    const out = applyPayloadPolicy(
      { id: "x", status: "ok", input: { text: "y".repeat(400) } },
      { mode: "full", sampleRate: 1, maxBytes: 128 },
      {
        redact: (record) => {
          seen.push(record);
          return { ...record, input: { text: "[redacted]" } };
        },
      },
    );
    expect((seen[0] as Record<string, any>)["input"]["truncated"]).toBe(true);
    expect(out["input"]).toEqual({ text: "[redacted]" });
  });

  it("drops the payload when the redaction hook throws", () => {
    const logger = recordingLogger();
    const out = applyPayloadPolicy(
      { id: "x", status: "ok", input: { text: "secret" }, output: { content: "answer" } },
      null,
      {
        logger,
        redact: () => {
          throw new Error("boom");
        },
      },
    );
    expect(out).not.toHaveProperty("input");
    expect(out).not.toHaveProperty("output");
    expect(logger.lines.join("\n")).toMatch(/redact hook threw/u);
  });

  it("caps error.message at 2048 bytes whatever max_bytes is", () => {
    const out = applyPayloadPolicy(
      { id: "x", status: "error", error: { kind: "app", message: "e".repeat(5000) } },
      { mode: "full", sampleRate: 1, maxBytes: 262144 },
      {},
    );
    const message = (out["error"] as Record<string, string>)["message"] as string;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2048);
  });
});

describe("canonical JSON", () => {
  it("sorts keys and writes no whitespace, so digests match across languages", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });
});

describe("uuidv7", () => {
  it("carries the version nibble, the variant and the time", () => {
    const now = 1_756_900_000_000;
    const id = uuidv7(now);
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19] as string);
    expect(uuidv7Timestamp(id)).toBe(now);
  });

  it("sorts by time across milliseconds", () => {
    const first = uuidv7(1_000_000_000_000);
    const second = uuidv7(1_000_000_000_001);
    expect(first < second).toBe(true);
  });

  it("does not repeat", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7()));
    expect(ids.size).toBe(5000);
  });
});
