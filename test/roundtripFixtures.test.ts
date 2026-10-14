import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { decodePromptDocument, PromptOn } from "../src/index.js";

const ROUNDTRIP = "/Users/ys/ws/.omx/artifacts/variables-20261014/roundtrip";

function fixture(name: string): Record<string, any> {
  return JSON.parse(readFileSync(join(ROUNDTRIP, name), "utf8"));
}

function loaded(document: Record<string, unknown>): PromptOn {
  const client = new PromptOn({ mode: "test", diskCache: false, poll: false, flushOnExit: false, logger: false });
  client.loadPrompts(document);
  return client;
}

describe("real schema v1 server fixtures", () => {
  it("rejects the lightweight index as configuration", () => {
    expect(() => decodePromptDocument(fixture("index.json"))).toThrow(/index responses are discovery only/u);
  });

  it("decodes and locally prepares the chat detail response like the server render", async () => {
    const detail = fixture("chat-detail.json");
    const variables = fixture("chat-variables.json");
    const rendered = fixture("chat-render.json");
    const client = loaded(detail);
    try {
      const prompt = await client.prompt(rendered.key);
      expect(prompt.messages(variables)).toEqual(rendered.messages);
      expect(prompt.deployment).toEqual({ id: null, revision: rendered.deployment.revision });
      expect(prompt.model).toBe(rendered.model);
      expect(prompt.promptVersion).toEqual({ id: null, number: detail.prompt_version.number });
      const request = prompt.request(variables);
      expect(request).toMatchObject({ method: "POST", path: detail.deployment.request_path });
      expect(request.body).toMatchObject({ model: rendered.model, messages: rendered.messages, ...rendered.params });
    } finally {
      await client.close(100);
    }
  });

  it("decodes and locally prepares the Decision detail response like the server render", async () => {
    const detail = fixture("decision-detail.json");
    const variables = fixture("decision-variables.json");
    const rendered = fixture("decision-render.json");
    const client = loaded(detail);
    try {
      const prompt = await client.prompt(rendered.key);
      const request = prompt.request(variables);
      expect(prompt.kind).toBe("decision");
      expect(prompt.deployment).toEqual({ id: null, revision: rendered.deployment.revision });
      expect(prompt.model).toBe(rendered.model);
      expect(request).toMatchObject({ method: "POST", path: detail.deployment.request_path });
      expect(request.body).toMatchObject({ model: rendered.model, ...rendered.decision, ...rendered.params });
    } finally {
      await client.close(100);
    }
  });
});
