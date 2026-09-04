# prompton-sdk

The official [PromptOn](https://app.prompton.ai) SDK for Node.js and TypeScript.

PromptOn is the control plane for the prompts and models your app uses. Every place your code calls
an LLM becomes a **use case**, and for each use case and environment PromptOn holds one **pin**: a
prompt version, one model, and its parameters.

**PromptOn is config-fetch, not a proxy.** This SDK fetches a *use-case document* for your pins, selects and
renders it locally, and sends **monitoring logs** back in batches. Your app calls the provider
itself, with your own key and your own HTTP client — PromptOn is never in the request path, never
sees your provider key, and if it goes down your app keeps generating on the last use cases it
received.

```
your app ──load use case──▶ prompt + model + params          (use-case document, cached 10 s, ETag-polled)
   │
   ├──your key, your HTTP client──▶ OpenAI / OpenRouter / Anthropic / …
   │
   └──batched monitoring logs──▶ PromptOn
```

## Install

Not published to npm yet. Depend on the repository:

```sh
npm install github:polimo-dev/prompton-nodejs
```

`dist/` is not committed; npm runs the package's `prepare` script on a git install, which builds it.
Node 20 or newer. No runtime dependencies. ESM and CommonJS both work:

```ts
import { PromptOn } from "prompton-sdk";       // ESM
const { PromptOn } = require("prompton-sdk");  // CommonJS
```

## Quick start

```ts
import { PromptOn } from "prompton-sdk";

const prompton = new PromptOn();                                  // reads PTN_API_KEY, PTN_HOST
const useCase = prompton.useCase("greeting");                     // from memory, no network call
const messages = useCase.messages({ name: "Ada" });               // your variables, rendered locally

const answer = await useCase.track(() =>
  openai.chat.completions.create({ model: useCase.model, messages, ...useCase.params }),
  { variables: { name: "Ada" }, inputMessages: messages },
);
```

`UseCase.track()` times the call, builds the monitoring log and queues it. Whatever your function
returns comes back unchanged; whatever it throws is logged as an error record and rethrown.

A runnable version, which needs no server at all, is in [`examples/basic.mjs`](examples/basic.mjs):

```sh
npm run build && node examples/basic.mjs
```

## Configuration

Precedence is **explicit option → environment variable → default**.

| Option | Environment variable | Default | What it does |
|---|---|---|---|
| `apiKey` | `PTN_API_KEY` | none | The project's runtime key, `ptn_<project>_…`. Without one the SDK makes no remote calls, works from disk and bundle only, and says so once |
| `baseUrl` | `PTN_HOST` | `https://app.prompton.ai` | PromptOn host; `/api/v1` is appended unless it is already there |
| `environment` | `PTN_ENVIRONMENT` | `production` | Which environment's pins to read. It is a request parameter, never a property of the key |
| `project` | `PTN_PROJECT` | parsed from the API key | Names the disk-cache file and guards against a use-case document from another project |
| `cacheTtlMs` | — | `10000` | How long a use-case document is served without revalidating, and the poll interval |
| `requestTimeoutMs` | — | `5000` | Per-request timeout |
| `initialFetchTimeoutMs` | — | `3000` | Timeout of the first fetch, which never blocks an LLM call |
| `diskCache` | `PTN_DISK_CACHE` | on, in the OS cache directory | `true`, `false`, or an explicit path. The file is written atomically with an ETag sidecar |
| `bundlePath` | `PTN_BUNDLE` | none | A use-case document file committed into the app, used when memory and disk are empty |
| `mode` | — | `live` | `live`, `offline` (disk and bundle only, no HTTP) or `test` (no HTTP, records captured) |
| `hashEndUser` | — | `false` | Send `end_user_ref` as an unkeyed sha256 hex |
| `redact` | — | none | `(record) => record`, applied to every record last, after truncation |
| `payloadDefaults` | — | `{mode: "full", sampleRate: 1, maxBytes: 262144}` | Policy used when a use case declares none |
| `log.flushIntervalMs` | — | `2000` | Send a partial batch after this long |
| `log.flushSize` | — | `100` | Send as soon as this many records are queued (hard cap per request: 200) |
| `log.flushBytes` | — | `1000000` | Send as soon as the queue holds this many encoded bytes |
| `log.maxQueue` | — | `10000` | Drop the oldest record past this, and count it |
| `log.maxAttempts` | — | `8` | Retries of one batch before it is dropped and counted |
| `poll` | — | `true` in live mode | Revalidate in the background on a timer |
| `strictRecords` | — | `false` | Make `log()` raise on a record the server would reject, instead of dropping and counting it. For tests |
| `flushOnExit` | — | `true` | Flush the buffer when the process is about to exit. One `beforeExit` listener is shared by every instance |
| `fetch` | — | global `fetch` | Injected for tests |
| `logger` | — | console | Any object with `debug/info/warn/error`, or `false` for silence |

```ts
const prompton = new PromptOn({
  apiKey: process.env.PTN_API_KEY,
  environment: process.env.NODE_ENV === "production" ? "production" : "staging",
  bundlePath: new URL("./prompton/use-cases.production.json", import.meta.url).pathname,
  hashEndUser: true,
});
```

## Resilience

This is the part that matters. An LLM call must never fail because PromptOn did.

**One use-case document, cached, polled.** `useCase()` is synchronous and reads memory. Inside the cache TTL
(10 s by default) it makes no HTTP call at all. Past it, the next call starts a background
revalidation with `If-None-Match` — a `304` costs nothing — and still answers from the document it
already holds. A refresh never blocks an LLM call and never fails one.

**Three tiers, in this order.** Memory, then a disk cache, then a bundle committed into the app:

| Tier | When it is used | `UseCase.source` |
|---|---|---|
| Memory | Always, for every use-case lookup | `remote` after a successful fetch |
| Disk | At start-up, before the first fetch returns; written atomically (temp file + rename) with an ETag sidecar | `disk` |
| Bundle | At start-up when memory and disk are both empty. In serverless this is the primary fallback, not a nicety | `bundle` |

There is no fourth tier and never will be: **no database, no Redis, no shared store.** Instances
never coordinate — ETag polling makes a private copy cheap. Several processes on one host may share
the disk file; writes are atomic, readers tolerate a concurrent rename, and a corrupt or partial
file is ignored rather than raised.

**A document for another environment or another project is never used.** A staging process will not
boot on a production bundle; the file records both and a mismatch is refused with a log line.

**Building a bundle.** Fetch once and write the bytes out, then commit the file:

```ts
const prompton = new PromptOn();
await prompton.refresh();
prompton.exportUseCases("prompton/use-cases.production.json");
```

Export one file per environment (`use-cases.production.json`, `use-cases.staging.json`) and point
`bundlePath` at the one matching the process's environment. A single shared bundle is refused by the
environment guard in whichever environment it was not exported from.

### How it fails

| What happened | What the SDK does | What your app sees |
|---|---|---|
| Inside the cache TTL | Serves memory | Nothing; no HTTP call is made |
| `304 Not Modified` | Keeps the document, clears the stale flag | Nothing |
| `429` with `Retry-After` | Waits it out before contacting the server again, keeps serving | Nothing. `useCasesInfo().stale` turns `true` |
| `5xx`, timeout, DNS failure, connection refused | Backs off ×2 from the cache TTL up to 5 minutes, keeps serving | Nothing |
| A use-case document for the wrong environment or project | Refuses it, keeps polling | Nothing, plus one warning line |
| PromptOn unreachable **and** nothing cached anywhere | — | `NotReadyError`: "PromptOn is unreachable and nothing is cached" |
| Use case not in the use-case document | — | `UnknownUseCaseError` |
| Use case has no live deployment here | — | `UnresolvedError`. Fix the deployment; **never** fall back to a hard-coded prompt |
| Prompt name is not pinned | — | `UnknownPromptError`, carrying `promptNames`. There is no silent fallback to `default` |
| A variable the template reads is missing | — | `MissingVariableError`, carrying `variable` |
| Monitoring logs get `429` or any `5xx` | Retries the same batch with the same ids, honouring `Retry-After`, then backing off ×2 from 1 s to 5 min | Nothing |
| Monitoring logs get `413` | Splits the batch in half and resends both halves | Nothing |
| Monitoring logs get any other `4xx` | Drops the batch, counts it, logs once. Retrying a rejected batch only loses the ones behind it | Nothing |
| The log queue is full | Drops the oldest and counts it | Nothing |
| `log()` is handed a record with a field missing | Drops it, counts it in `droppedInvalid`, warns once | Nothing — unless `strictRecords` is on, which raises `InvalidRecordError` |
| The record builder throws inside `UseCase.track()` | Drops the record and counts it | Nothing; your own return value or your own exception, untouched |
| The prompt endpoint gets `429` or `5xx` | Serves the cached answer and stops calling until `Retry-After`, else backs off ×2 from the cache TTL to 5 min | Nothing, if that key was ever answered; otherwise the original `ApiError` |

Prove it before you ship: run your app with a wrong `PTN_HOST` and confirm that LLM calls still
happen on the cached use-case document.

## Use cases

```ts
const useCase = prompton.useCase("diary_use_case", { prompt: "ko" });
```

`params = use_case.default_params <- deployment.params` and
`providerOptions = model.provider_options <- deployment.provider_options`, both shallow merges where
the right side wins and an override of `null` is kept as `null`.

| Field | Meaning |
|---|---|
| `key`, `kind` | The key you asked for; `chat`, `text` or `embedding` |
| `prompt`, `promptNames` | The chosen prompt name (`null` for an embedding use case) and every name this revision pins |
| `deployment` | The pin that produced this |
| `promptVersion` | The pinned, immutable prompt version |
| `model`, `modelId`, `provider` | The provider model string to send, the catalog UUID, and who serves it |
| `params`, `providerOptions` | The effective merges above |
| `source`, `etag` | `remote` / `disk` / `bundle` / `manual`, and the use-case document's ETag |

Rendering is per call:

```ts
const messages = useCase.messages({ transcriptions, mode: "fresh" });
const korean = useCase.messages({ transcriptions, mode: "fresh" }, { prompt: "ko" });
const text = prompton.useCase("summarize").text({ items });
```

The template engine is the Liquid subset PromptOn allows: `{{ var }}` with `size`, `join` and
`default`; `for` with `break`, `continue` and `forloop.*`; `if`/`elsif`/`else`; `unless`; `assign`.
A key that is absent raises `MissingVariableError`; a key present with a `null` value renders as the
empty string.

### The simple path

`filledPrompt()` calls `POST /api/v1/use-cases/{key}/prompt`, which does the same thing on the server. It is the smoke
test and the low-traffic path — never a hot loop:

```ts
const filled = await prompton.filledPrompt("greeting", { variables: { name: "Ada" } });
```

It obeys the same rules: one request per cache TTL per (use case, prompt, environment) — one in
flight at a time, so a burst of concurrent calls costs a single request — rendered locally, and the
cached answer served when the server answers `429`, `5xx` or nothing at all. A failure also pauses
the key: the server is left alone until `Retry-After` has elapsed, or, absent that header and
`error.details.retry_after`, for an exponential backoff ×2 from the cache TTL capped at five
minutes. With nothing cached to serve, the calls inside that pause raise the original error without
touching the network.

## Monitoring logs

Three ways in.

```ts
prompton.log(record, { useCase });   // queue a record you built yourself, returns immediately
await prompton.flush();                 // send now and wait — shutdown, tests, scripts
await useCase.track(call, meta);         // time a provider call and log it
```

`log()` fills in `id` (a UUIDv7, because the server's column is one), `started_at`, `sdk`, and —
when you pass a use case — the deployment and prompt evidence. It validates the five fields the
server requires (`use_case`, `model`, `status`, `started_at`, plus the `id` it generated) and
returns at once; nothing is sent on the calling path.

**`log()` never throws.** A record the server would reject is dropped, counted in
`stats().droppedInvalid` and warned about once, because a monitoring log must never turn a
successful LLM call into a failed request. Set `strictRecords: true` to raise
`InvalidRecordError` instead — that is what you want in a test suite, not in production. The
wrapper below never raises from its logging half at all, `strictRecords` or not: an exception there
would replace the provider's own error, which is the one you need to see.

`UseCase.track(call, meta, extractResult?)` takes:

| `meta` field | Goes to |
|---|---|
| `variables` | `input.variables` |
| `inputMessages` / `inputText` | `input.messages` / `input.text` — the final prompt, after any history you attached |
| `endUserRef` | `end_user_ref` (hashed when `hashEndUser` is set). A pseudonymous id, never a name or an email |
| `traceId`, `sequence` | Ties the record to a job or a conversation |
| `context` | `context`, ≤ 2 KB encoded — free-form tags such as language or plan |
| `metadata` | `metadata`, ≤ 4 KB encoded — free app keys |
| `params` | Layered over use-case evidence's params, for what was actually sent |
| `id` | A UUIDv7 you pre-issued with `prompton.logId()` |

`extractResult` maps your provider's response onto `{ content, toolCalls, finishReason, usage:
{ inputTokens, outputTokens, raw }, costUsd, costSource, modelUsed, upstreamProvider, isByok }`. The
default treats the returned object as that shape already, and a returned string as the content.

### The record

| Field | Filled by |
|---|---|
| `id` | The SDK — a UUIDv7, and the idempotency key: a resend is counted as a duplicate, never stored twice |
| `use_case`, `kind`, `model`, `model_id`, `provider` | Use-case evidence |
| `deployment_id`, `deployment_revision`, `prompt`, `prompt_version_id` | Use-case evidence — this is the evidence that ties an answer to a pin |
| `source` | `remote` / `disk` / `bundle` / `manual` |
| `status`, `error` | `ok`, or `error` with `kind` (`http_4xx`, `http_5xx`, `rate_limited`, `timeout`, `transport`, `parse`, `app`), `status` and `message` |
| `finish_reason`, `stop_kind` | The provider's raw reason, normalised to `stop` / `length` / `tool_call` / `content_filter` / `other` |
| `input`, `output` | Your variables, messages and completion — subject to the payload policy below |
| `usage` | `input_tokens`, `output_tokens`, `cost_usd`, `cost_source`, `raw` |
| `latency_ms`, `started_at` | Measured by `UseCase.track()` |
| `trace_id`, `sequence`, `end_user_ref`, `context`, `metadata` | You |
| `sdk` | `{name: "prompton-nodejs", version}` |

**Payload policy.** Each use case carries one in the use-case document, and the SDK applies it *before* the
record is queued, so text that must not travel never does. `mode: "none"` drops `input`/`output`;
`mode: "hash"` replaces them with a sha256 and a byte count; `mode: "full"` truncates to
`max_bytes` (default 256 KB) — head and tail kept, middle replaced by `…[truncated N bytes]…`, never
splitting a multi-byte character. Sampling is a pure function of the record id, and errors and
`stop_kind: "length"` are always kept. Your `redact` hook runs last, after all of that.

**Don't log secrets.** No provider keys, no `PTN_API_KEY`, no user PII beyond `end_user_ref`, in
`input`, `output`, `context` or `metadata`.

## Test and offline modes

```ts
const prompton = new PromptOn({ mode: "test" });
prompton.loadUseCases(require("./fixtures/use-cases.json"));

const useCase = prompton.useCase("greeting");
await useCase.track(() => ({ content: "hi", finishReason: "stop" }));

expect(prompton.logs[0].stop_kind).toBe("stop");   // captured, never sent
```

`mode: "offline"` reads from the disk cache and the bundle and makes no HTTP call — for CI, for
local development, and for proving the fallback path works.

## Housekeeping

```ts
prompton.useCasesInfo();   // { etag, source, environment, project, fetchedAt, stale, ageSeconds }
prompton.stats();          // buffer counters: queued, sent, accepted, duplicates, dropped*
await prompton.refresh();  // fetch once, now
await prompton.close();    // stop the timers and flush what is queued
```

There is no global singleton: create an instance, hold it, and pass it around. Timers are `unref`'d,
so an instance never keeps a process alive.

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
npm test
node examples/basic.mjs
npm run check:install
```

`npm run check:install` installs the package into a scratch directory straight from this git
repository at `HEAD`, exactly as the Install section tells a consumer to, and imports it through
both entry points — so the documented install path is a gate rather than a claim. It needs the fix
you are testing to be committed.

`test/conformance/` is the cross-language conformance suite, copied verbatim from the reference
implementation ([prompton-elixir](https://github.com/polimo-dev/prompton-elixir)); every case in it
runs. The live integration test runs only when `PTN_API_KEY` is set:

```sh
PTN_HOST=http://localhost:4000 PTN_API_KEY=ptn_sdkfixture_… npm test
```

## Licence

Apache-2.0 © 2026 Polimo.
