import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { apiBase, DEFAULT_HOST, projectFromApiKey, resolveConfig, VERSION } from "../src/index.js";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { version: string };

describe("configuration precedence", () => {
  it("prefers an explicit option over the environment variable over the default", () => {
    const env = { PTN_HOST: "https://env.example", PTN_API_KEY: "ptn_env_abc" };
    expect(resolveConfig({ baseUrl: "https://opt.example" }, env).baseUrl).toBe(
      "https://opt.example/api/v1",
    );
    expect(resolveConfig({}, env).baseUrl).toBe("https://env.example/api/v1");
    expect(resolveConfig({}, {}).baseUrl).toBe(`${DEFAULT_HOST}/api/v1`);

    expect(resolveConfig({ apiKey: "ptn_opt_abc" }, env).apiKey).toBe("ptn_opt_abc");
    expect(resolveConfig({}, env).apiKey).toBe("ptn_env_abc");
    expect(resolveConfig({}, {}).apiKey).toBeNull();
  });

  it("defaults the environment to production", () => {
    expect(resolveConfig({}, {}).environment).toBe("production");
    expect(resolveConfig({}, { PTN_ENVIRONMENT: "staging" }, ).environment).toBe("staging");
    expect(resolveConfig({ environment: "staging" }, {}).environment).toBe("staging");
  });

  it("appends /api/v1 exactly once", () => {
    expect(apiBase("https://app.prompton.ai")).toBe("https://app.prompton.ai/api/v1");
    expect(apiBase("https://app.prompton.ai/")).toBe("https://app.prompton.ai/api/v1");
    expect(apiBase("https://app.prompton.ai/api/v1")).toBe("https://app.prompton.ai/api/v1");
  });

  it("takes the project slug from the API key", () => {
    expect(projectFromApiKey("ptn_heydiary_aaaaaaaabbbbbbbbccccccccdddddddd")).toBe("heydiary");
    expect(projectFromApiKey("not-a-key")).toBeNull();
    expect(projectFromApiKey(null)).toBeNull();
  });

  it("names the disk cache after the project and the environment", () => {
    const config = resolveConfig(
      { apiKey: "ptn_heydiary_abc", environment: "staging" },
      { PTN_CACHE_DIR: "/var/cache/x" },
    );
    expect(config.diskCachePath).toBe("/var/cache/x/prompts-heydiary-staging.json");
  });

  it("can turn the disk cache off, or point it anywhere", () => {
    expect(resolveConfig({ diskCache: false }, {}).diskCachePath).toBeNull();
    expect(resolveConfig({ diskCache: "/tmp/x.json" }, {}).diskCachePath).toBe("/tmp/x.json");
  });

  it("defaults the cache TTL to ten seconds", () => {
    expect(resolveConfig({}, {}).cacheTtlMs).toBe(10_000);
  });

  it("refuses a nonsensical value", () => {
    expect(() => resolveConfig({ cacheTtlMs: 0 }, {})).toThrowError(/positive/u);
    expect(() => resolveConfig({ mode: "nope" as never }, {})).toThrowError(/live, test or offline/u);
  });

  it("sends a versioned User-Agent that matches the package version", () => {
    expect(resolveConfig({}, {}).userAgent).toBe(`prompton-nodejs/${VERSION}`);
    expect(VERSION).toBe(pkg.version);
  });
});
