import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { PreparedRequestError, PromptOn, Result, TemplateRenderError } from "../src/index.js";
import { fakeFetch, snapshotDocument, snapshotResponse } from "./helpers.js";

const clients: PromptOn[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close(100))); });

function loaded(document = snapshotDocument()): PromptOn {
  const client = new PromptOn({ mode: "test", diskCache: false, poll: false, flushOnExit: false, logger: false });
  clients.push(client);
  client.loadPrompts(document);
  return client;
}

it("preserves provider null while omitting ordinary Chat null params", async () => {
  const request = (await loaded().prompt("greeting")).request({ name: "Ada" }, {
    params: { temperature: null }, providerOptions: { only: null },
  });
  expect(request.body).not.toHaveProperty("temperature");
  expect(request.body["provider"]).toEqual({ only: null });
});

it("records native Decision input and retains full typed answers", async () => {
  const client = loaded();
  const prompt = await client.prompt("sentiment");
  const inputDecision = { state: "hello", questions: { urgent: { type: "noul", instructions: "Urgent?" } } };
  const raw = { model: "typesafe/jev-1.13", answers: { urgent: { type: "noul", noul: 0 } }, usage: { input_tokens: 3, output_tokens: 1, cost: 0 } };
  const result = await prompt.track(() => Result.fromDecisions(raw), { inputDecision });
  expect(result.result).toEqual(raw);
  expect(JSON.parse(result.content ?? "null")).toEqual(raw.answers);
  expect(client.logs[0]).toMatchObject({ kind: "decision", input: { decision: inputDecision } });
});

it("rejects protected params and null Decision metadata rather than silently dropping them", async () => {
  const client = loaded();
  for (const key of ["model", "messages", "state", "questions", "provider", "usage", "api", "request_path", "method", "path", "body"]) {
    const prompt = await client.prompt("greeting");
    expect(() => prompt.request({ name: "Ada" }, { params: { [key]: null } })).toThrow(PreparedRequestError);
  }
  for (const key of ["user", "trace", "session_id", "temperature"]) {
    const prompt = await client.prompt("sentiment");
    expect(() => prompt.request({ diary: "hi" }, { params: { [key]: null } })).toThrow(PreparedRequestError);
  }
  const sentiment = await client.prompt("sentiment");
  const greeting = await client.prompt("greeting");
  expect(() => sentiment.request({ diary: "hi" }, { trace: null })).toThrow(PreparedRequestError);
  expect(() => greeting.request({ name: "Ada" }, { session_id: "session" })).toThrow(PreparedRequestError);
});

it("accepts the legacy OpenRouter Decisions path for cached prompt documents", async () => {
  const doc = snapshotDocument();
  (doc["deployments"] as any)["sentiment"]["request_path"] = "/api/alpha/decisions";
  expect((await loaded(doc).prompt("sentiment")).request({ diary: "hi" }).path).toBe("/api/alpha/decisions");
});

it.each(["/api/v1/chat/completions", "/api/systemone", "/v1/systemone", "/\\attacker.example", "https://attacker.example"])(
  "refuses a Decision deployment with mismatched path %s", async (path) => {
    const doc = snapshotDocument();
    (doc["deployments"] as any)["sentiment"]["request_path"] = path;
    const prompt = await loaded(doc).prompt("sentiment");
    expect(() => prompt.request({ diary: "hi" })).toThrow(PreparedRequestError);
  },
);

it("does not send OpenRouter routing options to native OpenAI", async () => {
  const doc = snapshotDocument();
  const deployment = (doc["deployments"] as any)["greeting"];
  deployment["request_path"] = "/v1/chat/completions";
  (doc["models"] as any)[deployment["model_id"]]["provider"] = "openai";
  const prompt = await loaded(doc).prompt("greeting");
  expect(() => prompt.request({ name: "Ada" })).toThrow(PreparedRequestError);
});

it("preserves __proto__ as a question name and keeps keys literal", async () => {
  const doc = snapshotDocument();
  const versionId = (doc["deployments"] as any)["sentiment"]["template_pins"]["default"];
  const decision = (doc["prompt_versions"] as any)[versionId]["decision"];
  decision["questions"] = JSON.parse('{"__proto__":{"type":"noul","instructions":"Read {{ diary }}"}}');
  const request = (await loaded(doc).prompt("sentiment")).request({ diary: "hello" });
  expect(Object.keys(request.body["questions"] as object)).toEqual(["__proto__"]);
  expect(JSON.parse(JSON.stringify(request.body))["questions"]["__proto__"]["instructions"]).toBe("Read hello");
});

it("legacy v5 ignores injected request metadata and v6 requires the immutable version kind", async () => {
  const legacy = snapshotDocument();
  legacy["schema_version"] = 5;
  const client = loaded(legacy);
  const prompt = await client.prompt("greeting");
  expect(prompt.messages({ name: "Ada" })[1]?.content).toBe("Say hello to Ada.");
  expect(() => prompt.request({ name: "Ada" })).toThrow(PreparedRequestError);
  const partial = snapshotDocument();
  const versionId = (partial["deployments"] as any)["greeting"]["template_pins"]["default"];
  delete (partial["prompt_versions"] as any)[versionId]["kind"];
  const broken = await loaded(partial).prompt("greeting");
  expect(() => broken.request({ name: "Ada" })).toThrow(PreparedRequestError);
});

it("composes app history and current input while retaining prepared options and logging final messages", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./conformance/http_contract.json", import.meta.url), "utf8"));
  const client = loaded(fixture.snapshot);
  const prompt = await client.prompt(fixture.render.key);
  const variables = { locale: "ko-KR", topic: "park walks" };
  const request = prompt.request(variables);

  expect(request).toEqual(fixture.render.request);
  const managedMessages = prompt.messages(variables);
  const messages = [...managedMessages, ...fixture.application.conversation_history, fixture.application.current_user_message];
  const body = { ...request.body, messages } as any;
  expect(body.messages[2].tool_calls[0].id).toBe("call_history_1");
  expect(body.messages[3].tool_call_id).toBe("call_history_1");
  expect(body.messages[6].tool_calls[0].id).toBe("call_prior_1");
  expect(body.messages[7].tool_call_id).toBe("call_prior_1");
  expect(body.messages.at(-1)).toEqual(fixture.application.current_user_message);
  expect(request.body.messages).toEqual(managedMessages);
  expect({ ...body, messages: managedMessages }).toEqual(request.body);
  expect(body.tools[0].function.output_schema).toBeUndefined();
  expect(body.tools[0].output_schema).toBeUndefined();
  await prompt.track(() => ({ content: "Summary", finishReason: "stop" }), { variables, inputMessages: messages });
  expect(client.logs[0]?.input).toEqual({ variables, messages });
});

it.each(["liquid", "raw"])("rejects retired slots from cached %s prompt documents at both public render boundaries", async (engine) => {
  const doc = snapshotDocument();
  const id = (doc.deployments as any).greeting.template_pins.default;
  (doc.prompt_versions as any)[id].engine = engine;
  (doc.prompt_versions as any)[id].messages = [{ type: "slot", name: "history", role: "system" }];
  const prompt = await loaded(doc).prompt("greeting");
  const variables = { history: [{ role: "user", content: "prior" }] };
  expect(() => prompt.messages(variables)).toThrowError(TemplateRenderError);
  expect(() => prompt.request(variables)).toThrowError("compose conversation history in app code");
});

it("remote Decision rendering and its cache retain native content and the prepared POST request", async () => {
  const decision = { state: "hello", questions: { accept: { type: "noul", instructions: "Accept?" } } };
  const request = { api: "decisions", method: "post", path: "/api/v1/systemone", body: { model: "typesafe/jev-1.13", ...decision } };
  const fetch = fakeFetch((url) => url.includes("/render")
    ? new Response(JSON.stringify({ key: "sentiment", kind: "decision", decision, request, api: request.api, request_path: request.path }), { status: 200 })
    : snapshotResponse(snapshotDocument()));
  const client = new PromptOn({ apiKey: "ptn_fixture_key", baseUrl: "http://fixture.test", fetch, diskCache: false, poll: false, flushOnExit: false, logger: false });
  clients.push(client);
  const first = await client.renderPrompt("sentiment", { variables: {} });
  expect(first.decision).toEqual(decision);
  expect(first.request).toEqual({ ...request, method: "POST" });
  expect(await client.renderPrompt("sentiment", { variables: {} })).toEqual(first);
  expect(fetch.calls.filter((call) => call.url.includes("/render"))).toHaveLength(1);
});
