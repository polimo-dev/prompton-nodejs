import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_FILTERS,
  ALLOWED_TAGS,
  applyPayloadPolicy,
  DEFAULT_PROMPT,
  decodeSnapshot,
  isTruncatedStop,
  lint,
  MissingVariableError,
  normalizeStopKind,
  promptNamesFromSnapshot,
  render,
  renderMessages,
  resolveFromSnapshot,
  sampleBucket,
  SCHEMA_VERSION,
  templateVariables,
  TemplateParseError,
  TemplateRenderError,
  UnknownPromptError,
  UnknownUseCaseError,
  UnresolvedError,
  canonicalJson,
  type Engine,
  type Message,
  type SnapshotData,
} from "../src/index.js";

/**
 * The cross-language conformance suite, copied verbatim from the reference implementation
 * (prompton-elixir/conformance). Every case in every file runs here; when two SDKs disagree about
 * how a prompt renders or how a log is truncated, an app that talks to PromptOn from two languages
 * gets two different answers, and that is what these files prevent.
 */

const DIR = join(import.meta.dirname, "conformance");

function load(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, any>;
}

/**
 * JavaScript has a single number type, so a value the fixture wrote as the float `2.0` arrives here
 * as the integer `2` and renders as `"2"`. Every other language in the suite keeps the decimal
 * point. The case still runs; only the expectation is language-specific.
 */
const NUMBER_TYPE_DEVIATIONS: Record<string, { output: string }> = {
  "stringify/float_integral": { output: "2" },
};

// ---------------------------------------------------------------------------
// template.json

describe("template.json", () => {
  const doc = load("template.json");

  it("declares the same whitelists as this SDK", () => {
    expect(doc["allowed_tags"]).toEqual([...ALLOWED_TAGS]);
    expect(doc["allowed_filters"]).toEqual([...ALLOWED_FILTERS]);
  });

  const cases = doc["cases"] as {
    name: string;
    template: string;
    variables: Record<string, unknown>;
    engine: Engine;
    expect: Record<string, unknown>;
    normative?: boolean;
    note?: string;
  }[];

  for (const testCase of cases) {
    const normative = testCase.normative !== false;
    it(`${normative ? "" : "[non-normative] "}${testCase.name}`, () => {
      let actual: Record<string, unknown>;
      try {
        actual = { output: render(testCase.template, testCase.variables, testCase.engine) };
      } catch (error) {
        if (error instanceof MissingVariableError) {
          actual = { error: "missing_variable", variable: error.variable };
        } else if (error instanceof TemplateParseError) {
          actual = { error: "parse_error" };
        } else if (error instanceof TemplateRenderError) {
          actual = { error: "render_error" };
        } else {
          throw error;
        }
      }

      const override = NUMBER_TYPE_DEVIATIONS[testCase.name];
      if (override) {
        expect(actual).toEqual(override);
        return;
      }
      if (!normative) {
        // Reference behaviour another SDK need not reproduce; the case runs, and either the
        // reference answer or a documented refusal is acceptable.
        expect(actual["output"] ?? actual["error"]).toBeDefined();
        return;
      }
      expect(actual).toEqual(testCase.expect);
    });
  }

  for (const testCase of doc["lint_cases"] as {
    name: string;
    template: string;
    expect: Record<string, unknown>;
  }[]) {
    it(`lint ${testCase.name}`, () => {
      const result = lint(testCase.template);
      const actual = result.ok
        ? { lint: "ok" }
        : { lint: "error", reasons: result.reasons.map((r) => ({ kind: r.kind, value: r.value })) };
      expect(actual).toEqual(testCase.expect);
    });
  }

  for (const testCase of doc["variables_cases"] as {
    name: string;
    template: string;
    expect: Record<string, unknown>;
  }[]) {
    it(`variables ${testCase.name}`, () => {
      expect({ variables: templateVariables(testCase.template) }).toEqual(testCase.expect);
    });
  }
});

// ---------------------------------------------------------------------------
// resolve.json

describe("resolve.json", () => {
  const doc = load("resolve.json");
  const snapshots = new Map<string, SnapshotData>();
  for (const [ref, raw] of Object.entries(doc["snapshots"] as Record<string, unknown>)) {
    snapshots.set(ref, decodeSnapshot(raw).data);
  }

  it("names the same default prompt", () => {
    expect(doc["default_prompt"]).toBe(DEFAULT_PROMPT);
  });

  it("every snapshot decodes as schema v3", () => {
    for (const data of snapshots.values()) {
      expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });

  for (const testCase of doc["cases"] as {
    name: string;
    snapshot_ref: string;
    environment: string;
    use_case: string;
    prompt?: string;
    variables?: Record<string, unknown>;
    expect: Record<string, unknown>;
  }[]) {
    it(testCase.name, () => {
      const data = snapshots.get(testCase.snapshot_ref) as SnapshotData;
      expect(data.environment).toBe(testCase.environment);
      expect(resolveExpectation(data, testCase)).toEqual(testCase.expect);
    });
  }
});

function resolveExpectation(
  data: SnapshotData,
  testCase: {
    use_case: string;
    prompt?: string;
    variables?: Record<string, unknown>;
  },
): Record<string, unknown> {
  let resolution;
  try {
    resolution = resolveFromSnapshot(data, testCase.use_case, { prompt: testCase.prompt ?? null });
  } catch (error) {
    if (error instanceof UnknownPromptError) {
      return {
        error: "unknown_prompt",
        prompt: error.prompt,
        available_prompts: error.availablePrompts,
      };
    }
    if (error instanceof UnknownUseCaseError) return { error: "unknown_use_case" };
    if (error instanceof UnresolvedError) return { error: "unresolved" };
    throw error;
  }

  const rendered: Record<string, unknown> = {};
  try {
    if (resolution.kind === "chat" && resolution.messages) {
      const messages =
        testCase.variables === undefined
          ? resolution.messages
          : renderMessages(resolution.messages, testCase.variables, resolution.engine ?? "liquid");
      rendered["messages"] = messages.map((m: Message) => ({ role: m.role, content: m.content }));
    } else if (resolution.kind === "text" && typeof resolution.textTemplate === "string") {
      rendered["text"] =
        testCase.variables === undefined
          ? resolution.textTemplate
          : render(resolution.textTemplate, testCase.variables, resolution.engine ?? "liquid");
    }
  } catch (error) {
    if (error instanceof MissingVariableError) {
      return { error: "missing_variable", variable: error.variable };
    }
    throw error;
  }

  return {
    kind: resolution.kind,
    deployment_id: resolution.deploymentId,
    revision: resolution.deploymentRevision,
    prompt: resolution.prompt,
    prompts: promptNamesFromSnapshot(data, testCase.use_case),
    model_id: resolution.modelId,
    model: resolution.model,
    provider: resolution.provider,
    effective_params: resolution.params,
    effective_provider_options: resolution.providerOptions,
    prompt_version:
      resolution.promptVersionId === null
        ? null
        : { id: resolution.promptVersionId, number: resolution.promptVersionNumber },
    warnings: resolution.warnings.map((w) => `${w.kind}: ${w.detail}`),
    ...rendered,
  };
}

// ---------------------------------------------------------------------------
// truncation.json

describe("truncation.json", () => {
  const doc = load("truncation.json");

  for (const testCase of doc["cases"] as {
    name: string;
    policy: { mode: string; sample_rate: number; max_bytes: number };
    config?: { hash_end_user?: boolean };
    generation: Record<string, unknown>;
    expect: { generation: Record<string, unknown> };
  }[]) {
    it(testCase.name, () => {
      const actual = applyPayloadPolicy(
        testCase.generation,
        {
          mode: testCase.policy.mode,
          sampleRate: testCase.policy.sample_rate,
          maxBytes: testCase.policy.max_bytes,
        },
        { hashEndUser: testCase.config?.hash_end_user === true },
      );
      expect(actual).toEqual(testCase.expect.generation);
    });
  }

  for (const bucket of doc["sampling"]["buckets"] as { id: string; bucket: number }[]) {
    it(`sampling bucket of ${JSON.stringify(bucket.id)}`, () => {
      expect(sampleBucket(bucket.id)).toBe(bucket.bucket);
    });
  }

  it("every truncated string stays valid UTF-8 and within its cap", () => {
    for (const testCase of doc["cases"] as {
      name: string;
      policy: { max_bytes: number };
      expect: { generation: Record<string, any> };
    }[]) {
      const maxBytes = testCase.policy.max_bytes;
      const generation = testCase.expect.generation;
      for (const message of (generation["input"]?.["messages"] ?? []) as Record<string, unknown>[]) {
        if (typeof message["content"] !== "string") continue;
        expect(Buffer.byteLength(message["content"], "utf8"), testCase.name).toBeLessThanOrEqual(
          Math.max(Math.trunc(maxBytes / 8), 64),
        );
        expect(Buffer.from(message["content"], "utf8").toString("utf8")).toBe(message["content"]);
      }
      const content = generation["output"]?.["content"];
      if (typeof content === "string") {
        expect(Buffer.byteLength(content, "utf8"), testCase.name).toBeLessThanOrEqual(
          Math.max(Math.trunc(maxBytes / 4), 64),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// stop_kind.json

describe("stop_kind.json", () => {
  const doc = load("stop_kind.json");
  for (const testCase of doc["cases"] as {
    finish_reason: string | null;
    stop_kind: string;
    truncated: boolean;
    source?: string;
  }[]) {
    it(`${JSON.stringify(testCase.finish_reason)} -> ${testCase.stop_kind}`, () => {
      const kind = normalizeStopKind(testCase.finish_reason);
      expect(kind).toBe(testCase.stop_kind);
      expect(isTruncatedStop(testCase.finish_reason)).toBe(testCase.truncated);
      expect(normalizeStopKind(kind)).toBe(kind);
    });
  }
});

// ---------------------------------------------------------------------------
// generation_record.json

describe("generation_record.json", () => {
  const doc = load("generation_record.json");
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const records = (doc["records"] as { name: string; record: Record<string, any> }[]).map(
    (entry) => entry,
  );

  for (const { name, record } of records) {
    it(`${name} satisfies the ingest rules`, () => {
      for (const field of ["id", "use_case", "model", "status", "started_at"]) {
        expect(record, field).toHaveProperty(field);
      }
      expect(record["id"]).toMatch(UUID);
      expect((record["id"] as string)[14], "id must be a UUIDv7, not a v4").toBe("7");
      expect(["ok", "error"]).toContain(record["status"]);
      expect(Number.isNaN(Date.parse(record["started_at"] as string))).toBe(false);
      expect(Buffer.byteLength(record["use_case"] as string)).toBeLessThanOrEqual(512);
      expect(Buffer.byteLength(record["model"] as string)).toBeLessThanOrEqual(512);

      optionalEnum(record["kind"], ["chat", "text", "embedding"]);
      optionalEnum(record["provider"], ["openrouter", "groq", "openai", "anthropic", "google", "other"]);
      optionalEnum(record["stop_kind"], ["stop", "length", "tool_call", "content_filter", "other"]);
      optionalEnum(record["resolution_source"], ["remote", "disk", "bundle", "manual"]);
      optionalEnum(record["usage"]?.["cost_source"], ["provider", "catalog", "unknown"]);

      for (const key of ["deployment_id", "prompt_version_id", "model_id"]) {
        if (record[key]) expect(record[key]).toMatch(UUID);
      }
      if (record["error"]) {
        expect([
          "http_4xx",
          "http_5xx",
          "rate_limited",
          "timeout",
          "transport",
          "parse",
          "app",
        ]).toContain(record["error"]["kind"]);
        expect(Buffer.byteLength(record["error"]["message"] ?? "")).toBeLessThanOrEqual(2048);
      }
      expect(Buffer.byteLength(canonicalJson(record["context"] ?? {}))).toBeLessThanOrEqual(2048);
      expect(Buffer.byteLength(canonicalJson(record["metadata"] ?? {}))).toBeLessThanOrEqual(4096);
      expect(Buffer.byteLength(canonicalJson(record["params"] ?? {}))).toBeLessThanOrEqual(4096);
      expect(
        Buffer.byteLength(canonicalJson(record["usage"]?.["raw"] ?? {})),
      ).toBeLessThanOrEqual(16384);

      const json = JSON.stringify(record);
      expect(json.includes(" ")).toBe(false);
    });

    it(`${name} passes through the payload policy unchanged`, () => {
      expect(applyPayloadPolicy(record, { mode: "full", sampleRate: 1.0, maxBytes: 262144 }, {})).toEqual(
        record,
      );
    });
  }

  it("the batch envelope holds exactly the documented records", () => {
    const bare = records.map((entry) => entry.record);
    expect(doc["batch_envelope"]["request"]["generations"]).toEqual(bare);
    expect(doc["batch_envelope"]["response_example"]["accepted"]).toBe(bare.length);
    expect(doc["batch_envelope"]["response_on_resend"]["duplicates"]).toBe(bare.length);
    expect(bare.length).toBeLessThanOrEqual(doc["endpoint"]["max_records_per_request"]);
  });
});

describe("every fixture", () => {
  for (const name of [
    "template.json",
    "resolve.json",
    "truncation.json",
    "stop_kind.json",
    "generation_record.json",
  ]) {
    it(`${name} is format version 1 and names itself`, () => {
      const doc = load(name);
      expect(doc["format_version"]).toBe(1);
      expect(doc["conformance"]).toBe(name.replace(/\.json$/u, ""));
      expect(doc["generated_from"]["repo"]).toBe("https://github.com/polimo-dev/prompton-elixir");
    });
  }
});

function optionalEnum(value: unknown, allowed: string[]): void {
  if (value === undefined || value === null) return;
  expect(allowed).toContain(value);
}
