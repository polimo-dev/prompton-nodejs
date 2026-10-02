import { afterEach, describe, expect, it, vi } from "vitest";

import { InvalidRecordError, PromptOn, type TraceEvent } from "../src/index.js";
import { fakeFetch, recordingLogger, snapshotDocument } from "./helpers.js";

const closed = "%Req.TransportError{reason: :closed}";
const sendFailure = `failed to send request: ${closed}`;
const completionFailure = `failed to call LLM: ${sendFailure}`;
const clients: PromptOn[] = [];

function make(options: ConstructorParameters<typeof PromptOn>[0] = {}): PromptOn {
  const client = new PromptOn({
    mode: "test", diskCache: false, flushOnExit: false, logger: recordingLogger(), ...options,
  });
  clients.push(client);
  client.loadPrompts(snapshotDocument());
  return client;
}

function record(message: unknown = sendFailure, kind = "transport", status = "error") {
  return { prompt_key: "greeting", model: "openai/gpt-4o-mini", status, error: { kind, message } };
}

function event(id: string, output: unknown = completionFailure): TraceEvent {
  return { event_id: id, trace_id: "trace", event_kind: "completion", status: "error", completion_output: output };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close(200)));
});

describe("closed transport monitoring filter", () => {
  it("keeps the exact thrown error for retries and captures the subsequent success", async () => {
    const client = make();
    const prompt = await client.prompt("greeting");
    const failure = Object.assign(new Error(sendFailure), { kind: "transport" });
    await expect(prompt.track(() => { throw failure; })).rejects.toBe(failure);
    expect(client.logs).toEqual([]);
    const success = { content: "retried" };
    await expect(prompt.track(() => success)).resolves.toBe(success);
    expect(client.logs).toHaveLength(1);
    expect(client.logs[0]).toMatchObject({ status: "ok", output: { content: "retried" } });
  });

  it("suppresses only the two exact transport messages before redaction", () => {
    const redact = vi.fn((value) => value);
    const client = make({ redact });
    for (const message of [closed, sendFailure]) client.log(record(message));
    expect(client.logs).toEqual([]);
    expect(redact).not.toHaveBeenCalled();
    expect(client.stats().droppedInvalid).toBe(0);
  });

  it("keeps other error kinds, transport failures, successful logs and non-string messages", () => {
    const client = make();
    const records = [
      record("failed to send request: %Req.TransportError{reason: :timeout}"),
      record("failed to send request: %Req.TransportError{reason: :econnrefused}"),
      record("socket closed"), record(`${sendFailure} followed by another error`),
      record(sendFailure, "app"), record(sendFailure, "parse"),
      record(sendFailure, "http_5xx"), record(sendFailure, "transport", "ok"),
      record({ message: sendFailure }),
    ];
    records.forEach((value) => client.log(value));
    expect(client.logs).toHaveLength(records.length);
  });

  it("keeps existing strict record and event validation", async () => {
    const client = make({ strictRecords: true });
    expect(() => client.log({ status: "error", error: { kind: "transport", message: closed } }))
      .toThrow(InvalidRecordError);
    await expect(client.logEvents([event("closed"), null as unknown as TraceEvent]))
      .rejects.toThrow(InvalidRecordError);
    await expect(client.logEvents(Array.from({ length: 501 }, () => event("closed"))))
      .rejects.toThrow(InvalidRecordError);
  });

  it("does not enqueue or send closed failures, but sends the next ordinary log", async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ accepted: 1 }), { status: 202 }));
    const client = make({ mode: "live", apiKey: "ptn_sdkfixture_key", fetch });
    client.log(record());
    await client.flush();
    expect(fetch.calls).toHaveLength(0);
    client.log(record("timeout"));
    await client.flush();
    expect(fetch.calls).toHaveLength(1);
    expect(JSON.parse(fetch.calls[0]?.init?.body as string)).toMatchObject({ logs: [record("timeout")] });
  });

  it("returns a zero-accepted result without HTTP for entirely filtered events", async () => {
    const fetch = fakeFetch(() => { throw new Error("must not send"); });
    for (const mode of ["test", "live"] as const) {
      const client = make({ mode, apiKey: "ptn_sdkfixture_key", fetch });
      await expect(client.logEvents([event("one", closed), event("two", sendFailure), event("three")]))
        .resolves.toEqual({ accepted: 0, duplicates: 0, rejected: [] });
      expect(client.events).toEqual([]);
    }
    expect(fetch.calls).toHaveLength(0);
  });

  it("keeps mixed event IDs, order and acknowledgement without mutating callers", async () => {
    const records = [
      { ...event("ok"), status: "ok" }, event("closed"), event("timeout", "timeout"),
      { ...event("tool"), event_kind: "tool_attempt" },
      event("object", { message: completionFailure }),
      event("suffix", `${completionFailure} followed by another error`),
    ];
    const before = structuredClone(records);
    const client = make();
    await expect(client.logEvents(records)).resolves.toEqual({ accepted: 5, duplicates: 0, rejected: [] });
    expect(client.events.map((value) => value["event_id"])).toEqual(["ok", "timeout", "tool", "object", "suffix"]);
    expect(records).toEqual(before);

    const fetch = fakeFetch((_url, init) => {
      const body = JSON.parse(init?.body as string) as { events: TraceEvent[] };
      expect(body.events.map((value) => value["event_id"])).toEqual(["ok", "timeout", "tool", "object", "suffix"]);
      return new Response(JSON.stringify({ events: { accepted: 4, duplicates: 1, rejected: [] } }), { status: 202 });
    });
    const live = make({ mode: "live", apiKey: "ptn_sdkfixture_key", fetch });
    await expect(live.logEvents(records)).resolves.toEqual({ accepted: 4, duplicates: 1, rejected: [] });
    expect(fetch.calls).toHaveLength(1);
  });
});
