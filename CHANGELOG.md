# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0

### Added

- `Prompt.request(variables, options?)` prepares provider calls without sending them. It returns
  `{ api, method: "POST", path, body }` from the deployed prompt metadata, including Chat
  Completions and OpenRouter Decisions requests.
- Prompt document schema v6 support, with deployment `api` / `request_path` and prompt-version
  `kind` / `decision` fields. Schema v5 bundles remain readable, but cannot prepare provider
  requests because they do not contain request metadata.
- `Result.fromDecisions()` maps OpenRouter Decisions responses into monitoring-log result fields
  while preserving structured answers and usage.

### Changed

- `Prompt.kind` follows the pinned prompt version when available, so existing deployed chat pins
  keep serving as chat after authoring type changes.

## 0.2.0

### Changed

- Breaking rename to the final PromptOn runtime vocabulary: `prompt()` returns a `Prompt` with
  `.messages()`, `.text()` and `.track()` helpers, and `Result.fromOpenAI()` /
  `Result.fromAnthropic()` extract provider outputs.
- Runtime HTTP paths now use `GET /api/v1/prompts`, `POST /api/v1/prompts/{key}/render`, and
  `POST /api/v1/logs` with the `{"logs": [...]}` envelope.
- Public record/document fields now use `params`, `providerOptions`, `source`, schema version 5,
  and the default bundle filename `prompts.production.json`.
- Conformance fixtures were renamed from `resolve.json` / `LLM call_record.json` to
  `prompt.json` / `log_record.json`.

### Fixed

- `renderPrompt()` now honours the rate-limit rule. A `429`, a `5xx` or an unreachable server
  pauses that `(prompt, template, environment)` key until `Retry-After` — falling back to
  `error.details.retry_after`, then to an exponential backoff ×2 from the cache TTL capped at five
  minutes — instead of re-issuing the render endpoint on every single call. The cached answer keeps
  being served throughout; with nothing cached, the calls inside the pause raise the original error
  without touching the network. Concurrent calls for one key now share a single in-flight request.
- `log()` never throws. A record the server would reject is dropped, counted in the new
  `stats().droppedInvalid` and warned about once, rather than turning a successful LLM call into
  a failed request; `Prompt.track()`'s logging half does the same, so it can never replace the
  provider's own error with one of its own.
- A git install now yields an importable package: `dist/` is not committed, and the package had no
  `prepare` script to build it. `npm run check:install` is a new gate that installs from the
  repository and imports both entry points.
- One shared `beforeExit` listener for every client, instead of one per instance, which tripped
  Node's `MaxListenersExceededWarning` past ten clients.
- The API-key fixture in `test/config.test.ts` is synthetic; the previous one shared its random
  suffix with a live key.

### Added

- `strictRecords` option: make `log()` raise `InvalidRecordError` instead of dropping a bad record.
  Off by default, for tests.
- `ApiError.retryAfterMs`: what the response's `Retry-After` (or `error.details.retry_after`) said,
  in milliseconds, or `null`.
- `BufferStats.droppedInvalid`.

## 0.1.0 — 2026-09-04

Initial release: the official PromptOn SDK for Node.js and TypeScript.

### Added

- `PromptOn` client with synchronous, in-memory resolution and no runtime dependencies.
- Snapshot store with the three tiers — memory, an atomically written disk cache with an ETag
  sidecar, and a bundled file — plus a 10-second cache, `If-None-Match` polling,
  stale-while-revalidate refresh, `Retry-After` handling on `429`, exponential backoff on `5xx` and
  transport failures, and environment and project guards. No external store is ever required.
- Local resolver for prompt document schema v3: `unknown_template_key`, `unresolved` and `unknown_template`
  errors, shallow parameter merges, and no silent fallback to the `default` prompt.
- Template engine for the Liquid subset PromptOn allows, plus `lint()` and `templateVariables()`.
- Monitoring-log buffer: app-generated UUIDv7 ids, size/time/byte flush triggers, batches of at most
  200 records and 4 MB, partial-acceptance handling, retry of the same batch on `429` and `5xx`,
  `413` splitting, drop-on-other-`4xx`, a bounded queue that drops the oldest, and a flush on exit.
- Payload policy applied before enqueue: sampling, `none`/`hash`/`full` modes, UTF-8-safe
  truncation, the `error.message` cap, `end_user_ref` hashing and a redaction hook.
- Tracking wrapper, `log()`, `flush()`, `renderPrompt()` (`POST /api/v1/prompts/{key}/render` with the same
  caching rules), `exportPrompts()`, `promptsInfo()` and `stats()`.
- Test mode (no HTTP, records captured) and offline mode (disk and bundle only).
- The cross-language conformance suite, executed case by case, and an env-gated live integration
  test.
