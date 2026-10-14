import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { Logger } from "../src/index.js";

/** A snapshot document in the shape `GET /prompts` returns, small enough to read in a test. */
function legacySnapshotDocument(
  environment = "production",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    project: "sdkfixture",
    environment,
    prompts: {
      greeting: {
        id: "0198f2a1-0000-7000-8000-00000000c001",
        kind: "chat",
        variables: [{ name: "name", type: "string", required: true }],
        default_params: { temperature: 0.2, max_tokens: 512 },
        payload_policy: {
          mode: "full",
          sample_rate: 1.0,
          max_bytes: 262144,
          retention_days: 30,
          encrypt: false,
        },
      },
      summarize: {
        id: "0198f2a1-0000-7000-8000-00000000c002",
        kind: "text",
        variables: [],
        default_params: {},
        payload_policy: null,
      },
      embed: {
        id: "0198f2a1-0000-7000-8000-00000000c003",
        kind: "embedding",
        variables: [],
        default_params: { dimensions: 256 },
        payload_policy: null,
      },
      draft: {
        id: "0198f2a1-0000-7000-8000-00000000c004",
        kind: "chat",
        variables: [],
        default_params: {},
        payload_policy: null,
      },
      sentiment: {
        id: "0198f2a1-0000-7000-8000-00000000c005",
        kind: "decision",
        variables: [{ name: "diary", type: "string", required: true }],
        default_params: {},
        payload_policy: null,
      },
    },
    deployments: {
      greeting: {
        id: "0198f2a1-0000-7000-8000-00000000d001",
        revision: "v2026.09.30-3",
        model_id: "0198f2a1-0000-7000-8000-00000000e001",
        api: "chat_completions",
        request_path: "/api/v1/chat/completions",
        params: {},
        provider_options: {},
        template_pins: {
          default: "0198f2a1-0000-7000-8000-00000000a001",
          ko: "0198f2a1-0000-7000-8000-00000000a002",
        },
      },
      summarize: {
        id: "0198f2a1-0000-7000-8000-00000000d002",
        revision: "v2026.09.30-1",
        model_id: "0198f2a1-0000-7000-8000-00000000e001",
        api: "chat_completions",
        request_path: "/api/v1/chat/completions",
        params: {},
        provider_options: {},
        template_pins: { default: "0198f2a1-0000-7000-8000-00000000a003" },
      },
      embed: {
        id: "0198f2a1-0000-7000-8000-00000000d003",
        revision: "v2026.09.30-2",
        model_id: "0198f2a1-0000-7000-8000-00000000e002",
        api: null,
        request_path: null,
        params: {},
        provider_options: {},
        template_pins: {},
      },
      sentiment: {
        id: "0198f2a1-0000-7000-8000-00000000d004",
        revision: "v2026.09.30-5",
        model_id: "0198f2a1-0000-7000-8000-00000000e003",
        api: "decisions",
        request_path: "/api/v1/systemone",
        params: {},
        provider_options: {},
        template_pins: { default: "0198f2a1-0000-7000-8000-00000000a004" },
      },
    },
    prompt_versions: {
      "0198f2a1-0000-7000-8000-00000000a001": {
        id: "0198f2a1-0000-7000-8000-00000000a001",
        prompt_template_id: "0198f2a1-0000-7000-8000-00000000b001",
        number: 2,
        kind: "chat",
        engine: "liquid",
        messages: [
          { role: "system", content: "You are a friendly greeter." },
          { role: "user", content: "Say hello to {{ name }}." },
        ],
        text_template: null,
      },
      "0198f2a1-0000-7000-8000-00000000a002": {
        id: "0198f2a1-0000-7000-8000-00000000a002",
        prompt_template_id: "0198f2a1-0000-7000-8000-00000000b002",
        number: 1,
        kind: "chat",
        engine: "liquid",
        messages: [
          { role: "system", content: "너는 친절한 인사 도우미다." },
          { role: "user", content: "{{ name }}님에게 인사해줘." },
        ],
        text_template: null,
      },
      "0198f2a1-0000-7000-8000-00000000a003": {
        id: "0198f2a1-0000-7000-8000-00000000a003",
        prompt_template_id: "0198f2a1-0000-7000-8000-00000000b003",
        number: 4,
        kind: "text",
        engine: "liquid",
        messages: null,
        text_template: "Summarize:\n{% for item in items %}- {{ item }}\n{% endfor %}",
      },
      "0198f2a1-0000-7000-8000-00000000a004": {
        id: "0198f2a1-0000-7000-8000-00000000a004",
        prompt_template_id: "0198f2a1-0000-7000-8000-00000000b004",
        number: 1,
        kind: "decision",
        engine: "liquid",
        messages: [],
        text_template: null,
        decision: {
          state: { diary: "{{ diary }}", static_key: "literal" },
          questions: {
            mood: {
              type: "choice",
              instructions: "Classify {{ diary }}.",
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
        },
      },
    },
    models: {
      "0198f2a1-0000-7000-8000-00000000e001": {
        id: "0198f2a1-0000-7000-8000-00000000e001",
        provider: "openrouter",
        model_id: "openai/gpt-4o-mini",
        display_name: "GPT-4o mini",
        metadata: {},
        provider_options: { only: ["OpenAI"] },
        capabilities: ["tools"],
        status: "active",
      },
      "0198f2a1-0000-7000-8000-00000000e002": {
        id: "0198f2a1-0000-7000-8000-00000000e002",
        provider: "openrouter",
        model_id: "openai/text-embedding-3-small",
        display_name: "text-embedding-3-small",
        metadata: {},
        provider_options: {},
        capabilities: [],
        status: "active",
      },
      "0198f2a1-0000-7000-8000-00000000e003": {
        id: "0198f2a1-0000-7000-8000-00000000e003",
        provider: "openrouter",
        model_id: "typesafe/jev-1.13",
        display_name: "Jev",
        metadata: { output_modalities: ["decisions"] },
        provider_options: {},
        capabilities: ["decisions"],
        status: "active",
      },
    },
    ...overrides,
  };
}

export function snapshotDocument(
  environment = "production",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return readableSnapshotDocument(environment, overrides);
}

/** The schema v1 aggregate wire shape: readable resource references, no public resource UUIDs. */
export function readableSnapshotDocument(
  environment = "production",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const legacy = legacySnapshotDocument(environment);
  const legacyModels = legacy.models as Record<string, Record<string, unknown>>;
  const legacyVersions = legacy.prompt_versions as Record<string, Record<string, unknown>>;
  const deployments: Record<string, Record<string, unknown>> = {};
  const promptVersions: Record<string, Record<string, unknown>> = {};
  const models: Record<string, Record<string, unknown>> = {};

  for (const [key, deployment] of Object.entries(legacy.deployments as Record<string, Record<string, unknown>>)) {
    const model = legacyModels[String(deployment["model_id"])]!;
    const provider = String(model["provider"]);
    const modelName = String(model["model_id"]);
    const rawPins = (deployment["template_pins"] as Record<string, unknown> | undefined) ?? {};
    const promptPins: Record<string, number> = {};
    for (const [name, versionId] of Object.entries(rawPins)) {
      const pinnedVersion = legacyVersions[String(versionId)];
      if (typeof pinnedVersion?.["number"] === "number") promptPins[name] = pinnedVersion["number"];
    }
    deployments[key] = {
      revision: deployment["revision"],
      provider,
      model: modelName,
      prompt_version: promptPins["default"],
      prompt_pins: promptPins,
      api: deployment["api"],
      request_path: deployment["request_path"],
      params: deployment["params"],
      provider_options: deployment["provider_options"],
    };
    for (const versionId of Object.values(rawPins)) {
      const version = legacyVersions[String(versionId)];
      if (version) {
        const number = Number(version["number"]);
        promptVersions[`${key}@${String(number)}`] = {
          prompt: key,
          number,
          kind: version["kind"],
          engine: version["engine"],
          messages: version["messages"],
          text_template: version["text_template"],
          decision: version["decision"],
          tools: version["tools"],
        };
      }
    }
  }

  for (const model of Object.values(legacyModels)) {
    const provider = String(model["provider"]);
    const modelName = String(model["model_id"]);
    models[`${provider}:${modelName}`] = {
      provider,
      model: modelName,
      display_name: model["display_name"],
      metadata: model["metadata"],
      provider_options: model["provider_options"],
      capabilities: model["capabilities"],
      status: model["status"],
    };
  }

  const prompts = Object.fromEntries(
    Object.entries(legacy.prompts as Record<string, Record<string, unknown>>).map(([key, prompt]) => [
      key,
      {
        kind: prompt["kind"],
        variables: prompt["variables"],
        default_params: prompt["default_params"],
        payload_policy: prompt["payload_policy"],
      },
    ]),
  );

  return {
    schema_version: 1,
    project: legacy.project,
    environment,
    prompts,
    deployments,
    prompt_versions: promptVersions,
    models,
    ...overrides,
  };
}

/** The schema v1 single-prompt wire shape returned by GET /prompts/:key. */
export function singlePromptDocument(
  key = "greeting",
  environment = "production",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const readable = readableSnapshotDocument(environment);
  const prompts = readable["prompts"] as Record<string, Record<string, unknown>>;
  const deployments = readable["deployments"] as Record<string, Record<string, unknown>>;
  const versions = readable["prompt_versions"] as Record<string, Record<string, unknown>>;
  const models = readable["models"] as Record<string, Record<string, unknown>>;
  const prompt = prompts[key];
  const deployment = deployments[key];
  if (!prompt || !deployment) throw new Error(`missing fixture prompt ${key}`);
  const number = deployment["prompt_version"];
  const version = versions[`${key}@${String(number)}`];
  const model = models[`${String(deployment["provider"])}:${String(deployment["model"])}`];
  if (!version || !model) throw new Error(`missing fixture resources for ${key}`);
  return {
    schema_version: 1,
    project: readable["project"],
    environment,
    prompt: { key, ...prompt },
    deployment,
    prompt_version: version,
    model,
    ...overrides,
  };
}

/** One request a stub or fake recorded. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

/** A stub HTTP server, for the behaviours that must not touch the fixture server. */
export interface StubServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

type Responder = (
  request: RecordedRequest,
  response: ServerResponse,
  index: number,
) => void | Promise<void>;

/** Starts a stub PromptOn on a random loopback port. */
export async function startStubServer(respond: Responder): Promise<StubServer> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      const index = requests.length;
      requests.push(recorded);
      void respond(recorded, res, index);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A `fetch` that answers from a script, and counts the calls. */
export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined, call: number) => Response | Promise<Response>,
): typeof globalThis.fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const index = calls.length;
    calls.push({ url, init });
    return handler(url, init, index);
  }) as typeof globalThis.fetch & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

/** A JSON response with the headers a snapshot carries. */
export function snapshotResponse(
  document: unknown,
  etag = '"sha256-test"',
  status = 200,
): Response {
  const body = status === 304 ? null : JSON.stringify(document);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      etag,
      "last-modified": "Fri, 04 Sep 2026 00:21:48 GMT",
      "cache-control": "max-age=30",
    },
  });
}

/** Collects log lines instead of printing them. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: (message) => lines.push(`debug: ${message}`),
    info: (message) => lines.push(`info: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  };
}

/** A temporary directory that the caller removes. */
export function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "prompton-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Waits. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
