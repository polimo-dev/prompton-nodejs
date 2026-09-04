import { createHash } from "node:crypto";

/** UTF-8 byte length of a string. Every cap in the payload policy is measured in bytes. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Canonical JSON: object keys sorted by their UTF-8 bytes, no whitespace.
 *
 * Every byte count and every sha256 digest in the payload policy is taken over this encoding, so
 * that an SDK in another language reaches the same numbers for the same value.
 */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  encode(value, out);
  return out.join("");
}

/** Byte size of a value's canonical JSON encoding. */
export function jsonSize(value: unknown): number {
  return byteLength(canonicalJson(value));
}

/** Lowercase hex sha256 of a string, taken over its UTF-8 bytes. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** The first four bytes of sha256(value) as an unsigned big-endian 32-bit integer. */
export function sha256Prefix32(value: string): number {
  return createHash("sha256").update(value, "utf8").digest().readUInt32BE(0);
}

function encode(value: unknown, out: string[]): void {
  if (value === null || value === undefined) {
    out.push("null");
    return;
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "number":
      out.push(Number.isFinite(value) ? JSON.stringify(value) : "null");
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "bigint":
      out.push(value.toString());
      return;
    default:
      break;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(",");
      encode(value[i], out);
    }
    out.push("]");
    return;
  }
  if (value instanceof Date) {
    out.push(JSON.stringify(value.toISOString()));
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareUtf8);
  out.push("{");
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] as string;
    if (i > 0) out.push(",");
    out.push(JSON.stringify(key), ":");
    encode(record[key], out);
  }
  out.push("}");
}

/**
 * Byte-wise string comparison. JavaScript's default sort compares UTF-16 code units, which orders
 * astral-plane keys differently from a byte comparison; other SDKs sort bytes.
 */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * A string for any value, without JavaScript's `[object Object]`: objects and arrays become their
 * canonical JSON.
 */
export function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return value.message;
  return canonicalJson(value);
}
