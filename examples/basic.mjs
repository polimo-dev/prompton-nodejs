/**
 * A complete PromptOn call site, runnable with no server:
 *
 *   npm run build && node examples/basic.mjs
 *
 * With `PTN_API_KEY` set it fetches the live prompt document and really sends the monitoring log; without
 * one it runs from the bundled prompt document in this directory and prints the record it would have sent.
 * Either way it is the same code — that is the point of the bundle.
 */

import { fileURLToPath } from "node:url";
import { PromptOn } from "prompton-sdk";

const live = Boolean(process.env.PTN_API_KEY);

const prompton = new PromptOn({
  // Committed at migration time so a cold start with no network still resolves.
  bundlePath: fileURLToPath(new URL("./prompts.production.json", import.meta.url)),
  diskCache: false,
  // In test mode nothing is sent; the records are kept for inspection.
  mode: live ? "live" : "test",
});

// Optional: a short-lived script wants the first fetch before it resolves.
await prompton.ready();

// 1. Resolve a prompt — synchronous, served from memory, never blocks on the network.
const prompt = prompton.prompt("greeting", { template: "default" });
console.info(
  `prompt ${prompt.key} → model ${prompt.model} (revision ${prompt.deployment.revision}, from ${prompt.source})`,
);

// 2. Render this call's variables into the pinned prompt.
const variables = { name: "Ada" };
const messages = prompt.messages(variables);
console.info("messages:", JSON.stringify(messages, null, 2));
const request = prompt.request(variables);
console.info("provider request:", JSON.stringify(request, null, 2));

// 3. Call the provider yourself, with your own key and your own HTTP client. PromptOn is never in
//    the request path — this stand-in is where your OpenAI/OpenRouter/Anthropic call goes.
async function callProvider(prepared) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    choices: [{ message: { content: `Hello, ${variables.name}! (${prepared.body.model})` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 38, completion_tokens: 9 },
    _echo: { path: prepared.path, messages: prepared.body.messages.length },
  };
}

// 4. Time the call and log it. Whatever the function returns comes back unchanged; whatever it
//    throws is logged as an error record and rethrown.
const response = await prompt.track(
  () => callProvider(request),
  {
    variables,
    inputMessages: messages,
    endUserRef: "user-42",
    traceId: "example:1",
    context: { language: "en", plan: "pro" },
    metadata: { attempt: 1 },
  },
  // Map the provider's response onto the fields a monitoring log records.
  (result) => ({
    content: result.choices[0].message.content,
    finishReason: result.choices[0].finish_reason,
    usage: {
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    },
    costSource: "unknown",
  }),
);

console.info("provider said:", response.choices[0].message.content);

// 5. Flush before the process exits. In a long-running server you never call this: the buffer
//    flushes on size, on time, and on exit.
const flushed = await prompton.flush();
console.info("flush:", flushed);

if (!live) {
  console.info("record that would have been sent:", JSON.stringify(prompton.logs[0], null, 2));
}

await prompton.close();
