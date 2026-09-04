import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  ALLOWED_FILTERS,
  ALLOWED_TAGS,
  applyPayloadPolicy,
  decodeUseCaseDocument,
  isTruncatedStop,
  lint,
  MissingVariableError,
  normalizeStopKind,
  render,
  renderMessages,
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
  type UseCaseDocument,
} from "../src/index.js";
import { DEFAULT_PROMPT, promptNamesFromSnapshot, resolveFromSnapshot } from "../src/resolver.js";

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
// use_case.json

describe("use_case.json", () => {
  const doc = load("use_case.json");
  const documents = new Map<string, UseCaseDocument>();
  for (const [ref, raw] of Object.entries(doc["documents"] as Record<string, unknown>)) {
    documents.set(ref, decodeUseCaseDocument(raw).data);
  }

  it("names the same default prompt", () => {
    expect(doc["default_prompt"]).toBe(DEFAULT_PROMPT);
  });

  it("every use-case document decodes as schema v4", () => {
    for (const data of documents.values()) {
      expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    }
  });

  it("requires schema_version to be exactly integer 4", () => {
    const base = doc["documents"]["production"] as Record<string, unknown>;
    for (const patch of [
      { schema_version: 3 },
      { schema_version: 5 },
      { schema_version: "4" },
      { schema_version: undefined },
    ]) {
      const candidate = { ...base, ...patch };
      if (patch.schema_version === undefined) delete candidate["schema_version"];
      expect(() => decodeUseCaseDocument(candidate)).toThrow(/schema_version/u);
    }

    const legacy: Record<string, unknown> = { ...base, version: SCHEMA_VERSION };
    delete legacy["schema_version"];
    expect(() => decodeUseCaseDocument(legacy)).toThrow(/schema_version/u);
  });

  for (const testCase of doc["cases"] as {
    name: string;
    document_ref: string;
    environment: string;
    use_case: string;
    prompt?: string;
    variables?: Record<string, unknown>;
    expect: Record<string, unknown>;
  }[]) {
    it(testCase.name, () => {
      const data = documents.get(testCase.document_ref) as UseCaseDocument;
      expect(data.environment).toBe(testCase.environment);
      expect(resolveExpectation(data, testCase)).toEqual(testCase.expect);
    });
  }
});

function resolveExpectation(
  data: UseCaseDocument,
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
        key: error.useCase,
        prompt: error.prompt,
        prompt_names: error.promptNames,
      };
    }
    if (error instanceof UnknownUseCaseError) {
      return { error: "unknown_use_case", key: error.useCase };
    }
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
    key: resolution.useCase,
    source: resolution.source,
    kind: resolution.kind,
    deployment_id: resolution.deploymentId,
    revision: resolution.deploymentRevision,
    prompt: resolution.prompt,
    prompt_names: promptNamesFromSnapshot(data, testCase.use_case),
    model_id: resolution.modelId,
    model: resolution.model,
    provider: resolution.provider,
    params: resolution.params,
    provider_options: resolution.providerOptions,
    prompt_version:
      resolution.promptVersionId === null
        ? null
        : { id: resolution.promptVersionId, number: resolution.promptVersionNumber },
    warnings: resolution.warnings.map((w: { kind: string; detail: unknown }) => `${w.kind}: ${String(w.detail)}`),
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
    log: Record<string, unknown>;
    expect: { log: Record<string, unknown> };
  }[]) {
    it(testCase.name, () => {
      const actual = applyPayloadPolicy(
        testCase.log,
        {
          mode: testCase.policy.mode,
          sampleRate: testCase.policy.sample_rate,
          maxBytes: testCase.policy.max_bytes,
        },
        { hashEndUser: testCase.config?.hash_end_user === true },
      );
      expect(actual).toEqual(testCase.expect.log);
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
      expect: { log: Record<string, any> };
    }[]) {
      const maxBytes = testCase.policy.max_bytes;
      const log = testCase.expect.log;
      for (const message of (log["input"]?.["messages"] ?? []) as Record<string, unknown>[]) {
        if (typeof message["content"] !== "string") continue;
        expect(Buffer.byteLength(message["content"], "utf8"), testCase.name).toBeLessThanOrEqual(
          Math.max(Math.trunc(maxBytes / 8), 64),
        );
        expect(Buffer.from(message["content"], "utf8").toString("utf8")).toBe(message["content"]);
      }
      const content = log["output"]?.["content"];
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
// log_record.json

describe("log_record.json", () => {
  const doc = load("log_record.json");
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
      optionalEnum(record["source"], ["remote", "disk", "bundle", "manual"]);
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
      expect(json.includes(String.fromCharCode(0))).toBe(false);
    });

    it(`${name} passes through the payload policy unchanged`, () => {
      expect(applyPayloadPolicy(record, { mode: "full", sampleRate: 1.0, maxBytes: 262144 }, {})).toEqual(
        record,
      );
    });
  }

  it("the batch envelope holds exactly the documented records", () => {
    const bare = records.map((entry) => entry.record);
    expect(doc["batch_envelope"]["request"]["logs"]).toEqual(bare);
    expect(doc["batch_envelope"]["response_example"]["accepted"]).toBe(bare.length);
    expect(doc["batch_envelope"]["response_on_resend"]["duplicates"]).toBe(bare.length);
    expect(bare.length).toBeLessThanOrEqual(doc["endpoint"]["max_records_per_request"]);
  });
});

describe("every fixture", () => {
  for (const name of [
    "template.json",
    "use_case.json",
    "truncation.json",
    "stop_kind.json",
    "log_record.json",
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
