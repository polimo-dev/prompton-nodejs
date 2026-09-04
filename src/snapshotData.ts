import type { Engine, Message } from "./template.js";

/**
 * Decoding of the `GET /snapshot` body. Schema v3 only.
 *
 * A version above 3 decodes with a warning and only the fields this SDK knows (the contract
 * promises additive changes); versions 1 and 2 are refused outright, because a deployment revision
 * used to be a router there rather than a pin.
 */

/** How much of a generation's raw text the app may send. */
export interface PayloadPolicy {
  mode: "full" | "hash" | "none";
  sampleRate: number;
  maxBytes: number;
  retentionDays: number | null;
  encrypt: boolean;
}

/** One input variable a use case declares. */
export interface InputVariable {
  name: string | null;
  type: string;
  required: boolean;
  description: string | null;
  example: unknown;
}

/** A deployment revision: one model, one pinned prompt version per prompt name. */
export interface SnapshotDeployment {
  id: string | null;
  useCaseKey: string;
  revision: number | null;
  modelId: string | null;
  params: Record<string, unknown>;
  providerOptions: Record<string, unknown>;
  promptPins: Record<string, string>;
}

/** A use case plus the deployment pinned for it in this environment. */
export interface SnapshotUseCase {
  id: string | null;
  key: string;
  kind: "chat" | "text" | "embedding" | (string & {});
  inputSchema: InputVariable[];
  defaultParams: Record<string, unknown>;
  payloadPolicy: PayloadPolicy | null;
  deployment: SnapshotDeployment | null;
}

/** An immutable prompt version. */
export interface SnapshotPromptVersion {
  id: string;
  promptId: string | null;
  number: number | null;
  engine: Engine;
  messages: Message[] | null;
  textTemplate: string | null;
}

/** A catalog model. */
export interface SnapshotModel {
  id: string;
  provider: string | null;
  modelId: string | null;
  displayName: string | null;
  metadata: Record<string, unknown>;
  providerOptions: Record<string, unknown>;
  capabilities: string[];
  pricing: unknown;
  contextLength: number | null;
  status: string | null;
}

/** A decoded snapshot document. */
export interface SnapshotData {
  schemaVersion: number;
  project: string | null;
  environment: string | null;
  useCases: Record<string, SnapshotUseCase>;
  deployments: Record<string, SnapshotDeployment>;
  promptVersions: Record<string, SnapshotPromptVersion>;
  models: Record<string, SnapshotModel>;
}

/** Something the decoder tolerated but wants recorded. */
export interface DecodeWarning {
  kind: string;
  detail: unknown;
}

/** The result of decoding a snapshot document. */
export interface DecodeResult {
  data: SnapshotData;
  warnings: DecodeWarning[];
}

/** The snapshot schema version this SDK reads. */
export const SCHEMA_VERSION = 3;

const KINDS = new Set(["chat", "text", "embedding"]);
const ENGINES = new Set(["liquid", "raw"]);
const PAYLOAD_MODES = new Set(["full", "hash", "none"]);
const VARIABLE_TYPES = new Set(["string", "number", "boolean", "list", "map"]);

/** Decodes a snapshot JSON string. Throws on a body this SDK cannot read. */
export function decodeSnapshotJson(json: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`snapshot is not valid JSON: ${(error as Error).message}`);
  }
  return decodeSnapshot(parsed);
}

/** Decodes an already-parsed snapshot document. Throws on a body this SDK cannot read. */
export function decodeSnapshot(input: unknown): DecodeResult {
  if (!isRecord(input)) throw new Error("snapshot must be an object");
  const warnings: DecodeWarning[] = [];

  const rawVersion = input["schema_version"] ?? input["version"];
  let schemaVersion = SCHEMA_VERSION;
  if (typeof rawVersion === "number" && Number.isInteger(rawVersion)) {
    if (rawVersion > SCHEMA_VERSION) {
      warnings.push({ kind: "unknown_schema_version", detail: rawVersion });
      schemaVersion = rawVersion;
    } else if (rawVersion < SCHEMA_VERSION) {
      throw new Error(
        `unsupported snapshot schema_version ${String(rawVersion)}; this SDK reads version ${String(SCHEMA_VERSION)}`,
      );
    }
  } else if (rawVersion !== undefined && rawVersion !== null) {
    throw new Error("snapshot schema_version must be a positive integer");
  } else if (!isRecord(input["deployments"])) {
    throw new Error("snapshot schema_version is required");
  }

  if (!isRecord(input["use_cases"])) throw new Error("snapshot use_cases is required");

  const deployments = decodeDeployments(input["deployments"], warnings);
  const useCases = decodeUseCases(input["use_cases"], deployments, warnings);

  return {
    data: {
      schemaVersion,
      project: asString(input["project"]),
      environment: asString(input["environment"]),
      useCases,
      deployments,
      promptVersions: decodeById(input["prompt_versions"], decodePromptVersion, warnings),
      models: decodeById(input["models"], decodeModel, warnings),
    },
    warnings,
  };
}

function decodeUseCases(
  raw: Record<string, unknown>,
  deployments: Record<string, SnapshotDeployment>,
  warnings: DecodeWarning[],
): Record<string, SnapshotUseCase> {
  const useCases: Record<string, SnapshotUseCase> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push({ kind: "invalid_use_case", detail: key });
      continue;
    }
    const kind = asString(value["kind"]) ?? "chat";
    if (!KINDS.has(kind)) warnings.push({ kind: "unknown_kind", detail: kind });
    useCases[key] = {
      id: asString(value["id"]),
      key,
      kind,
      inputSchema: decodeInputSchema(value["input_schema"], warnings),
      defaultParams: asRecord(value["default_params"]),
      payloadPolicy: decodePayloadPolicy(value["payload_policy"], warnings),
      deployment: deployments[key] ?? null,
    };
  }
  return useCases;
}

function decodeInputSchema(raw: unknown, warnings: DecodeWarning[]): InputVariable[] {
  if (!Array.isArray(raw)) return [];
  const variables: InputVariable[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      warnings.push({ kind: "invalid_variable", detail: entry });
      continue;
    }
    const type = asString(entry["type"]) ?? "string";
    if (!VARIABLE_TYPES.has(type)) warnings.push({ kind: "unknown_variable_type", detail: type });
    variables.push({
      name: asString(entry["name"]),
      type,
      required: entry["required"] === true,
      description: asString(entry["description"]),
      example: entry["example"] ?? null,
    });
  }
  return variables;
}

function decodePayloadPolicy(raw: unknown, warnings: DecodeWarning[]): PayloadPolicy | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) {
    warnings.push({ kind: "invalid_payload_policy", detail: raw });
    return null;
  }
  const mode = asString(raw["mode"]) ?? "full";
  if (!PAYLOAD_MODES.has(mode)) warnings.push({ kind: "unknown_payload_mode", detail: mode });
  return {
    mode: (PAYLOAD_MODES.has(mode) ? mode : "full") as PayloadPolicy["mode"],
    sampleRate: typeof raw["sample_rate"] === "number" ? raw["sample_rate"] : 1.0,
    maxBytes: asInteger(raw["max_bytes"]) ?? 262144,
    retentionDays: asInteger(raw["retention_days"]),
    encrypt: raw["encrypt"] === true,
  };
}

function decodeDeployments(
  raw: unknown,
  warnings: DecodeWarning[],
): Record<string, SnapshotDeployment> {
  const deployments: Record<string, SnapshotDeployment> = {};
  if (raw === null || raw === undefined) return deployments;
  if (!isRecord(raw)) {
    warnings.push({ kind: "invalid_deployments", detail: raw });
    return deployments;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push({ kind: "invalid_deployment", detail: key });
      continue;
    }
    const pins: Record<string, string> = {};
    const rawPins = value["prompt_pins"];
    if (isRecord(rawPins)) {
      for (const [name, versionId] of Object.entries(rawPins)) {
        const id = asString(versionId);
        if (id === null) {
          warnings.push({ kind: "invalid_prompt_pin", detail: `${key}.${name}` });
          continue;
        }
        pins[name] = id;
      }
    } else if (rawPins !== null && rawPins !== undefined) {
      warnings.push({ kind: "invalid_prompt_pins", detail: key });
    }
    deployments[key] = {
      id: asString(value["id"]),
      useCaseKey: asString(value["use_case_key"]) ?? key,
      revision: asInteger(value["revision"]),
      modelId: asString(value["model_id"]),
      params: asRecord(value["params"]),
      providerOptions: asRecord(value["provider_options"]),
      promptPins: pins,
    };
  }
  return deployments;
}

function decodeById<T extends { id: string }>(
  raw: unknown,
  decode: (entry: Record<string, unknown>, fallbackId: string) => T,
  warnings: DecodeWarning[],
): Record<string, T> {
  const out: Record<string, T> = {};
  if (raw === null || raw === undefined) return out;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) {
        warnings.push({ kind: "invalid_entry", detail: entry });
        continue;
      }
      const decoded = decode(entry, asString(entry["id"]) ?? "");
      out[decoded.id] = decoded;
    }
    return out;
  }
  if (!isRecord(raw)) {
    warnings.push({ kind: "invalid_collection", detail: raw });
    return out;
  }
  for (const [id, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) {
      warnings.push({ kind: "invalid_entry", detail: id });
      continue;
    }
    const decoded = decode(entry, id);
    out[decoded.id] = decoded;
  }
  return out;
}

function decodePromptVersion(
  raw: Record<string, unknown>,
  fallbackId: string,
): SnapshotPromptVersion {
  const engine = asString(raw["engine"]) ?? "liquid";
  return {
    id: asString(raw["id"]) ?? fallbackId,
    promptId: asString(raw["prompt_id"]),
    number: asInteger(raw["number"]),
    engine: (ENGINES.has(engine) ? engine : "liquid") as Engine,
    messages: decodeMessages(raw["messages"]),
    textTemplate: asString(raw["text_template"]),
  };
}

function decodeMessages(raw: unknown): Message[] | null {
  if (!Array.isArray(raw)) return null;
  const messages: Message[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const message: Message = {
      role: asString(entry["role"]) ?? "",
      content: asString(entry["content"]) ?? "",
    };
    const name = asString(entry["name"]);
    if (name !== null) message["name"] = name;
    messages.push(message);
  }
  return messages;
}

function decodeModel(raw: Record<string, unknown>, fallbackId: string): SnapshotModel {
  const capabilities = Array.isArray(raw["capabilities"])
    ? raw["capabilities"].map((value) => asString(value)).filter((value): value is string => value !== null)
    : [];
  return {
    id: asString(raw["id"]) ?? fallbackId,
    provider: asString(raw["provider"]),
    modelId: asString(raw["model_id"]),
    displayName: asString(raw["display_name"]),
    metadata: asRecord(raw["metadata"]),
    providerOptions: asRecord(raw["provider_options"]),
    capabilities,
    pricing: raw["pricing"] ?? null,
    contextLength: asInteger(raw["context_length"]),
    status: asString(raw["status"]),
  };
}

// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}
