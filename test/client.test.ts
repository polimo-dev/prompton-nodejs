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
  client.loadUseCases(snapshotDocument());
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(200)));
});

describe("resolution", () => {
  it("resolves a chat use case and renders it", () => {
    const client = loaded();
    const useCase = client.useCase("greeting");
    expect({
      key: useCase.key,
      kind: useCase.kind,
      prompt: useCase.prompt,
      model: useCase.model,
      provider: useCase.provider,
      deployment: useCase.deployment,
      source: useCase.source,
      promptNames: useCase.promptNames,
    }).toMatchObject({
      key: "greeting",
      kind: "chat",
      prompt: "default",
      model: "openai/gpt-4o-mini",
      provider: "openrouter",
      deployment: { revision: 3 },
      source: "manual",
      promptNames: ["default", "ko"],
    });
    expect(useCase.params).toEqual({ temperature: 0.2, max_tokens: 512 });
    expect(useCase.providerOptions).toEqual({ only: ["OpenAI"] });

    const messages = useCase.messages({ name: "Ada" });
    expect(messages).toEqual([
      { role: "system", content: "You are a friendly greeter." },
      { role: "user", content: "Say hello to Ada." },
    ]);
  });

  it("selects a prompt by name", () => {
    const client = loaded();
    const messages = client.useCase("greeting", { prompt: "ko" }).messages({
      name: "아다",
    });
    expect((messages[1] as Message).content).toBe("아다님에게 인사해줘.");
  });

  it("uses the prompt selected during render as the following track evidence", async () => {
    const client = loaded();
    const useCase = client.useCase("greeting");

    expect(useCase.messages({ name: "아다" }, { prompt: "ko" })[1]?.content).toBe(
      "아다님에게 인사해줘.",
    );
    await useCase.track(() => ({ content: "안녕", finishReason: "stop" }));

    expect(client.logs[0]).toMatchObject({
      prompt: "ko",
      prompt_version_id: "0198f2a1-0000-7000-8000-00000000a002",
    });
  });

  it("does not let a failed named-prompt render poison following track evidence", async () => {
    const client = loaded();
    const useCase = client.useCase("greeting");

    expect(() => useCase.messages({}, { prompt: "ko" })).toThrowError(MissingVariableError);
    await useCase.track(() => ({ content: "Hello", finishReason: "stop" }));

    expect(useCase.prompt).toBe("default");
    expect(client.logs[0]).toMatchObject({
      prompt: "default",
      prompt_version_id: "0198f2a1-0000-7000-8000-00000000a001",
    });
  });

  it("renders a text use case", () => {
    const client = loaded();
    const text = client.useCase("summarize").text({ items: ["a", "b"] });
    expect(text).toBe("Summarize:\n- a\n- b\n");
  });

  it("has no template for an embedding use case", () => {
    const client = loaded();
    const useCase = client.useCase("embed");
    expect(useCase.prompt).toBeNull();
    expect(useCase.promptVersion).toBeNull();
    expect(() => useCase.messages()).toThrowError(NoTemplateError);
  });

  it("reports a missing variable by name", () => {
    const client = loaded();
    try {
      client.useCase("greeting").messages({});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingVariableError);
      expect((error as MissingVariableError).variable).toBe("name");
    }
  });

  it("refuses an unpinned prompt name rather than falling back to default", () => {
    const client = loaded();
    try {
      client.useCase("greeting", { prompt: "fr" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPromptError);
      expect((error as UnknownPromptError).promptNames).toEqual(["default", "ko"]);
    }
  });

  it("distinguishes an unknown use case from one that is not deployed", () => {
    const client = loaded();
    expect(() => client.useCase("nope")).toThrowError(UnknownUseCaseError);
    expect(() => client.useCase("draft")).toThrowError(UnresolvedError);
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
    const useCase = client.useCase("greeting");

    await useCase.track(
      () => ({ content: "Hello, Ada!", finishReason: "stop", usage: { inputTokens: 8, outputTokens: 4 } }),
      { variables: { name: "Ada" }, endUserRef: "u_1", traceId: "job:1" },
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
      source: "manual",
      trace_id: "job:1",
      end_user_ref: "u_1",
      sdk: { name: "prompton-nodejs", version: "0.2.0" },
    });
    expect(log["output"]).toEqual({ content: "Hello, Ada!" });
    expect(typeof log["latency_ms"]).toBe("number");
    expect(String(log["id"])[14]).toBe("7");
  });

  it("logs the failure and rethrows the original error unchanged", async () => {
    const client = loaded();
    const useCase = client.useCase("greeting");
    const boom = Object.assign(new Error("rate limited by upstream"), { status: 429 });

    await expect(
      useCase.track(() => {
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
    const returned = await client.useCase("greeting").track(() => value);
    expect(returned).toBe(value);
  });

  it("never lets a broken record replace the provider's own error", async () => {
    const logger = recordingLogger();
    const client = loaded({ logger, strictRecords: true });
    const resolution = (client.useCase("greeting") as unknown as { currentResolution: object })
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
          trackUseCase: typeof poisoned extends never
            ? never
            : (current: typeof poisoned, meta: object, call: () => never) => Promise<never>;
        }
      ).trackUseCase(poisoned, {}, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(client.logs).toHaveLength(0);
    expect(client.stats().droppedInvalid).toBe(1);
    expect(logger.lines.join("\n")).toMatch(/record builder blew up/u);
  });

  it("never lets a broken record fail a successful call", async () => {
    const client = loaded({ strictRecords: true });
    const resolution = (client.useCase("greeting") as unknown as { currentResolution: object })
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
          trackUseCase: (current: typeof poisoned, meta: object, call: () => string) => Promise<string>;
        }
      ).trackUseCase(poisoned, {}, () => "fine"),
    ).resolves.toBe("fine");
    expect(client.stats().droppedInvalid).toBe(1);
  });
});

describe("log()", () => {
  it("fills in id, started_at and sdk", () => {
    const client = loaded();
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const log = client.logs[0] as Record<string, unknown>;
    expect(String(log["id"])).toMatch(/^[0-9a-f-]{36}$/u);
    expect(typeof log["started_at"]).toBe("string");
    expect(log["sdk"]).toEqual({ name: "prompton-nodejs", version: "0.2.0" });
  });

  it("fills the use-case evidence when a use case is passed", () => {
    const client = loaded();
    const useCase = client.useCase("greeting", { prompt: "ko" });
    client.log({ status: "ok" }, { useCase });
    expect(client.logs[0]).toMatchObject({
      use_case: "greeting",
      model: "openai/gpt-4o-mini",
      prompt: "ko",
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
    expect(() => client.log({ use_case: "greeting", model: "m" })).not.toThrow();
    expect(client.logs).toHaveLength(0);
    expect(client.stats().droppedInvalid).toBe(1);
    expect(logger.lines.some((line) => line.includes("dropped a monitoring log"))).toBe(true);
  });

  it("raises the same record under strictRecords, for tests", () => {
    const client = loaded({ strictRecords: true });
    expect(() => client.log({ use_case: "greeting", model: "m" })).toThrowError(InvalidRecordError);
    expect(client.stats().droppedInvalid).toBe(0);
  });

  it("applies the use case's payload policy from the snapshot", () => {
    const client = loaded();
    const document = snapshotDocument();
    (document["use_cases"] as any)["greeting"]["payload_policy"] = {
      mode: "none",
      sample_rate: 1.0,
      max_bytes: 262144,
    };
    client.loadUseCases(document);
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
  it("posts one batch per environment to /logs", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/use-cases")) return snapshotResponse(snapshotDocument());
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
    client.loadUseCases(snapshotDocument("staging"));
    client.log({ use_case: "greeting", model: "m", status: "ok" });
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
      if (url.includes("/use-cases")) return snapshotResponse(snapshotDocument());
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
      if (url.includes("/use-cases")) return snapshotResponse(snapshotDocument());
      return new Response(
        JSON.stringify({ error: { code: "forbidden", message: "API key lacks the logs scope" } }),
        { status: 403 },
      );
    });
    const logger = recordingLogger();
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch, logger });
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    const result = await client.flush(2000);

    expect(fetch.calls.filter((call) => call.url.includes("/logs")).length).toBe(1);
    expect(result.droppedRejected).toBe(1);
    expect(logger.lines.join("\n")).toMatch(/lacks the logs scope/u);
  });

  it("flushes what is queued when the client is closed", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/use-cases")) return snapshotResponse(snapshotDocument());
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
    client.loadUseCases(snapshotDocument());
    expect(client.useCase("greeting").model).toBe("openai/gpt-4o-mini");
    client.log({ use_case: "greeting", model: "m", status: "ok" });
    await client.flush(500);
    expect(fetch.calls.length).toBe(0);
  });
});
