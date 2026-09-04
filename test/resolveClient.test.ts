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
 * `POST /resolve` is the simple path and the smoke test. It obeys the same caching rules as the
 * snapshot: one request per TTL, rendered locally, and the cached answer on a failure.
 */

const clients: PromptOn[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(100)));
});

const RESOLVE_BODY = {
  use_case: "greeting",
  kind: "chat",
  deployment: { id: "0198f2a1-0000-7000-8000-00000000d001", revision: 3 },
  prompt: "default",
  prompts: ["default", "ko"],
  model_id: "0198f2a1-0000-7000-8000-00000000e001",
  model: "openai/gpt-4o-mini",
  provider: "openrouter",
  effective_params: { temperature: 0.2 },
  effective_provider_options: { only: ["OpenAI"] },
  prompt_version: { id: "0198f2a1-0000-7000-8000-00000000a001", number: 2 },
  messages: [
    { role: "system", content: "You are a friendly greeter." },
    { role: "user", content: "Say hello to {{ name }}." },
  ],
  warnings: [],
  etag: "sha256-abc",
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

describe("resolveRemote", () => {
  it("asks for the raw template and renders it locally", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
    });
    const client = make(fetch);
    const resolved = await client.resolveRemote("greeting", { variables: { name: "Ada" } });

    expect(resolved.model).toBe("openai/gpt-4o-mini");
    expect(resolved.params).toEqual({ temperature: 0.2 });
    expect(resolved.messages?.[1]?.content).toBe("Say hello to Ada.");

    const post = fetch.calls.find((call) => call.url.includes("/resolve"));
    expect(JSON.parse(post?.init?.body as string)).toEqual({
      use_case: "greeting",
      environment: "production",
      prompt: "default",
    });
  });

  it("caches the answer for the TTL and renders each call's own variables", async () => {
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
    });
    const client = make(fetch);
    const first = await client.resolveRemote("greeting", { variables: { name: "Ada" } });
    const second = await client.resolveRemote("greeting", { variables: { name: "Grace" } });

    expect(first.messages?.[1]?.content).toBe("Say hello to Ada.");
    expect(second.messages?.[1]?.content).toBe("Say hello to Grace.");
    expect(fetch.calls.filter((call) => call.url.includes("/resolve")).length).toBe(1);
  });

  it("serves the cached answer when the server answers 500", async () => {
    let resolveCalls = 0;
    const fetch = fakeFetch((url) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      resolveCalls += 1;
      if (resolveCalls === 1) return new Response(JSON.stringify(RESOLVE_BODY), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
        status: 500,
      });
    });
    const client = make(fetch, { cacheTtlMs: 1 });
    await client.resolveRemote("greeting");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await client.resolveRemote("greeting", { variables: { name: "Ada" } });

    expect(resolveCalls).toBe(2);
    expect(again.messages?.[1]?.content).toBe("Say hello to Ada.");
  });

  it("reports a missing variable from the local render", async () => {
    const fetch = fakeFetch((url) =>
      url.includes("/snapshot")
        ? snapshotResponse(snapshotDocument())
        : new Response(JSON.stringify(RESOLVE_BODY), { status: 200 }),
    );
    const client = make(fetch);
    await expect(client.resolveRemote("greeting", { variables: {} })).rejects.toBeInstanceOf(
      MissingVariableError,
    );
  });

  it("maps the 404 reasons onto the same errors as local resolution", async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.includes("/snapshot")) return snapshotResponse(snapshotDocument());
      const body = JSON.parse(init?.body as string) as { prompt: string };
      if (body.prompt === "fr") {
        return new Response(
          JSON.stringify({
            error: {
              code: "not_found",
              message: "no prompt",
              details: { reason: "unknown_prompt", prompt: "fr", available_prompts: ["default"] },
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

    await expect(client.resolveRemote("draft")).rejects.toBeInstanceOf(UnresolvedError);
    await expect(client.resolveRemote("greeting", { prompt: "fr" })).rejects.toBeInstanceOf(
      UnknownPromptError,
    );
  });

  it("surfaces an unexpected status as an ApiError", async () => {
    const fetch = fakeFetch((url) =>
      url.includes("/snapshot")
        ? snapshotResponse(snapshotDocument())
        : new Response(
            JSON.stringify({ error: { code: "forbidden", message: "API key lacks the resolve scope" } }),
            { status: 403 },
          ),
    );
    const client = make(fetch);
    try {
      await client.resolveRemote("greeting");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(403);
      expect((error as ApiError).message).toBe("API key lacks the resolve scope");
    }
  });
});
