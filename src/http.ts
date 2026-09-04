import type { ResolvedConfig } from "./config.js";

/** What a PromptOn HTTP call came back with. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

/** A transport-level failure: DNS, connection refused, TLS, or a timeout. */
export class TransportError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "TransportError";
    this.cause = cause;
  }
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

/** One HTTP call to PromptOn. Throws {@link TransportError}; any status is returned as data. */
export async function request(
  config: ResolvedConfig,
  options: RequestOptions,
): Promise<HttpResponse> {
  const url = new URL(config.baseUrl + options.path);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": config.userAgent,
    ...options.headers,
  };
  if (config.apiKey) headers["authorization"] = `Bearer ${config.apiKey}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await config.fetch(url.toString(), {
      method: options.method,
      headers,
      body: options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new TransportError(describe(error), error);
  }

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    throw new TransportError(`could not read the response body: ${describe(error)}`, error);
  }

  const collected: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    collected[key.toLowerCase()] = value;
  });

  return { status: response.status, headers: collected, text };
}

/** Parses a JSON body, returning `null` when it is empty or malformed. */
export function parseJson(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `Retry-After` in milliseconds: a number of seconds, or an HTTP date. Falls back to
 * `error.details.retry_after` from the body, which PromptOn sends on `503`.
 */
export function retryAfterMs(response: HttpResponse, now: number = Date.now()): number | null {
  const header = response.headers["retry-after"];
  if (header) {
    const trimmed = header.trim();
    if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000;
    const date = Date.parse(trimmed);
    if (!Number.isNaN(date)) return Math.max(date - now, 0);
  }
  const body = parseJson(response.text);
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const details = (error as Record<string, unknown>)["details"];
      if (details && typeof details === "object") {
        const value = (details as Record<string, unknown>)["retry_after"];
        if (typeof value === "number" && Number.isFinite(value)) return value * 1000;
      }
    }
  }
  return null;
}

/** The `error.message` of a PromptOn error body, or a generic description. */
export function errorMessage(response: HttpResponse): string {
  const body = parseJson(response.text);
  if (body && typeof body === "object") {
    const error = (body as Record<string, unknown>)["error"];
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return message;
    }
  }
  return `HTTP ${String(response.status)}`;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "request timed out";
    return error.message;
  }
  return String(error);
}
