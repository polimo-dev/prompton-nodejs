import { afterEach, describe, expect, it } from "vitest";

import {
  ApiError,
  MissingVariableError,
  PromptOn,
  UnknownPromptError,
  UnresolvedError,
} from "../src/index.js";
import { fakeFetch, recordingLogger, snapshotDocument, snapshotResponse } from "./helpers.js";

/**
 * `prompt endpoint` is the simple path and the smoke test. It obeys the same caching rules as the
 * snapshot: one request per TTL, rendered locally, and the cached answer on a failure.
 */

const clients: PromptOn[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(100)));
});

const RESOLVE_BODY = {
  key: "greeting",
  kind: "chat",
  deployment: { id: "0198f2a1-0000-7000-8000-00000000d001", revision: 3 },
  prompt: "default",
  prompt_names: ["default", "ko"],
  model_id: "0198f2a1-0000-7000-8000-00000000e001",
  model: "openai/gpt-4o-mini",
  provider: "openrouter",
  params: { temperature: 0.2 },
  provider_options: { only: ["OpenAI"] },
  prompt_version: { id: "0198f2a1-0000-7000-8000-00000000a001", number: 2 },
  messages: [
    { role: "system", content: "You are a friendly greeter." },
    { role: "user", content: "Say hello to {{ name }}." },
  ],
  warnings: [],
  etag: "sha256-abc",
  source: "remote",
};

function make(fetch: typeof globalThis.fetch, options = {}): PromptOn {
  const client = new PromptOn({
    apiKey: "ptn_sdkfixture_key",
    baseUrl: "http://ptn.test",
    fetch,
    diskCache: false,
    poll: false,
    flushOnExit: false,
    logger: recordingLogger(),
    ...options,
  });
  clients.push(client);
  return client;
}

describe("filledPrompt", () => {
  it("asks for the raw template and renders it locally", async () => {
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
    });
    const client = make(fetch);
    const resolved = await client.filledPrompt("greeting", { variables: { name: "Ada" } });

    expect(resolved.model).toBe("openai/gpt-4o-mini");
    expect(resolved.key).toBe("greeting");
    expect(resolved.source).toBe("remote");
    expect(resolved.params).toEqual({ temperature: 0.2 });
    expect(resolved.messages?.[1]?.content).toBe("Say hello to Ada.");

    const post = fetch.calls.find((call) => call.url.includes("/prompt"));
    expect(post?.url).toBe("http://ptn.test/api/v1/use-cases/greeting/prompt");
    expect(JSON.parse(post?.init?.body as string)).toEqual({
      environment: "production",
      prompt: "default",
    });
  });

  it("caches the answer for the TTL and renders each call's own variables", async () => {
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
    });
    const client = make(fetch);
    const first = await client.filledPrompt("greeting", { variables: { name: "Ada" } });
    const second = await client.filledPrompt("greeting", { variables: { name: "Grace" } });

    expect(first.messages?.[1]?.content).toBe("Say hello to Ada.");
    expect(second.messages?.[1]?.content).toBe("Say hello to Grace.");
    expect(fetch.calls.filter((call) => call.url.includes("/prompt")).length).toBe(1);
  });

  it("serves the cached answer when the server answers 500", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      if (resolveCalls === 1) return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
        status: 500,
      });
    });
    const client = make(fetch, { cacheTtlMs: 1 });
    await client.filledPrompt("greeting");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await client.filledPrompt("greeting", { variables: { name: "Ada" } });

    expect(resolveCalls).toBe(2);
    expect(again.messages?.[1]?.content).toBe("Say hello to Ada.");
  });

  it("waits out Retry-After before contacting the server again", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      if (resolveCalls === 1) return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
      return new Response(
        JSON.stringify({
          error: { code: "rate_limited", message: "slow down", details: { retry_after: 300 } },
        }),
        { status: 429, headers: { "retry-after": "300" } },
      );
    });
    const client = make(fetch, { cacheTtlMs: 20 });
    await client.filledPrompt("greeting");
    await new Promise((resolve) => setTimeout(resolve, 30));

    for (let i = 0; i < 20; i += 1) {
      const answer = await client.filledPrompt("greeting", { variables: { name: "Ada" } });
      expect(answer.messages?.[1]?.content).toBe("Say hello to Ada.");
    }

    expect(resolveCalls).toBe(2);
  });

  it("backs off exponentially from the TTL when the server sends no Retry-After", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      if (resolveCalls === 1) return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
        status: 500,
      });
    });
    const client = make(fetch, { cacheTtlMs: 40 });
    await client.filledPrompt("greeting");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await client.filledPrompt("greeting");
    expect(resolveCalls).toBe(2);
    await client.filledPrompt("greeting");
    expect(resolveCalls).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.filledPrompt("greeting");
    expect(resolveCalls).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await client.filledPrompt("greeting");
    expect(resolveCalls).toBe(3);
  });

  it("does not hammer the server when it has nothing cached to serve", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      return new Response(
        JSON.stringify({ error: { code: "unavailable", message: "down" } }),
        { status: 503, headers: { "retry-after": "120" } },
      );
    });
    const client = make(fetch, { cacheTtlMs: 20 });

    for (let i = 0; i < 5; i += 1) {
      await expect(client.filledPrompt("greeting")).rejects.toBeInstanceOf(ApiError);
    }
    expect(resolveCalls).toBe(1);
  });

  it("collapses concurrent calls for one key into a single request", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
    });
    const client = make(fetch);
    const answers = await Promise.all([
      client.filledPrompt("greeting", { variables: { name: "Ada" } }),
      client.filledPrompt("greeting", { variables: { name: "Grace" } }),
      client.filledPrompt("greeting", { variables: { name: "Alan" } }),
    ]);

    expect(resolveCalls).toBe(1);
    expect(answers.map((answer) => answer.messages?.[1]?.content)).toEqual([
      "Say hello to Ada.",
      "Say hello to Grace.",
      "Say hello to Alan.",
    ]);
  });

  it("gives concurrent waiters the cached answer when the shared request fails", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      if (resolveCalls === 1) return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "down" } }), {
        status: 503,
      });
    });
    const client = make(fetch, { cacheTtlMs: 20 });
    await client.filledPrompt("greeting");
    await new Promise((resolve) => setTimeout(resolve, 30));

    const answers = await Promise.all([
      client.filledPrompt("greeting", { variables: { name: "Ada" } }),
      client.filledPrompt("greeting", { variables: { name: "Grace" } }),
      client.filledPrompt("greeting", { variables: { name: "Alan" } }),
    ]);

    expect(resolveCalls).toBe(2);
    expect(answers.map((answer) => answer.messages?.[1]?.content)).toEqual([
      "Say hello to Ada.",
      "Say hello to Grace.",
      "Say hello to Alan.",
    ]);
  });

  it("reports a missing variable from the local render", async () => {
    const fetch = fakeFetch((url) =>
      url.includes("/prompt")
        ? new Response(JSON.stringify(RESOLVE_BODY), { status: 200 })
        : snapshotResponse(snapshotDocument()),
    );
    const client = make(fetch);
    await expect(client.filledPrompt("greeting", { variables: {} })).rejects.toBeInstanceOf(
      MissingVariableError,
    );
  });

  it("maps the 404 reasons onto the same errors as local resolution", async () => {
    const fetch = fakeFetch((url, init) => {
      if (!url.includes("/prompt")) return snapshotResponse(snapshotDocument());
      const body = JSON.parse(init?.body as string) as { prompt: string };
      if (body.prompt === "fr") {
        return new Response(
          JSON.stringify({
            error: {
              code: "not_found",
              message: "no prompt",
              details: { reason: "unknown_prompt", key: "greeting", prompt: "fr", prompt_names: ["default"] },
            },
          }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          error: { code: "not_found", message: "no deployment", details: { reason: "unresolved" } },
        }),
        { status: 404 },
      );
    });
    const client = make(fetch);

    try {
      await client.filledPrompt("draft");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnresolvedError);
      expect((error as UnresolvedError).useCase).toBe("draft");
    }
    try {
      await client.filledPrompt("greeting", { prompt: "fr" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPromptError);
      expect((error as UnknownPromptError).useCase).toBe("greeting");
    }
  });

  it("surfaces an unexpected status as an ApiError", async () => {
    const fetch = fakeFetch((url) =>
      url.includes("/prompt")
        ? new Response(
            JSON.stringify({ error: { code: "forbidden", message: "API key lacks the read scope" } }),
            { status: 403 },
          )
        : snapshotResponse(snapshotDocument()),
    );
    const client = make(fetch);
    try {
      await client.filledPrompt("greeting");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
      expect((error as ApiError).message).toBe("API key lacks the read scope");
    }
  });
});
