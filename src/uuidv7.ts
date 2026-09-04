import { randomFillSync } from "node:crypto";

/**
 * RFC 9562 UUIDv7, with no dependency.
 *
 * A monitoring-log id is an idempotency key the app issues before the provider call, so it has to
 * be generated locally, and the server's column is a UUIDv7 type: a v4 id is accepted by request
 * validation and then fails on write. Layout: 48-bit unix milliseconds | version 7 | 12 random
 * bits | variant 10 | 62 random bits. Lowercase hex with dashes.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);

  const ms = Math.max(0, Math.floor(now));
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The unix milliseconds encoded in a UUIDv7, or `null` when the string is not one. */
export function uuidv7Timestamp(value: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return null;
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}

/** Whether a string is a UUID in the canonical dashed form. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
