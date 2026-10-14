import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { decodePromptDocument, PreparedRequestError, PromptOn, Result, TemplateRenderError, UnknownTemplateError, UnresolvedError } from "../src/index.js";
import { fakeFetch, readableSnapshotDocument, singlePromptDocument, snapshotDocument, snapshotResponse } from "./helpers.js";

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

it("rejects non-v1 prompt documents and requires the immutable version kind", async () => {
  const legacy = snapshotDocument();
  legacy["schema_version"] = 5;
  expect(() => loaded(legacy)).toThrow(/unsupported prompt document schema_version 5/u);

  const partial = snapshotDocument();
  const versionId = (partial["deployments"] as any)["greeting"]["template_pins"]["default"];
  delete (partial["prompt_versions"] as any)[versionId]["kind"];
  const broken = await loaded(partial).prompt("greeting");
  expect(() => broken.request({ name: "Ada" })).toThrow(PreparedRequestError);
});

it("decodes prompt variable definitions from variables and rejects old input_schema metadata", () => {
  const decoded = decodePromptDocument(readableSnapshotDocument()).data;
  expect(decoded.prompts["greeting"]?.variables).toEqual([
    { name: "name", type: "string", required: true, description: null, example: null },
  ]);
  expect((decoded.prompts["greeting"] as any).inputSchema).toBeUndefined();

  const old = readableSnapshotDocument();
  const greeting = (old["prompts"] as any)["greeting"];
  greeting["input_schema"] = greeting["variables"];
  delete greeting["variables"];
  expect(() => decodePromptDocument(old)).toThrow(/not input_schema/u);
});

it("reads schema v1 prompt documents without public resource UUIDs", async () => {
  const client = loaded(readableSnapshotDocument());
  const greeting = await client.prompt("greeting");
  expect(greeting.deployment).toEqual({ id: null, revision: "v2026.09.30-3" });
  expect(greeting.modelId).toBeNull();
  expect(greeting.model).toBe("openai/gpt-4o-mini");
  expect(greeting.provider).toBe("openrouter");
  expect(greeting.promptVersion).toEqual({ id: null, number: 2 });
  expect(greeting.messages({ name: "Ada" })[1]?.content).toBe("Say hello to Ada.");
  const request = greeting.request({ name: "Ada" });
  expect(request.body["model"]).toBe("openai/gpt-4o-mini");
  expect(request.body).not.toHaveProperty("model_id");

  await greeting.track(() => ({ content: "Hello", finishReason: "stop" }));
  expect(client.logs[0]).toMatchObject({
    deployment_revision: "v2026.09.30-3",
    prompt_version_number: 2,
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
  });
  expect(client.logs[0]).not.toHaveProperty("deployment_id");
  expect(client.logs[0]).not.toHaveProperty("prompt_version_id");
  expect(client.logs[0]).not.toHaveProperty("model_id");
});

it("reads schema v1 single-prompt Chat and Decision documents", async () => {
  const greeting = await loaded(singlePromptDocument("greeting")).prompt("greeting");
  expect(greeting.deployment).toEqual({ id: null, revision: "v2026.09.30-3" });
  expect(greeting.modelId).toBeNull();
  expect(greeting.model).toBe("openai/gpt-4o-mini");
  expect(greeting.provider).toBe("openrouter");
  expect(greeting.promptVersion).toEqual({ id: null, number: 2 });
  expect(greeting.messages({ name: "Ada" })[1]?.content).toBe("Say hello to Ada.");

  const sentiment = await loaded(singlePromptDocument("sentiment")).prompt("sentiment");
  const request = sentiment.request({ diary: "fine" });
  expect(request.path).toBe("/api/v1/systemone");
  expect(request.body["model"]).toBe("typesafe/jev-1.13");
  expect(request.body["state"]).toEqual({ diary: "fine", static_key: "literal" });
  expect(request.body["questions"]).toHaveProperty("mood");
  expect(request.body["questions"]).toHaveProperty("intensity");
});

it("rejects incomplete, mixed or mismatched schema v1 single-prompt documents", () => {
  const missing = singlePromptDocument("greeting");
  delete (missing as any)["prompt_version"];
  expect(() => loaded(missing)).toThrow(/prompt_version is required/u);

  const mixed = singlePromptDocument("greeting", "production", { prompts: {} });
  expect(() => loaded(mixed)).toThrow(/singular resources/u);

  const mixedNull = singlePromptDocument("greeting", "production", { prompts: null });
  expect(() => loaded(mixedNull)).toThrow(/singular resources/u);

  const badVersionPrompt = singlePromptDocument("greeting");
  (badVersionPrompt["prompt_version"] as any)["prompt"] = "review";
  expect(() => loaded(badVersionPrompt)).toThrow(/prompt_version\.prompt/u);

  const badDeploymentVersion = singlePromptDocument("greeting");
  (badDeploymentVersion["deployment"] as any)["prompt_version"] = 99;
  expect(() => loaded(badDeploymentVersion)).toThrow(/deployment\.prompt_version/u);

  const badModel = singlePromptDocument("greeting");
  (badModel["deployment"] as any)["model"] = "different/model";
  expect(() => loaded(badModel)).toThrow(/provider\/model/u);
});

it("scopes schema v1 prompt versions by prompt and models by provider", async () => {
  const doc = readableSnapshotDocument();
  (doc["prompts"] as any)["review"] = {
    kind: "chat",
    variables: [],
    default_params: {},
    payload_policy: null,
  };
  (doc["deployments"] as any)["review"] = {
    revision: "v2026.09.30-7",
    provider: "direct",
    model: "openai/gpt-4o-mini",
    prompt_version: 2,
    api: "chat_completions",
    request_path: "/v1/chat/completions",
    params: {},
    provider_options: {},
  };
  (doc["prompt_versions"] as any)["review@2"] = {
    prompt: "review",
    number: 2,
    kind: "chat",
    engine: "liquid",
    messages: [{ role: "user", content: "Review {{ item }}." }],
    text_template: null,
  };
  (doc["models"] as any)["direct:openai/gpt-4o-mini"] = {
    provider: "direct",
    model: "openai/gpt-4o-mini",
    display_name: "Direct GPT-4o mini",
    metadata: {},
    provider_options: { base_url: "https://api.openai.example" },
    capabilities: [],
    status: "active",
  };

  const client = loaded(doc);
  expect((await client.prompt("greeting")).providerOptions).toEqual({ only: ["OpenAI"] });
  expect((await client.prompt("review")).providerOptions).toEqual({ base_url: "https://api.openai.example" });
  expect((await client.prompt("review")).messages({ item: "diff" })).toEqual([
    { role: "user", content: "Review diff." },
  ]);
});

it("fails closed for schema v1 invalid pins and missing readable references", async () => {
  for (const promptVersion of ["2", "2abc", 2.9, 0]) {
    const invalid = readableSnapshotDocument();
    (invalid["deployments"] as any)["greeting"]["prompt_version"] = promptVersion;
    await expect(loaded(invalid).prompt("greeting")).rejects.toThrow(UnknownTemplateError);
  }

  const missingVersion = readableSnapshotDocument();
  (missingVersion["deployments"] as any)["greeting"]["prompt_version"] = 99;
  await expect(loaded(missingVersion).prompt("greeting")).rejects.toThrow(UnresolvedError);

  const missingModel = readableSnapshotDocument();
  (missingModel["deployments"] as any)["greeting"]["model"] = "missing/model";
  await expect(loaded(missingModel).prompt("greeting")).rejects.toThrow(UnresolvedError);
});

it("drops schema v1 resources whose composite keys disagree with embedded fields", async () => {
  const badVersion = readableSnapshotDocument();
  (badVersion["prompt_versions"] as any)["greeting@2"] = {
    ...(badVersion["prompt_versions"] as any)["greeting@2"],
    prompt: "review",
  };
  await expect(loaded(badVersion).prompt("greeting")).rejects.toThrow(UnresolvedError);

  const badNumber = readableSnapshotDocument();
  (badNumber["prompt_versions"] as any)["greeting@2"] = {
    ...(badNumber["prompt_versions"] as any)["greeting@2"],
    number: 2.9,
  };
  await expect(loaded(badNumber).prompt("greeting")).rejects.toThrow(UnresolvedError);

  const badModel = readableSnapshotDocument();
  (badModel["models"] as any)["openrouter:openai/gpt-4o-mini"] = {
    ...(badModel["models"] as any)["openrouter:openai/gpt-4o-mini"],
    provider: "direct",
  };
  await expect(loaded(badModel).prompt("greeting")).rejects.toThrow(UnresolvedError);

  const badDeploymentModel = readableSnapshotDocument();
  (badDeploymentModel["deployments"] as any)["greeting"]["model"] = 123;
  await expect(loaded(badDeploymentModel).prompt("greeting")).rejects.toThrow(UnresolvedError);

  const duplicate = readableSnapshotDocument();
  (duplicate["models"] as any)["direct:openai/gpt-4o-mini"] = {
    provider: "openrouter",
    model: "openai/gpt-4o-mini",
    display_name: "alias",
    metadata: {},
    provider_options: { only: ["Wrong"] },
    capabilities: [],
    status: "active",
  };
  expect((await loaded(duplicate).prompt("greeting")).providerOptions).toEqual({ only: ["OpenAI"] });
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
