import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidRecordError,
  MissingVariableError,
  NoTemplateError,
  PromptOn,
  UnknownPromptError,
  UnknownUseCaseError,
  UnresolvedError,
  type Message,
} from "../src/index.js";
import { fakeFetch, recordingLogger, snapshotDocument, snapshotResponse } from "./helpers.js";

const clients: PromptOn[] = [];

function make(options: ConstructorParameters<typeof PromptOn>[0] = {}): PromptOn {
  const client = new PromptOn({
    logger: recordingLogger(),
    diskCache: false,
    poll: false,
    flushOnExit: false,
    ...options,
  });
  clients.push(client);
  return client;
}

function loaded(options: ConstructorParameters<typeof PromptOn>[0] = {}): PromptOn {
  const client = make({ mode: "test", ...options });
  client.loadSnapshot(snapshotDocument());
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(200)));
});

describe("resolution", () => {
  it("resolves a chat use case and renders it", () => {
    const client = loaded();
    const resolution = client.resolve("greeting");
    expect(resolution).toMatchObject({
      useCase: "greeting",
      kind: "chat",
      prompt: "default",
      model: "openai/gpt-4o-mini",
      provider: "openrouter",
      deploymentRevision: 3,
      source: "manual",
      availablePrompts: ["default", "ko"],
    });
    expect(resolution.params).toEqual({ temperature: 0.2, max_tokens: 512 });
    expect(resolution.providerOptions).toEqual({ only: ["OpenAI"] });

    const messages = client.renderChat(resolution, { name: "Ada" });
    expect(messages).toEqual([
      { role: "system", content: "You are a friendly greeter." },
      { role: "user", content: "Say hello to Ada." },
    ]);
  });

  it("selects a prompt by name", () => {
    const client = loaded();
    const messages = client.renderChat(client.resolve("greeting", { prompt: "ko" }), {
      name: "아다",
    });
    expect((messages[1] as Message).content).toBe("아다님에게 인사해줘.");
  });

  it("renders a text use case", () => {
    const client = loaded();
    const text = client.renderText(client.resolve("summarize"), { items: ["a", "b"] });
    expect(text).toBe("Summarize:\n- a\n- b\n");
  });

  it("has no template for an embedding use case", () => {
    const client = loaded();
    const resolution = client.resolve("embed");
    expect(resolution.prompt).toBeNull();
    expect(resolution.promptVersionId).toBeNull();
    expect(() => client.render(resolution)).toThrowError(NoTemplateError);
  });

  it("reports a missing variable by name", () => {
    const client = loaded();
    try {
      client.renderChat(client.resolve("greeting"), {});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingVariableError);
      expect((error as MissingVariableError).variable).toBe("name");
    }
  });

  it("refuses an unpinned prompt name rather than falling back to default", () => {
    const client = loaded();
    try {
      client.resolve("greeting", { prompt: "fr" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPromptError);
      expect((error as UnknownPromptError).availablePrompts).toEqual(["default", "ko"]);
    }
  });

  it("distinguishes an unknown use case from one that is not deployed", () => {
    const client = loaded();
    expect(() => client.resolve("nope")).toThrowError(UnknownUseCaseError);
    expect(() => client.resolve("draft")).toThrowError(UnresolvedError);
  });

  it("lists the pinned prompt names", () => {
    const client = loaded();
    expect(client.promptNames("greeting")).toEqual(["default", "ko"]);
    expect(client.promptNames("draft")).toEqual([]);
  });
});

describe("test mode", () => {
  it("captures records instead of sending them, and makes no HTTP call", async () => {
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = loaded({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch });
    const resolution = client.resolve("greeting");

    await client.withGeneration(
      resolution,
      { variables: { name: "Ada" }, endUserRef: "u_1", traceId: "job:1" },
      () => ({ content: "Hello, Ada!", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 4 } }),
    );

    expect(fetch.calls.length).toBe(0);
    expect(client.logs.length).toBe(1);
    const log = client.logs[0] as Record<string, unknown>;
    expect(log).toMatchObject({
      use_case: "greeting",
      model: "openai/gpt-4o-mini",
      provider: "openrouter",
      status: "ok",
      stop_kind: "stop",
      deployment_revision: 3,
      prompt: "default",
      resolution_source: "manual",
      trace_id: "job:1",
      end_user_ref: "u_1",
      sdk: { name: "prompton-nodejs", version: "0.1.0" },
    });
    expect(log["output"]).toEqual({ content: "Hello, Ada!" });
    expect(typeof log["latency_ms"]).toBe("number");
    expect(String(log["id"])[14]).toBe("7");
  });

  it("logs the failure and rethrows the original error unchanged", async () => {
    const client = loaded();
    const resolution = client.resolve("greeting");
    const boom = Object.assign(new Error("rate limited by upstream"), { status: 429 });

    await expect(
      client.withGeneration(resolution, {}, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const log = client.logs[0] as Record<string, any>;
    expect(log["status"]).toBe("error");
    expect(log["error"]).toEqual({
      kind: "rate_limited",
      status: 429,
      message: "rate limited by upstream",
    });
  });

  it("returns the call's own value untouched", async () => {
    const client = loaded();
    const value = { content: "hi", extra: [1, 2, 3] };
    const returned = await client.withGeneration(client.resolve("greeting"), {}, () => value);
    expect(returned).toBe(value);
  });
});

describe("log()", () => {
  it("fills in id, started_at and sdk", () => {
    const client = loaded();
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const log = client.logs[0] as Record<string, unknown>;
    expect(String(log["id"])).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof log["started_at"]).toBe("string");
    expect(log["sdk"]).toEqual({ name: "prompton-nodejs", version: "0.1.0" });
  });

  it("fills the resolution evidence when a resolution is passed", () => {
    const client = loaded();
    const resolution = client.resolve("greeting", { prompt: "ko" });
    client.log({ status: "ok" }, { resolution });
    expect(client.logs[0]).toMatchObject({
      use_case: "greeting",
      model: "openai/gpt-4o-mini",
      prompt: "ko",
      deployment_id: "0198f2a1-0000-7000-8000-00000000d001",
      deployment_revision: 3,
      prompt_version_id: "0198f2a1-0000-7000-8000-00000000a002",
      model_id: "0198f2a1-0000-7000-8000-00000000e001",
      resolution_source: "manual",
    });
  });

  it("refuses a record with no status", () => {
    const client = loaded();
    expect(() => client.log({ use_case: "greeting", model: "m" })).toThrowError(InvalidRecordError);
  });

  it("applies the use case's payload policy from the snapshot", () => {
    const client = loaded();
    const document = snapshotDocument();
    (document["use_cases"] as any)["greeting"]["payload_policy"] = {
      mode: "none",
      sample_rate: 1.0,
      max_bytes: 262144,
    };
    client.loadSnapshot(document);
    client.log({
      use_case: "greeting",
      model: "m",
      status: "ok",
      input: { text: "secret" },
      output: { content: "answer" },
    });
    expect(client.logs[0]).not.toHaveProperty("input");
    expect(client.logs[0]).not.toHaveProperty("output");
  });

  it("hashes end_user_ref and runs the redaction hook last", () => {
    const client = loaded({
      hashEndUser: true,
      redact: (record) => ({ ...record, metadata: { redacted: true } }),
    });
    client.log({ use_case: "greeting", model: "m", status: "ok", end_user_ref: "user-42" });
    const log = client.logs[0] as Record<string, unknown>;
    expect(log["end_user_ref"]).toBe(createHash("sha256").update("user-42").digest("hex"));
    expect(log["metadata"]).toEqual({ redacted: true });
  });
});

describe("sending monitoring logs", () => {
  it("posts one batch per environment to /generations", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), {
        status: 202,
      });
    });
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      environment: "staging",
    });
    client.loadSnapshot(snapshotDocument("staging"));
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);

    const post = fetch.calls.find((call) => call.url.includes("/generations"));
    expect(post?.url).toBe("http://ptn.test/api/v1/generations?environment=staging");
    expect((post?.init?.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer ptn_sdkfixture_key",
    );
    expect((post?.init?.headers as Record<string, string>)["user-agent"]).toMatch(
      /^prompton-nodejs\/\d+\.\d+\.\d+$/u,
    );
    const body = JSON.parse(post?.init?.body as string) as { generations: unknown[] };
    expect(body.generations.length).toBe(1);
    expect(result.accepted).toBe(1);
  });

  it("counts duplicates on a resend", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify({ accepted: 0, duplicates: 1, rejected: [] }), {
        status: 202,
      });
    });
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch });
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);
    expect(result.duplicates).toBe(1);
  });

  it("does not retry a 403", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      return new Response(
        JSON.stringify({ error: { code: "forbidden", message: "API key lacks the logs scope" } }),
        { status: 403 },
      );
    });
    const logger = recordingLogger();
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch, logger });
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);

    expect(fetch.calls.filter((call) => call.url.includes("/generations")).length).toBe(1);
    expect(result.droppedRejected).toBe(1);
    expect(logger.lines.join("\n")).toMatch(/lacks the logs scope/u);
  });

  it("flushes what is queued when the client is closed", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify({ accepted: 2, duplicates: 0, rejected: [] }), {
        status: 202,
      });
    });
    const client = new PromptOn({
      apiKey: "ptn_k_1",
      baseUrl: "http://ptn.test",
      fetch,
      diskCache: false,
      poll: false,
      logger: recordingLogger(),
    });
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const result = await client.close(2000);
    expect(result.pending).toBe(0);
    expect(result.accepted).toBe(2);
  });
});

describe("offline mode", () => {
  it("makes no HTTP call at all", async () => {
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = make({ mode: "offline", apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch });
    client.loadSnapshot(snapshotDocument());
    expect(client.resolve("greeting").model).toBe("openai/gpt-4o-mini");
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    await client.flush(500);
    expect(fetch.calls.length).toBe(0);
  });
});
