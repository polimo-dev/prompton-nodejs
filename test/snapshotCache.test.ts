import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PromptOn } from "../src/index.js";
import {
  fakeFetch,
  recordingLogger,
  sleep,
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

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(100)));
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the 10-second cache", () => {
  it("serves every resolve from memory inside the TTL, with no HTTP call", async () => {
    const fetch = fakeFetch(() => snapshotResponse(snapshotDocument()));
    const client = make({ apiKey: "ptn_sdkfixture_key", baseUrl: "http://ptn.test", fetch, poll: false });
    await client.ready();
    expect(fetch.calls.length).toBe(1);

    for (let i = 0; i < 50; i += 1) {
      expect(client.resolve("greeting").model).toBe("openai/gpt-4o-mini");
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
    await sleep(40);

    // The resolve is synchronous and answers from the document already held.
    expect(client.resolve("greeting").model).toBe("openai/gpt-4o-mini");
    await sleep(20);

    expect(fetch.calls.length).toBe(2);
    const headers = fetch.calls[1]?.init?.headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe('"sha256-one"');
    expect(client.snapshotInfo().etag).toBe('"sha256-one"');
  });

  it("a 304 leaves the document in place and clears the stale flag", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0
        ? snapshotResponse(snapshotDocument(), '"sha256-one"')
        : snapshotResponse(null, '"sha256-one"', 304),
    );
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch, poll: false });
    await client.ready();
    const first = client.resolve("greeting");

    const result = await client.refresh();
    expect(result.status).toBe("not_modified");
    expect(client.resolve("greeting")).toEqual(first);
    expect(client.snapshotInfo().stale).toBe(false);
  });
});

describe("rate limiting and backoff", () => {
  it("honours Retry-After on 429, keeps serving, and does not call again before it elapses", async () => {
    const stub = await startStubServer((request, response) => {
      if (request.path.startsWith("/api/v1/snapshot")) {
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
      apiKey: "ptn_k_1",
      baseUrl: stub.url,
      cacheTtlMs: 10,
      poll: false,
    });
    await client.ready();
    expect(stub.requests.length).toBe(1);

    await sleep(20);
    const second = await client.refresh();
    expect(second).toMatchObject({ status: "failed", retryInMs: 60_000 });
    expect(stub.requests.length).toBe(2);

    // The caller sees no error, and no further request is made before Retry-After elapses.
    for (let i = 0; i < 20; i += 1) {
      expect(client.resolve("greeting").model).toBe("openai/gpt-4o-mini");
      client.resolve("greeting");
    }
    await sleep(30);
    client.resolve("greeting");
    await sleep(10);
    expect(stub.requests.length).toBe(2);
  });

  it("backs off exponentially from the TTL on 5xx and keeps serving the last document", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0
        ? snapshotResponse(snapshotDocument(), '"e1"')
        : new Response(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
            status: 500,
          }),
    );
    const client = make({
      apiKey: "ptn_k_1",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 1000,
      poll: false,
    });
    await client.ready();

    const first = await client.refresh();
    expect(first).toMatchObject({ status: "failed", retryInMs: 1000 });
    const second = await client.refresh();
    expect(second).toMatchObject({ status: "failed", retryInMs: 2000 });
    const third = await client.refresh();
    expect(third).toMatchObject({ status: "failed", retryInMs: 4000 });

    expect(client.resolve("greeting").model).toBe("openai/gpt-4o-mini");
    expect(client.snapshotInfo().stale).toBe(true);
  });

  it("caps the backoff at five minutes", async () => {
    const fetch = fakeFetch((_url, _init, call) =>
      call === 0 ? snapshotResponse(snapshotDocument()) : new Response("", { status: 503 }),
    );
    const client = make({
      apiKey: "ptn_k_1",
      baseUrl: "http://ptn.test",
      fetch,
      cacheTtlMs: 10_000,
      poll: false,
    });
    await client.ready();
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      const result = await client.refresh();
      if (result.status === "failed") last = result.retryInMs;
    }
    expect(last).toBe(300_000);
  });
});

describe("the server being down", () => {
  it("keeps resolving from the last good snapshot when the connection is refused", async () => {
    const stub = await startStubServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json", etag: '"e1"' });
      response.end(JSON.stringify(snapshotDocument()));
    });
    const url = stub.url;
    const client = make({ apiKey: "ptn_k_1", baseUrl: url, cacheTtlMs: 10, poll: false });
    await client.ready();
    await stub.close();

    const result = await client.refresh();
    expect(result.status).toBe("failed");
    expect(client.resolve("greeting").model).toBe("openai/gpt-4o-mini");
    expect(client.snapshotInfo().stale).toBe(true);
  });

  it("fails resolution with a clear error when no tier holds a document", async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch, poll: false });
    await client.ready();
    expect(() => client.resolve("greeting")).toThrowError(/unreachable and nothing is cached/u);
    expect(client.snapshotInfo().source).toBe("none");
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

    const sidecar = JSON.parse(readFileSync(`${path}.meta.json`, "utf8")) as Record<string, unknown>;
    expect(sidecar["etag"]).toBe('"sha256-disk"');
    expect(sidecar["environment"]).toBe("production");
    expect(sidecar["project"]).toBe("sdkfixture");

    const offline = make({ mode: "offline", diskCache: path, project: "sdkfixture" });
    expect(offline.resolve("greeting").source).toBe("disk");
    expect(offline.snapshotInfo().etag).toBe('"sha256-disk"');
  });

  it("falls back to the bundle when the disk cache is empty", () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const bundle = join(dir.path, "snapshot.production.json");
    writeFileSync(bundle, JSON.stringify(snapshotDocument()));

    const client = make({
      mode: "offline",
      diskCache: join(dir.path, "missing.json"),
      bundlePath: bundle,
    });
    const resolution = client.resolve("greeting");
    expect(resolution.source).toBe("bundle");
    expect(resolution.model).toBe("openai/gpt-4o-mini");
  });

  it("refuses a document from another environment", () => {
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
    expect(() => client.resolve("greeting")).toThrowError(/nothing is cached/u);
    expect(logger.lines.join("\n")).toMatch(/refusing the bundle snapshot/u);
  });

  it("refuses a document from another project", () => {
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
    expect(() => client.resolve("greeting")).toThrowError(/nothing is cached/u);
    expect(logger.lines.join("\n")).toMatch(/refusing the bundle snapshot/u);
  });

  it("ignores a half-written or corrupt file instead of failing", () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const path = join(dir.path, "snap.json");
    writeFileSync(path, '{"schema_version": 3, "use_cas');

    const logger = recordingLogger();
    const client = new PromptOn({ mode: "offline", diskCache: path, logger });
    clients.push(client);
    expect(client.snapshotInfo().source).toBe("none");
    expect(logger.lines.join("\n")).toMatch(/ignoring the disk snapshot/u);
  });

  it("exports the current document byte for byte, for use as a bundle", async () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const raw = JSON.stringify(snapshotDocument());
    const fetch = fakeFetch(
      () => new Response(raw, { status: 200, headers: { etag: '"sha256-x"' } }),
    );
    const client = make({ apiKey: "ptn_k_1", baseUrl: "http://ptn.test", fetch, poll: false });
    await client.ready();

    const out = join(dir.path, "bundle.json");
    client.exportSnapshot(out);
    expect(readFileSync(out, "utf8")).toBe(raw);
  });

  it("works with no API key at all, from the bundle, and says so once", () => {
    const dir = tempDir();
    cleanups.push(dir.cleanup);
    const bundle = join(dir.path, "bundle.json");
    writeFileSync(bundle, JSON.stringify(snapshotDocument()));

    const logger = recordingLogger();
    const client = new PromptOn({ apiKey: null, diskCache: false, bundlePath: bundle, logger });
    clients.push(client);
    expect(client.resolve("greeting").source).toBe("bundle");
    expect(logger.lines.filter((line) => line.includes("no API key")).length).toBe(1);
  });
});
