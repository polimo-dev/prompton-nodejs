import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MissingVariableError, PromptOn, UnknownPromptError, UnknownUseCaseError, uuidv7 } from "../src/index.js";
import { recordingLogger, tempDir } from "./helpers.js";
import { join } from "node:path";

/**
 * The live integration test. It runs only when `PTN_API_KEY` is set, against a PromptOn server
 * seeded with the `sdkfixture` project:
 *
 * ```sh
 * PTN_HOST=http://localhost:4000 PTN_API_KEY=ptn_sdkfixture_… npm test
 * ```
 *
 * What it proves: the snapshot fetch and the conditional repoll, that local resolution agrees with
 * the server's own prompt endpoint for every use case and prompt name, that the error cases line
 * up, and that a batch of monitoring logs is accepted once and counted as duplicates on a resend.
 */

const apiKey = process.env["PTN_API_KEY"];
const host = process.env["PTN_HOST"] ?? "http://localhost:4000";
const suite = apiKey ? describe : describe.skip;

interface ResolveResponse {
  key: string;
  kind: string;
  deployment: { id: string; revision: number };
  prompt: string | null;
  prompt_names: string[];
  model: string;
  model_id: string;
  provider: string;
  params: Record<string, unknown>;
  provider_options: Record<string, unknown>;
  prompt_version: { id: string; number: number } | null;
  source: string;
  messages?: { role: string; content: string }[];
  text?: string;
}

async function serverResolve(
  useCase: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${host}/api/v1/use-cases/${encodeURIComponent(useCase)}/prompt`, {
    method: "POST",
    headers: { authorization: `Bearer ${String(apiKey)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

suite("live fixture server", () => {
  const dir = tempDir();
  let client: PromptOn;

  beforeAll(async () => {
    client = new PromptOn({
      apiKey,
      baseUrl: host,
      diskCache: join(dir.path, "snapshot.json"),
      poll: false,
      flushOnExit: false,
      logger: recordingLogger(),
    });
    const ready = await client.ready();
    expect(ready.status).toBe("updated");
  });

  afterAll(async () => {
    await client.close(5000);
    dir.cleanup();
  });

  it("fetches the snapshot and gets a 304 on the repoll", async () => {
    const info = client.useCasesInfo();
    expect(info.source).toBe("remote");
    expect(info.project).toBe("sdkfixture");
    expect(info.environment).toBe("production");
    expect(info.etag).toMatch(/^"?sha256-[0-9a-f]{64}"?$/u);

    const again = await client.refresh();
    expect(again.status).toBe("not_modified");
    expect(client.useCasesInfo().stale).toBe(false);
  });

  it("resolves greeting exactly as the server does, in both prompt names", async () => {
    for (const [prompt, variables] of [
      ["default", { name: "Ada" }],
      ["ko", { name: "아다" }],
    ] as const) {
      const local = client.useCase("greeting", { prompt });
      const remote = await serverResolve("greeting", {
        environment: "production",
        prompt,
        variables,
      });
      expect(remote.status).toBe(200);
      const body = remote.body as ResolveResponse;

      expect(body.key).toBe("greeting");
      expect(body.source).toBe("remote");
      expect(local.kind).toBe(body.kind);
      expect(local.deployment.id).toBe(body.deployment.id);
      expect(local.deployment.revision).toBe(body.deployment.revision);
      expect(local.prompt).toBe(body.prompt);
      expect(local.promptNames).toEqual(body.prompt_names);
      expect(local.model).toBe(body.model);
      expect(local.modelId).toBe(body.model_id);
      expect(local.provider).toBe(body.provider);
      expect(local.params).toEqual(body.params);
      expect(local.providerOptions).toEqual(body.provider_options);
      expect(local.promptVersion?.id).toBe(body.prompt_version?.id);
      expect(local.promptVersion?.number).toBe(body.prompt_version?.number);

      const rendered = local.messages(variables);
      expect(rendered.map((m) => ({ role: m.role, content: m.content }))).toEqual(body.messages);
    }
  });

  it("resolves summarize exactly as the server does", async () => {
    const local = client.useCase("summarize");
    const remote = await serverResolve("summarize", {
      environment: "production",
      variables: { items: ["alpha", "beta", "gamma"] },
    });
    expect(remote.status).toBe(200);
    const body = remote.body as ResolveResponse;

    expect(body.key).toBe("summarize");
    expect(body.source).toBe("remote");
    expect(local.kind).toBe("text");
    expect(local.model).toBe(body.model);
    expect(local.params).toEqual(body.params);
    expect(local.text({ items: ["alpha", "beta", "gamma"] })).toBe(body.text);
  });

  it("resolves embed exactly as the server does, with no prompt at all", async () => {
    const local = client.useCase("embed");
    const remote = await serverResolve("embed", { environment: "production" });
    expect(remote.status).toBe(200);
    const body = remote.body as ResolveResponse;

    expect(body.key).toBe("embed");
    expect(body.source).toBe("remote");
    expect(local.kind).toBe("embedding");
    expect(local.prompt).toBeNull();
    expect(body.prompt).toBeNull();
    expect(local.promptVersion).toBeNull();
    expect(body.prompt_version).toBeNull();
    expect(local.promptNames).toEqual(body.prompt_names);
    expect(local.model).toBe(body.model);
    expect(local.modelId).toBe(body.model_id);
  });

  it("agrees with the server on every error case", async () => {
    expect(() => client.useCase("does_not_exist")).toThrowError(UnknownUseCaseError);
    const unknownUseCase = await serverResolve("does_not_exist", { environment: "production" });
    expect(unknownUseCase.status).toBe(404);
    expect(unknownUseCase.body.error.details.key).toBe("does_not_exist");

    try {
      client.useCase("greeting", { prompt: "fr" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownPromptError);
      const remote = await serverResolve("greeting", {
        environment: "production",
        prompt: "fr",
        variables: {},
      });
      expect(remote.status).toBe(404);
      expect(remote.body.error.details.reason).toBe("unknown_prompt");
      expect((error as UnknownPromptError).promptNames).toEqual(
        remote.body.error.details.prompt_names,
      );
    }

    try {
      client.useCase("greeting").messages({});
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingVariableError);
      const remote = await serverResolve("greeting", { environment: "production", variables: {} });
      expect(remote.status).toBe(400);
      expect((error as MissingVariableError).variable).toBe(
        remote.body.error.details.missing_variable,
      );
    }
  });

  it("keeps serving when the environment does not exist on the server", async () => {
    const stray = new PromptOn({
      apiKey,
      baseUrl: host,
      environment: "nope",
      diskCache: false,
      poll: false,
      flushOnExit: false,
      logger: recordingLogger(),
    });
    const result = await stray.ready();
    expect(result.status).toBe("failed");
    expect(() => stray.useCase("greeting")).toThrowError(/unreachable and nothing is cached/u);
    await stray.close(100);
  });

  it("refuses a bad key without disturbing the cached snapshot", async () => {
    const bad = new PromptOn({
      apiKey: "ptn_sdkfixture_wrong",
      baseUrl: host,
      diskCache: false,
      poll: false,
      flushOnExit: false,
      logger: recordingLogger(),
    });
    const result = await bad.ready();
    expect(result.status).toBe("failed");
    await bad.close(100);

    expect(client.useCase("greeting").model).toBeTruthy();
  });

  it("sends a batch of monitoring logs and counts a resend as duplicates", async () => {
    const useCase = client.useCase("greeting");
    const ids = [uuidv7(), uuidv7()];
    const startedAt = new Date().toISOString();

    for (const id of ids) {
      client.log(
        {
          id,
          status: "ok",
          started_at: startedAt,
          latency_ms: 12,
          finish_reason: "stop",
          input: { variables: { name: "Ada" } },
          output: { content: "Hello, Ada!" },
          usage: { input_tokens: 8, output_tokens: 5, cost_source: "unknown" },
          trace_id: "prompton-nodejs-integration",
        },
        { useCase },
      );
    }

    const flushed = await client.flush(10_000);
    expect(flushed.pending).toBe(0);
    expect(flushed.accepted).toBe(2);
    expect(flushed.rejected).toBe(0);

    const resend = await fetch(`${host}/api/v1/logs?environment=production`, {
      method: "POST",
      headers: { authorization: `Bearer ${String(apiKey)}`, "content-type": "application/json" },
      body: JSON.stringify({
        logs: ids.map((id) => ({
          id,
          use_case: "greeting",
          model: useCase.model,
          status: "ok",
          started_at: startedAt,
        })),
      }),
    });
    expect(resend.status).toBe(202);
    const body = (await resend.json()) as { accepted: number; duplicates: number };
    expect(body.duplicates).toBe(2);
    expect(body.accepted).toBe(0);
  });
});
