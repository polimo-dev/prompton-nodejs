/**
 * A complete PromptOn call site, runnable with no server:
 *
 *   npm run build && node examples/basic.mjs
 *
 * With `PTN_API_KEY` set it fetches the live use-case document and really sends the monitoring log; without
 * one it runs from the bundled use-case document in this directory and prints the record it would have sent.
 * Either way it is the same code — that is the point of the bundle.
 */

import { fileURLToPath } from "node:url";
import { PromptOn } from "prompton-sdk";

const live = Boolean(process.env.PTN_API_KEY);

const prompton = new PromptOn({
  // Committed at migration time so a cold start with no network still resolves.
  bundlePath: fileURLToPath(new URL("./use-cases.production.json", import.meta.url)),
  diskCache: false,
  // In test mode nothing is sent; the records are kept for inspection.
  mode: live ? "live" : "test",
});

// Optional: a short-lived script wants the first fetch before it resolves.
await prompton.ready();

// 1. Resolve a use case — synchronous, served from memory, never blocks on the network.
const useCase = prompton.useCase("greeting", { prompt: "default" });
console.info(
  `use case ${useCase.key} → model ${useCase.model} (revision ${useCase.deployment.revision}, from ${useCase.source})`,
);

// 2. Render this call's variables into the pinned prompt.
const variables = { name: "Ada" };
const messages = useCase.messages(variables);
console.info("messages:", JSON.stringify(messages, null, 2));

// 3. Call the provider yourself, with your own key and your own HTTP client. PromptOn is never in
//    the request path — this stand-in is where your OpenAI/OpenRouter/Anthropic call goes.
async function callProvider({ model, params, providerOptions, messages: sent }) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  return {
    choices: [{ message: { content: `Hello, ${variables.name}! (${model})` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 38, completion_tokens: 9 },
    _echo: { params, providerOptions, sent: sent.length },
  };
}

// 4. Time the call and log it. Whatever the function returns comes back unchanged; whatever it
//    throws is logged as an error record and rethrown.
const response = await useCase.track(
  () => callProvider({ ...useCase, messages }),
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
