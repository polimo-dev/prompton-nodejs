import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PromptOn } from "../src/index.js";
import {
  fakeFetch,
  recordingLogger,
  snapshotDocument,
  snapshotResponse,
  startStubServer,
  tempDir,
} from "./helpers.js";

/**
 * The caching rules are the point of the SDK, so each one gets its own test: the 10-second cache,
 * the conditional refresh, the rate limit, the backoff, and the three tiers a snapshot can be
 * served from when PromptOn is down.
 */

const clients: PromptOn[] = [];
const cleanups: (() => void)[] = [];

function make(options: ConstructorParameters<typeof PromptOn>[0]): PromptOn {
  const client = new PromptOn({ logger: recordingLogger(), diskCache: false, ...options });
  clients.push(client);
  return client;
}

function fakeClock(start = 1_000_000): { advance(ms: number): void } {
  let now = start;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  return { advance: (ms) => { now += ms; } };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(100)));
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe("the 10-second cache", () => {
  it("serves every resolve from memory inside the TTL, with no HTTP call", async () => {
    const fetch = fakeFetch(() => snapshotResponse(snapshotDocument()));
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 10,
      poll: false,
    });
    await client.ready();
    expect(fetch.calls.length).toBe(0);

    for (let i = 0; i < 50; i += 1) {
      expect((await client.prompt("greeting")).model).toBe("openai/gpt-4o-mini");
    }
    expect(fetch.calls.length).toBe(1);
  });

  it("revalidates once the TTL has passed, with If-None-Match, and never blocks the resolve", async () => {
    const fetch = fakeFetch((_url, init, call) => {
      if (call === 0) return snapshotResponse(snapshotDocument(), '"sha256-one"');
      return snapshotResponse(null, '"sha256-one"', 304);
    });
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 20,
      poll: false,
    });
    await client.ready();

    const clock = fakeClock();
    await client.prompt("greeting");
    expect(fetch.calls.length).toBe(1);
    clock.advance(10_001);

    expect((await client.prompt("greeting")).model).toBe("openai/gpt-4o-mini");

    expect(fetch.calls.length).toBe(2);
    const headers = fetch.calls[1]?.init?.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe('"sha256-one"');
    expect(client.promptsInfo().etag).toBe('"sha256-one"');
  });


  it("keeps each prompt on its own document even when another prompt updates a shared model id", async () => {
    const greeting = snapshotDocument();
    greeting.prompts = { greeting: (greeting.prompts as Record<string, unknown>).greeting };
    greeting.deployments = { greeting: (greeting.deployments as Record<string, unknown>).greeting };
    greeting.prompt_versions = {
      "0198f2a1-0000-7000-8000-00000000a001": (greeting.prompt_versions as Record<string, unknown>)[
        "0198f2a1-0000-7000-8000-00000000a001"
      ],
      "0198f2a1-0000-7000-8000-00000000a002": (greeting.prompt_versions as Record<string, unknown>)[
        "0198f2a1-0000-7000-8000-00000000a002"
      ],
    };
    (greeting.models as Record<string, { model_id: string }>)[
      "0198f2a1-0000-7000-8000-00000000e001"
    ]!.model_id = "provider/model-a";

    const summarize = snapshotDocument();
    summarize.prompts = { summarize: (summarize.prompts as Record<string, unknown>).summarize };
    summarize.deployments = { summarize: (summarize.deployments as Record<string, unknown>).summarize };
    summarize.prompt_versions = {
      "0198f2a1-0000-7000-8000-00000000a003": (summarize.prompt_versions as Record<string, unknown>)[
        "0198f2a1-0000-7000-8000-00000000a003"
      ],
    };
    (summarize.models as Record<string, { model_id: string }>)[
      "0198f2a1-0000-7000-8000-00000000e001"
    ]!.model_id = "provider/model-b";

    const fetch = fakeFetch((url) => {
      if (url.includes("/prompts/greeting")) return snapshotResponse(greeting, '"greeting"');
      if (url.includes("/prompts/summarize")) return snapshotResponse(summarize, '"summarize"');
      throw new Error(`unexpected URL ${url}`);
    });
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 10_000,
      poll: false,
    });

    expect((await client.prompt("greeting")).model).toBe("provider/model-a");
    expect((await client.prompt("summarize")).model).toBe("provider/model-b");
    expect((await client.prompt("greeting")).model).toBe("provider/model-a");
    expect(fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/v1/prompts/greeting",
      "/api/v1/prompts/summarize",
    ]);
  });

  it("keeps the config fetch gate fixed at 10 seconds even if legacy cacheTtlMs is shorter", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0 ? snapshotResponse(snapshotDocument(), '"e1"') : snapshotResponse(snapshotDocument(), '"e2"'),
    );
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 1,
      poll: false,
    });
    const clock = fakeClock();

    await client.prompt("greeting");
    clock.advance(9_999);
    await client.prompt("greeting");
    expect(fetch.calls.length).toBe(1);

    clock.advance(1);
    await client.prompt("greeting");
    expect(fetch.calls.length).toBe(2);
  });
  it("a 304 leaves the document in place and clears the stale flag", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0
        ? snapshotResponse(snapshotDocument(), '"sha256-one"')
        : snapshotResponse(null, '"sha256-one"', 304),
    );
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 10,
      poll: false,
    });
    await client.ready();
    const clock = fakeClock();
    const first = await client.prompt("greeting");

    clock.advance(10_001);
    const result = await client.refresh({ prompt: "greeting" });
    expect(result.status).toBe("not_modified");
    const current = await client.prompt("greeting");
    expect({
      key: current.key,
      prompt: current.template,
      model: current.model,
      deployment: current.deployment,
      source: current.source,
    }).toEqual({
      key: first.key,
      prompt: first.template,
      model: first.model,
      deployment: first.deployment,
      source: first.source,
    });
    expect(client.promptsInfo().stale).toBe(false);
  });
});

describe("rate limiting and stale fallback", () => {
  it("rate limits 429 failures by attempt start and keeps serving stale config", async () => {
    const stub = await startStubServer((request, response) => {
      if (request.path.startsWith("/api/v1/prompts")) {
        if (stub.requests.length === 1) {
          response.writeHead(200, { "content-type": "application/json", etag: '"e1"' });
          response.end(JSON.stringify(snapshotDocument()));
          return;
        }
        response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
        response.end(JSON.stringify({ error: { code: "rate_limited", message: "slow down" } }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    cleanups.push(() => void stub.close());

    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: stub.url,
      cacheTtlMs: 10,
      poll: false,
    });
    await client.ready();
    const clock = fakeClock();
    await client.prompt("greeting");
    expect(stub.requests.length).toBe(1);

    clock.advance(10_001);
    const second = await client.refresh({ prompt: "greeting" });
    expect(second).toMatchObject({ status: "failed", retryInMs: 10_000 });
    expect(stub.requests.length).toBe(2);

    // The caller sees no error, and no further request is made inside the attempt gate.
    for (let i = 0; i < 20; i += 1) {
      expect((await client.prompt("greeting")).model).toBe("openai/gpt-4o-mini");
      await client.prompt("greeting");
    }
    expect(stub.requests.length).toBe(2);
  });

  it("serves the last document after a 5xx and gates the next attempt by TTL", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0
        ? snapshotResponse(snapshotDocument(), '"e1"')
        : new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
            status: 500,
          }),
    );
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 1000,
      poll: false,
    });
    await client.ready();
    const clock = fakeClock();
    await client.prompt("greeting");
    clock.advance(10_001);

    const first = await client.refresh({ prompt: "greeting" });
    expect(first).toMatchObject({ status: "failed", retryInMs: 10_000 });
    const second = await client.refresh({ prompt: "greeting" });
    expect(second).toMatchObject({ status: "skipped" });

    expect((await client.prompt("greeting")).model).toBe("openai/gpt-4o-mini");
    expect(client.promptsInfo().stale).toBe(true);
  });

  it("does not retry failed config fetches inside the 10-second gate", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0 ? snapshotResponse(snapshotDocument()) : new Response("", { status: 503 }),
    );
    const client = make({
      apiKey: "ptn_sdkfixture_key",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 10,
      poll: false,
    });
    await client.ready();
    const clock = fakeClock();
    await client.prompt("greeting");
    clock.advance(10_001);
    const failed = await client.refresh({ prompt: "greeting" });
    expect(failed.status).toBe("failed");
    const before = fetch.calls.length;
    const skipped = await client.refresh({ prompt: "greeting" });
    expect(skipped.status).toBe("skipped");
    expect(fetch.calls.length).toBe(before);
  });
});

describe("the server being down", () => {
  it("keeps resolving from the last good snapshot when the connection is refused", async () => {
    const stub = await startStubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", etag: '"e1"' });
      response.end(JSON.stringify(snapshotDocument()));
    });
    const url = stub.url;
    const client = make({ apiKey: "ptn_sdkfixture_key", baseUrl: url, cacheTtlMs: 10, poll: false });
    await client.ready();
    const clock = fakeClock();
    await client.prompt("greeting");
    await stub.close();
    clock.advance(10_001);

    const result = await client.refresh({ prompt: "greeting" });
    expect(result.status).toBe("failed");
    expect((await client.prompt("greeting")).model).toBe("openai/gpt-4o-mini");
    expect(client.promptsInfo().stale).toBe(true);
  });

  it("fails resolution with a clear error when no tier holds a document", async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = make({ apiKey: "ptn_sdkfixture_key", baseUrl: "http://ptn.test", fetch, poll: false });
    await client.ready();
    await expect(client.prompt("greeting")).rejects.toThrowError(/unreachable and nothing is cached/u);
    expect(client.promptsInfo().source).toBe("none");
  });
});

describe("the three tiers", () => {
  it("mirrors a fetched snapshot to disk atomically and reads it back on the next start", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "snap.json");

    const fetch = fakeFetch(() => snapshotResponse(snapshotDocument(), '"sha256-disk"'));
    const first = make({
      apiKey: "ptn_sdkfixture_k",
      baseUrl: "http://ptn.test",
      fetch,
      diskCache: path,
      poll: false,
    });
    await first.ready();
    await first.prompt("greeting");

    const sidecar = JSON.parse(readFileSync(`${path}.meta.json`, "utf8")) as Record<string, unknown>;
    expect(sidecar["etag"]).toBe('"sha256-disk"');
    expect(sidecar["environment"]).toBe("production");
    expect(sidecar["project"]).toBe("sdkfixture");

    const offline = make({ mode: "offline", diskCache: path, project: "sdkfixture" });
    expect((await offline.prompt("greeting")).source).toBe("disk");
    expect(offline.promptsInfo().etag).toBe('"sha256-disk"');
    expect((await offline.prompt("sentiment")).request({ diary: "offline" }).path).toBe("/api/v1/systemone");
  });

  it("keeps preparing legacy cached Decision requests from disk", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "snap.json");
    const legacy = snapshotDocument();
    (legacy["deployments"] as any)["sentiment"]["request_path"] = "/api/alpha/decisions";

    const fetch = fakeFetch(() => snapshotResponse(legacy, '"sha256-legacy"'));
    const first = make({
      apiKey: "ptn_sdkfixture_k",
      baseUrl: "http://ptn.test",
      fetch,
      diskCache: path,
      poll: false,
    });
    await first.ready();
    await first.prompt("sentiment");

    const offline = make({ mode: "offline", diskCache: path, project: "sdkfixture" });
    expect((await offline.prompt("sentiment")).request({ diary: "offline" }).path).toBe("/api/alpha/decisions");
  });

  it("falls back to the bundle when the disk cache is empty", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const bundle = join(dir.path, "prompts.production.json");
    writeFileSync(bundle, JSON.stringify(snapshotDocument()));

    const client = make({
      mode: "offline",
      diskCache: join(dir.path, "missing.json"),
      bundlePath: bundle,
    });
    const resolution = await client.prompt("greeting");
    expect(resolution.source).toBe("bundle");
    expect(resolution.model).toBe("openai/gpt-4o-mini");
    expect((await client.prompt("sentiment")).request({ diary: "bundle" }).path).toBe("/api/v1/systemone");
  });

  it("refuses a document from another environment", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const bundle = join(dir.path, "snapshot.staging.json");
    writeFileSync(bundle, JSON.stringify(snapshotDocument("staging")));

    const logger = recordingLogger();
    const client = new PromptOn({
      mode: "offline",
      diskCache: false,
      bundlePath: bundle,
      environment: "production",
      logger,
    });
    clients.push(client);
    await expect(client.prompt("greeting")).rejects.toThrowError(/nothing is cached/u);
    expect(logger.lines.join("\n")).toMatch(/refusing the bundle snapshot/u);
  });

  it("refuses a document from another project", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const bundle = join(dir.path, "other.json");
    writeFileSync(bundle, JSON.stringify(snapshotDocument("production", { project: "elsewhere" })));

    const logger = recordingLogger();
    const client = new PromptOn({
      mode: "offline",
      diskCache: false,
      bundlePath: bundle,
      project: "sdkfixture",
      logger,
    });
    clients.push(client);
    await expect(client.prompt("greeting")).rejects.toThrowError(/nothing is cached/u);
    expect(logger.lines.join("\n")).toMatch(/refusing the bundle snapshot/u);
  });

  it("ignores a half-written or corrupt file instead of failing", () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "snap.json");
    writeFileSync(path, '{"schema_version": 5, "use_cas');

    const logger = recordingLogger();
    const client = new PromptOn({ mode: "offline", diskCache: path, logger });
    clients.push(client);
    expect(client.promptsInfo().source).toBe("none");
    expect(logger.lines.join("\n")).toMatch(/ignoring the disk snapshot/u);
  });

  it("exports the current document byte for byte, for use as a bundle", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const raw = JSON.stringify(snapshotDocument());
    const fetch = fakeFetch(
      () => new Response(raw, { status: 200, headers: { etag: '"sha256-x"' } }),
    );
    const client = make({ apiKey: "ptn_sdkfixture_key", baseUrl: "http://ptn.test", fetch, poll: false });
    await client.ready();
    await client.prompt("greeting");

    const out = join(dir.path, "bundle.json");
    client.exportPrompts(out);
    expect(readFileSync(out, "utf8")).toBe(raw);
  });

  it("works with no API key at all, from the bundle, and says so once", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const bundle = join(dir.path, "bundle.json");
    writeFileSync(bundle, JSON.stringify(snapshotDocument()));

    const logger = recordingLogger();
    const client = new PromptOn({ apiKey: null, diskCache: false, bundlePath: bundle, logger });
    clients.push(client);
    expect((await client.prompt("greeting")).source).toBe("bundle");
    expect(logger.lines.filter((line) => line.includes("no API key")).length).toBe(1);
  });
});
