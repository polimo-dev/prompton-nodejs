import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidRecordError,
  MissingVariableError,
  NoTemplateError,
  PreparedRequestError,
  PromptOn,
  UnknownPromptError,
  UnknownTemplateError,
  UnresolvedError,
  VERSION,
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
  client.loadPrompts(snapshotDocument());
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(200)));
});

describe("resolution", () => {
  it("resolves a chat prompt and renders it", () => {
    const client = loaded();
    const prompt = client.prompt("greeting");
    expect({
      key: prompt.key,
      kind: prompt.kind,
      template: prompt.template,
      model: prompt.model,
      provider: prompt.provider,
      deployment: prompt.deployment,
      source: prompt.source,
      templateNames: prompt.templateNames,
    }).toMatchObject({
      key: "greeting",
      kind: "chat",
      template: "default",
      model: "openai/gpt-4o-mini",
      provider: "openrouter",
      deployment: { revision: 3 },
      source: "manual",
      templateNames: ["default", "ko"],
    });
    expect(prompt.params).toEqual({ temperature: 0.2, max_tokens: 512 });
    expect(prompt.providerOptions).toEqual({ only: ["OpenAI"] });

    const messages = prompt.messages({ name: "Ada" });
    expect(messages).toEqual([
      { role: "system", content: "You are a friendly greeter." },
      { role: "user", content: "Say hello to Ada." },
    ]);
  });

  it("selects a prompt by name", () => {
    const client = loaded();
    const messages = client.prompt("greeting", { template: "ko" }).messages({
      name: "아다",
    });
    expect((messages[1] as Message).content).toBe("아다님에게 인사해줘.");
  });

  it("uses the prompt selected during render as the following track evidence", async () => {
    const client = loaded();
    const prompt = client.prompt("greeting");

    expect(prompt.messages({ name: "아다" }, { template: "ko" })[1]?.content).toBe(
      "아다님에게 인사해줘.",
    );
    await prompt.track(() => ({ content: "안녕", finishReason: "stop" }));

    expect(client.logs[0]).toMatchObject({
      template: "ko",
      prompt_version_id: "0198f2a1-0000-7000-8000-00000000a002",
    });
  });

  it("does not let a failed named-prompt render poison following track evidence", async () => {
    const client = loaded();
    const prompt = client.prompt("greeting");

    expect(() => prompt.messages({}, { template: "ko" })).toThrowError(MissingVariableError);
    await prompt.track(() => ({ content: "Hello", finishReason: "stop" }));

    expect(prompt.template).toBe("default");
    expect(client.logs[0]).toMatchObject({
      template: "default",
      prompt_version_id: "0198f2a1-0000-7000-8000-00000000a001",
    });
  });

  it("renders a text prompt", () => {
    const client = loaded();
    const text = client.prompt("summarize").text({ items: ["a", "b"] });
    expect(text).toBe("Summarize:\n- a\n- b\n");
  });

  it("prepares a chat completions request without calling the provider", () => {
    const client = loaded();
    const request = client.prompt("greeting").request(
      { name: "Ada" },
      { params: { temperature: 0.4, max_tokens: null } },
    );

    expect(request).toEqual({
      api: "chat_completions",
      method: "POST",
      path: "/api/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a friendly greeter." },
          { role: "user", content: "Say hello to Ada." },
        ],
        temperature: 0.4,
        usage: { include: true },
        provider: { only: ["OpenAI"] },
      },
    });
  });

  it("rejects protected chat request parameters", () => {
    const client = loaded();
    expect(() => client.prompt("greeting").request({ name: "Ada" }, { params: { model: "x" } }))
      .toThrowError(PreparedRequestError);
  });

  it("prepares a Decisions request by rendering state and guidance values", () => {
    const client = loaded();
    const request = client.prompt("sentiment").request(
      { diary: "Today was bright" },
      {
        providerOptions: { order: ["Fireworks"] },
        session_id: "session-1",
        user: "user-42",
        trace: { id: "trace-1" },
      },
    );

    expect(request).toEqual({
      api: "decisions",
      method: "POST",
      path: "/api/alpha/decisions",
      body: {
        model: "typesafe/jev-1.13",
        state: { diary: "Today was bright", static_key: "literal" },
        questions: {
          mood: {
            type: "choice",
            instructions: "Classify Today was bright.",
            criteria: {
              positive: "The diary feels upbeat.",
              negative: "The diary feels difficult.",
            },
          },
          intensity: {
            type: "score",
            instructions: "Rate intensity.",
            criteria: ["calm", "strong"],
          },
        },
        provider: { order: ["Fireworks"] },
        session_id: "session-1",
        user: "user-42",
        trace: { id: "trace-1" },
      },
    });
  });

  it("rejects Decisions sampling params because the API only accepts explicit metadata", () => {
    const client = loaded();
    expect(() => client.prompt("sentiment").request({ diary: "x" }, { params: { temperature: 0 } }))
      .toThrowError(PreparedRequestError);
  });

  it("accepts only Decisions metadata params", () => {
    const client = loaded();
    const request = client.prompt("sentiment").request(
      { diary: "x" },
      { params: { session_id: "s1", user: "u1", trace: { id: "t1" } } },
    );
    expect(request.body).toMatchObject({ session_id: "s1", user: "u1", trace: { id: "t1" } });
    expect(() =>
      client.prompt("sentiment").request({ diary: "x" }, { params: { trace: "t1" } }),
    ).toThrowError(PreparedRequestError);
  });

  it("keeps legacy schema 5 documents readable but cannot prepare requests without metadata", () => {
    const legacy = snapshotDocument();
    legacy["schema_version"] = 5;
    for (const deployment of Object.values(legacy["deployments"] as Record<string, Record<string, unknown>>)) {
      delete deployment["api"];
      delete deployment["request_path"];
    }
    const client = make({ mode: "test" });
    client.loadPrompts(legacy);

    expect(client.prompt("greeting").messages({ name: "Ada" })[1]?.content).toBe("Say hello to Ada.");
    expect(() => client.prompt("greeting").request({ name: "Ada" })).toThrowError(PreparedRequestError);
  });

  it("has no template for an embedding prompt", () => {
    const client = loaded();
    const prompt = client.prompt("embed");
    expect(prompt.template).toBeNull();
    expect(prompt.promptVersion).toBeNull();
    expect(() => prompt.messages()).toThrowError(NoTemplateError);
  });

  it("reports a missing variable by name", () => {
    const client = loaded();
    try {
      client.prompt("greeting").messages({});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingVariableError);
      expect((error as MissingVariableError).variable).toBe("name");
    }
  });

  it("refuses an unpinned prompt name rather than falling back to default", () => {
    const client = loaded();
    try {
      client.prompt("greeting", { template: "fr" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownTemplateError);
      expect((error as UnknownTemplateError).templateNames).toEqual(["default", "ko"]);
    }
  });

  it("distinguishes an unknown prompt from one that is not deployed", () => {
    const client = loaded();
    expect(() => client.prompt("nope")).toThrowError(UnknownPromptError);
    expect(() => client.prompt("draft")).toThrowError(UnresolvedError);
  });

  it("lists the pinned prompt names", () => {
    const client = loaded();
    expect(client.templateNames("greeting")).toEqual(["default", "ko"]);
    expect(client.templateNames("draft")).toEqual([]);
  });
});

describe("test mode", () => {
  it("captures records instead of sending them, and makes no HTTP call", async () => {
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = loaded({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch });
    const prompt = client.prompt("greeting");

    await prompt.track(
      () => ({ content: "Hello, Ada!", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 4 } }),
      { variables: { name: "Ada" }, endUserRef: "u_1", traceId: "job:1" },
    );

    expect(fetch.calls.length).toBe(0);
    expect(client.logs.length).toBe(1);
    const log = client.logs[0] as Record<string, unknown>;
    expect(log).toMatchObject({
      prompt_key: "greeting",
      model: "openai/gpt-4o-mini",
      provider: "openrouter",
      status: "ok",
      stop_kind: "stop",
      deployment_revision: 3,
      template: "default",
      source: "manual",
      trace_id: "job:1",
      end_user_ref: "u_1",
      sdk: { name: "prompton-nodejs", version: VERSION },
    });
    expect(log["output"]).toEqual({ content: "Hello, Ada!" });
    expect(typeof log["latency_ms"]).toBe("number");
    expect(String(log["id"])[14]).toBe("7");
  });

  it("logs the failure and rethrows the original error unchanged", async () => {
    const client = loaded();
    const prompt = client.prompt("greeting");
    const boom = Object.assign(new Error("rate limited by upstream"), { status: 429 });

    await expect(
      prompt.track(() => {
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
    const returned = await client.prompt("greeting").track(() => value);
    expect(returned).toBe(value);
  });

  it("never lets a broken record replace the provider's own error", async () => {
    const logger = recordingLogger();
    const client = loaded({ logger, strictRecords: true });
    const resolution = (client.prompt("greeting") as unknown as { currentResolution: object })
      .currentResolution;
    const poisoned = Object.create(Object.getPrototypeOf(resolution) as object, {
      ...Object.getOwnPropertyDescriptors(resolution),
      params: {
        get() {
          throw new Error("record builder blew up");
        },
      },
    }) as typeof resolution;
    const boom = new Error("the provider is down");

    await expect(
      (
        client as unknown as {
          trackPrompt: typeof poisoned extends never
            ? never
            : (current: typeof poisoned, meta: object, call: () => never) => Promise<never>;
        }
      ).trackPrompt(poisoned, {}, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(client.logs).toHaveLength(0);
    expect(client.stats().droppedInvalid).toBe(1);
    expect(logger.lines.join("\n")).toMatch(/record builder blew up/u);
  });

  it("never lets a broken record fail a successful call", async () => {
    const client = loaded({ strictRecords: true });
    const resolution = (client.prompt("greeting") as unknown as { currentResolution: object })
      .currentResolution;
    const poisoned = Object.create(Object.getPrototypeOf(resolution) as object, {
      ...Object.getOwnPropertyDescriptors(resolution),
      params: {
        get() {
          throw new Error("record builder blew up");
        },
      },
    }) as typeof resolution;

    await expect(
      (
        client as unknown as {
          trackPrompt: (current: typeof poisoned, meta: object, call: () => string) => Promise<string>;
        }
      ).trackPrompt(poisoned, {}, () => "fine"),
    ).resolves.toBe("fine");
    expect(client.stats().droppedInvalid).toBe(1);
  });
});

describe("log()", () => {
  it("fills in id, started_at and sdk", () => {
    const client = loaded();
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    const log = client.logs[0] as Record<string, unknown>;
    expect(String(log["id"])).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof log["started_at"]).toBe("string");
    expect(log["sdk"]).toEqual({ name: "prompton-nodejs", version: VERSION });
  });

  it("fills the prompt evidence when a prompt is passed", () => {
    const client = loaded();
    const prompt = client.prompt("greeting", { template: "ko" });
    client.log({ status: "ok" }, { prompt });
    expect(client.logs[0]).toMatchObject({
      prompt_key: "greeting",
      model: "openai/gpt-4o-mini",
      template: "ko",
      deployment_id: "0198f2a1-0000-7000-8000-00000000d001",
      deployment_revision: 3,
      prompt_version_id: "0198f2a1-0000-7000-8000-00000000a002",
      model_id: "0198f2a1-0000-7000-8000-00000000e001",
      source: "manual",
    });
  });

  it("drops a record with no status instead of failing the caller's request", () => {
    const logger = recordingLogger();
    const client = loaded({ logger });
    expect(() => client.log({ prompt_key: "greeting", model: "m" })).not.toThrow();
    expect(client.logs).toHaveLength(0);
    expect(client.stats().droppedInvalid).toBe(1);
    expect(logger.lines.some((line) => line.includes("dropped a monitoring log"))).toBe(true);
  });

  it("raises the same record under strictRecords, for tests", () => {
    const client = loaded({ strictRecords: true });
    expect(() => client.log({ prompt_key: "greeting", model: "m" })).toThrowError(InvalidRecordError);
    expect(client.stats().droppedInvalid).toBe(0);
  });

  it("applies the prompt's payload policy from the snapshot", () => {
    const client = loaded();
    const document = snapshotDocument();
    (document["prompts"] as any)["greeting"]["payload_policy"] = {
      mode: "none",
      sample_rate: 1.0,
      max_bytes: 262144,
    };
    client.loadPrompts(document);
    client.log({
      prompt_key: "greeting",
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
    client.log({ prompt_key: "greeting", model: "m", status: "ok", end_user_ref: "user-42" });
    const log = client.logs[0] as Record<string, unknown>;
    expect(log["end_user_ref"]).toBe(createHash("sha256").update("user-42").digest("hex"));
    expect(log["metadata"]).toEqual({ redacted: true });
  });
});

describe("sending monitoring logs", () => {
  it("posts one batch per environment to /logs", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/prompts")) return snapshotResponse(snapshotDocument());
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
    client.loadPrompts(snapshotDocument("staging"));
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);

    const post = fetch.calls.find((call) => call.url.includes("/logs"));
    expect(post?.url).toBe("http://ptn.test/api/v1/logs?environment=staging");
    expect((post?.init?.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer ptn_sdkfixture_key",
    );
    expect((post?.init?.headers as Record<string, string>)["user-agent"]).toMatch(
      /^prompton-nodejs\/\d+\.\d+\.\d+$/u,
    );
    const body = JSON.parse(post?.init?.body as string) as { logs: unknown[] };
    expect(body.logs.length).toBe(1);
    expect(result.accepted).toBe(1);
  });

  it("counts duplicates on a resend", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/prompts")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify({ accepted: 0, duplicates: 1, rejected: [] }), {
        status: 202,
      });
    });
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch });
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);
    expect(result.duplicates).toBe(1);
  });

  it("does not retry a 403", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/prompts")) return snapshotResponse(snapshotDocument());
      return new Response(
        JSON.stringify({ error: { code: "forbidden", message: "API key lacks the logs scope" } }),
        { status: 403 },
      );
    });
    const logger = recordingLogger();
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch, logger });
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);

    expect(fetch.calls.filter((call) => call.url.includes("/logs")).length).toBe(1);
    expect(result.droppedRejected).toBe(1);
    expect(logger.lines.join("\n")).toMatch(/lacks the logs scope/u);
  });

  it("flushes what is queued when the client is closed", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/prompts")) return snapshotResponse(snapshotDocument());
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
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    const result = await client.close(2000);
    expect(result.pending).toBe(0);
    expect(result.accepted).toBe(2);
  });
});

describe("client lifecycle", () => {
  it("registers one beforeExit listener however many clients exist", async () => {
    const before = process.listenerCount("beforeExit");
    const warnings: string[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning.name);
    };
    process.on("warning", onWarning);

    const many = Array.from(
      { length: 15 },
      () =>
        new PromptOn({
          mode: "offline",
          diskCache: false,
          poll: false,
          logger: recordingLogger(),
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    process.off("warning", onWarning);

    expect(warnings).not.toContain("MaxListenersExceededWarning");
    expect(process.listenerCount("beforeExit")).toBeLessThanOrEqual(before + 1);

    await Promise.all(many.map((client) => client.close(50)));
    expect(process.listenerCount("beforeExit")).toBe(before);
  });
});

describe("offline mode", () => {
  it("makes no HTTP call at all", async () => {
    const fetch = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = make({ mode: "offline", apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch });
    client.loadPrompts(snapshotDocument());
    expect(client.prompt("greeting").model).toBe("openai/gpt-4o-mini");
    client.log({ prompt_key: "greeting", model: "m", status: "ok" });
    await client.flush(500);
    expect(fetch.calls.length).toBe(0);
  });
});
