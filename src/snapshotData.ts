import type { Engine, Message } from "./template.js";

/**
 * Decoding of the `GET /prompts` body. Schema v6 adds prepared request metadata while schema v5
 * remains readable for existing bundles and disk caches.
 */

/** How much of a generation's raw text the app may send. */
export interface PayloadPolicy {
  mode: "full" | "hash" | "none";
  sampleRate: number;
  maxBytes: number;
  retentionDays: number | null;
  encrypt: boolean;
}

/** One input variable a prompt declares. */
export interface InputVariable {
  name: string | null;
  type: string;
  required: boolean;
  description: string | null;
  example: unknown;
}

/** A deployment revision: one model, one pinned prompt version per prompt name. */
export interface PromptDeployment {
  id: string | null;
  promptKey: string;
  revision: number | null;
  modelId: string | null;
  api: "chat_completions" | "decisions" | (string & {}) | null;
  requestPath: string | null;
  params: Record<string, unknown>;
  providerOptions: Record<string, unknown>;
  templatePins: Record<string, string>;
}

/** A prompt plus the deployment pinned for it in this environment. */
export interface PromptDefinition {
  id: string | null;
  key: string;
  kind: "chat" | "decision" | "text" | "embedding" | (string & {});
  inputSchema: InputVariable[];
  defaultParams: Record<string, unknown>;
  payloadPolicy: PayloadPolicy | null;
  deployment: PromptDeployment | null;
}

/** An immutable prompt version. */
export interface PromptVersion {
  id: string;
  promptTemplateId: string | null;
  number: number | null;
  kind: "chat" | "decision" | "text" | "embedding" | (string & {}) | null;
  engine: Engine;
  messages: Message[] | null;
  textTemplate: string | null;
  decision: DecisionTemplate | null;
}

export interface DecisionTemplate {
  state: unknown;
  questions: Record<string, unknown>;
}

/** A catalog model. */
export interface PromptModel {
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

/** A decoded prompt document. */
export interface PromptDocument {
  schemaVersion: number;
  project: string | null;
  environment: string | null;
  prompts: Record<string, PromptDefinition>;
  deployments: Record<string, PromptDeployment>;
  promptVersions: Record<string, PromptVersion>;
  models: Record<string, PromptModel>;
}

/** Something the decoder tolerated but wants recorded. */
export interface DecodeWarning {
  kind: string;
  detail: unknown;
}

/** The result of decoding a prompt document. */
export interface DecodeResult {
  data: PromptDocument;
  warnings: DecodeWarning[];
}

/** The current prompt document schema version emitted by PromptOn. Schema v5 is still accepted. */
export const SCHEMA_VERSION = 6;

const SUPPORTED_SCHEMA_VERSIONS = new Set([5, 6]);
const KINDS = new Set(["chat", "decision", "text", "embedding"]);
const ENGINES = new Set(["liquid", "raw"]);
const PAYLOAD_MODES = new Set(["full", "hash", "none"]);
const VARIABLE_TYPES = new Set(["string", "number", "boolean", "list", "map"]);

/** Decodes a prompt document JSON string. Throws on a body this SDK cannot read. */
export function decodePromptDocumentJson(json: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`prompt document is not valid JSON: ${(error as Error).message}`);
  }
  return decodePromptDocument(parsed);
}

/** Decodes an already-parsed prompt document. Throws on a body this SDK cannot read. */
export function decodePromptDocument(input: unknown): DecodeResult {
  if (!isRecord(input)) throw new Error("prompt document must be an object");
  const warnings: DecodeWarning[] = [];

  const rawVersion = input["schema_version"];
  if (typeof rawVersion === "number" && Number.isInteger(rawVersion)) {
    if (!SUPPORTED_SCHEMA_VERSIONS.has(rawVersion)) {
      throw new Error(
        `unsupported prompt document schema_version ${String(rawVersion)}; this SDK reads versions 5 and ${String(SCHEMA_VERSION)}`,
      );
    }
  } else if (rawVersion !== undefined && rawVersion !== null) {
    throw new Error(`prompt document schema_version must be integer ${String(SCHEMA_VERSION)}`);
  } else {
    throw new Error("prompt document schema_version is required");
  }

  if (!isRecord(input["prompts"])) throw new Error("prompt document prompts is required");

  const deployments = decodeDeployments(input["deployments"], rawVersion, warnings);
  const prompts = decodePrompts(input["prompts"], deployments, warnings);

  return {
    data: {
      schemaVersion: rawVersion,
      project: asString(input["project"]),
      environment: asString(input["environment"]),
      prompts,
      deployments,
      promptVersions: decodeById(
        input["prompt_versions"],
        (entry, fallbackId) => decodePromptVersion(entry, fallbackId, rawVersion),
        warnings,
      ),
      models: decodeById(input["models"], decodeModel, warnings),
    },
    warnings,
  };
}

function decodePrompts(
  raw: Record<string, unknown>,
  deployments: Record<string, PromptDeployment>,
  warnings: DecodeWarning[],
): Record<string, PromptDefinition> {
  const prompts: Record<string, PromptDefinition> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) {
      warnings.push({ kind: "invalid_prompt_key", detail: key });
      continue;
    }
    const kind = asString(value["kind"]) ?? "chat";
    if (!KINDS.has(kind)) warnings.push({ kind: "unknown_kind", detail: kind });
    prompts[key] = {
      id: asString(value["id"]),
      key,
      kind,
      inputSchema: decodeInputSchema(value["input_schema"], warnings),
      defaultParams: asRecord(value["default_params"]),
      payloadPolicy: decodePayloadPolicy(value["payload_policy"], warnings),
      deployment: deployments[key] ?? null,
    };
  }
  return prompts;
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
  schemaVersion: number,
  warnings: DecodeWarning[],
): Record<string, PromptDeployment> {
  const deployments: Record<string, PromptDeployment> = {};
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
    const rawPins = value["template_pins"];
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
      warnings.push({ kind: "invalid_template_pins", detail: key });
    }
    deployments[key] = {
      id: asString(value["id"]),
      promptKey: asString(value["prompt_key"]) ?? key,
      revision: asInteger(value["revision"]),
      modelId: asString(value["model_id"]),
      api: schemaVersion >= 6 ? asString(value["api"]) : null,
      requestPath: schemaVersion >= 6 ? asString(value["request_path"]) : null,
      params: asRecord(value["params"]),
      providerOptions: asRecord(value["provider_options"]),
      templatePins: pins,
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
  schemaVersion: number,
): PromptVersion {
  const engine = asString(raw["engine"]) ?? "liquid";
  const kind = schemaVersion >= 6 ? asString(raw["kind"]) : null;
  return {
    id: asString(raw["id"]) ?? fallbackId,
    promptTemplateId: asString(raw["prompt_template_id"]),
    number: asInteger(raw["number"]),
    kind,
    engine: (ENGINES.has(engine) ? engine : "liquid") as Engine,
    messages: decodeMessages(raw["messages"]),
    textTemplate: asString(raw["text_template"]),
    decision: schemaVersion >= 6 ? decodeDecision(raw["decision"]) : null,
  };
}

function decodeDecision(raw: unknown): DecisionTemplate | null {
  if (!isRecord(raw)) return null;
  const questions = raw["questions"];
  if (!isRecord(questions)) return null;
  return {
    state: raw["state"] ?? null,
    questions: { ...questions },
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

function decodeModel(raw: Record<string, unknown>, fallbackId: string): PromptModel {
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
