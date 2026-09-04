import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import type { Logger } from "../src/index.js";

/** A snapshot document in the shape `GET /snapshot` returns, small enough to read in a test. */
export function snapshotDocument(
  environment = "production",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 3,
    project: "sdkfixture",
    environment,
    use_cases: {
      greeting: {
        id: "0198f2a1-0000-7000-8000-00000000c001",
        kind: "chat",
        input_schema: [{ name: "name", type: "string", required: true }],
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
        input_schema: [],
        default_params: {},
        payload_policy: null,
      },
      embed: {
        id: "0198f2a1-0000-7000-8000-00000000c003",
        kind: "embedding",
        input_schema: [],
        default_params: { dimensions: 256 },
        payload_policy: null,
      },
      draft: {
        id: "0198f2a1-0000-7000-8000-00000000c004",
        kind: "chat",
        input_schema: [],
        default_params: {},
        payload_policy: null,
      },
    },
    deployments: {
      greeting: {
        id: "0198f2a1-0000-7000-8000-00000000d001",
        revision: 3,
        model_id: "0198f2a1-0000-7000-8000-00000000e001",
        params: {},
        provider_options: {},
        prompt_pins: {
          default: "0198f2a1-0000-7000-8000-00000000a001",
          ko: "0198f2a1-0000-7000-8000-00000000a002",
        },
      },
      summarize: {
        id: "0198f2a1-0000-7000-8000-00000000d002",
        revision: 1,
        model_id: "0198f2a1-0000-7000-8000-00000000e001",
        params: {},
        provider_options: {},
        prompt_pins: { default: "0198f2a1-0000-7000-8000-00000000a003" },
      },
      embed: {
        id: "0198f2a1-0000-7000-8000-00000000d003",
        revision: 2,
        model_id: "0198f2a1-0000-7000-8000-00000000e002",
        params: {},
        provider_options: {},
        prompt_pins: {},
      },
    },
    prompt_versions: {
      "0198f2a1-0000-7000-8000-00000000a001": {
        id: "0198f2a1-0000-7000-8000-00000000a001",
        prompt_id: "0198f2a1-0000-7000-8000-00000000b001",
        number: 2,
        engine: "liquid",
        messages: [
          { role: "system", content: "You are a friendly greeter." },
          { role: "user", content: "Say hello to {{ name }}." },
        ],
        text_template: null,
      },
      "0198f2a1-0000-7000-8000-00000000a002": {
        id: "0198f2a1-0000-7000-8000-00000000a002",
        prompt_id: "0198f2a1-0000-7000-8000-00000000b002",
        number: 1,
        engine: "liquid",
        messages: [
          { role: "system", content: "너는 친절한 인사 도우미다." },
          { role: "user", content: "{{ name }}님에게 인사해줘." },
        ],
        text_template: null,
      },
      "0198f2a1-0000-7000-8000-00000000a003": {
        id: "0198f2a1-0000-7000-8000-00000000a003",
        prompt_id: "0198f2a1-0000-7000-8000-00000000b003",
        number: 4,
        engine: "liquid",
        messages: null,
        text_template: "Summarize:\n{% for item in items %}- {{ item }}\n{% endfor %}",
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
    },
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
