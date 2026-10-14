import type { Engine, Message } from "./template.js";

/**
 * Decoding of schema v1 prompt detail and cached aggregate prompt documents.
 * Lightweight prompt indexes are discovery-only and are rejected here.
 */

/** How much of a generation's raw text the app may send. */
export interface PayloadPolicy {
  mode: "full" | "hash" | "none";
  sampleRate: number;
  maxBytes: number;
  retentionDays: number | null;
  encrypt: boolean;
}

/** One variable a prompt declares. */
export interface VariableDefinition {
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
  revision: string | null;
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
  variables: VariableDefinition[];
  defaultParams: Record<string, unknown>;
  payloadPolicy: PayloadPolicy | null;
  deployment: PromptDeployment | null;
}

/** An immutable prompt version. */
export interface PromptVersion {
  id: string | null;
  lookupKey?: string;
  promptTemplateId: string | null;
  number: number | null;
  kind: "chat" | "decision" | "text" | "embedding" | (string & {}) | null;
  engine: Engine;
  messages: Message[] | null;
  textTemplate: string | null;
  decision: DecisionTemplate | null;
  tools: ToolDefinitions | null;
}

export interface ToolDefinitions {
  definitions: Record<string, unknown>[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
}

export interface DecisionTemplate {
  state: unknown;
  questions: Record<string, unknown>;
}

/** A catalog model. */
export interface PromptModel {
  id: string | null;
  lookupKey?: string;
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

/** The current prompt document schema version emitted by PromptOn. */
export const SCHEMA_VERSION = 1;
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
  if (rawVersion !== SCHEMA_VERSION) {
    if (typeof rawVersion === "number" && Number.isInteger(rawVersion)) {
      throw new Error(`unsupported prompt document schema_version ${String(rawVersion)}; this SDK reads schema_version 1`);
    }
    if (rawVersion !== undefined && rawVersion !== null) {
      throw new Error(`prompt document schema_version must be integer ${String(SCHEMA_VERSION)}`);
    }
    throw new Error("prompt document schema_version is required");
  }

  const normalized = normalizePromptDocument(input);

  if (!isRecord(normalized["prompts"])) throw new Error("prompt document prompts is required");

  const deployments = decodeDeployments(normalized["deployments"], warnings);
  const prompts = decodePrompts(normalized["prompts"], deployments, warnings);

  return {
    data: {
      schemaVersion: SCHEMA_VERSION,
      project: asString(normalized["project"]),
      environment: asString(normalized["environment"]),
      prompts,
      deployments,
      promptVersions: decodeById(
        normalized["prompt_versions"],
        (entry, fallbackId) => decodePromptVersion(entry, fallbackId, warnings),
        warnings,
      ),
      models: decodeById(
        normalized["models"],
        (entry, fallbackId) => decodeModel(entry, fallbackId, warnings),
        warnings,
      ),
    },
    warnings,
  };
}

function normalizePromptDocument(input: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(input["prompts"])) {
    throw new Error("prompt index responses are discovery only and cannot be loaded as configuration");
  }
  const hasSingle = input["prompt"] !== undefined || input["deployment"] !== undefined || input["prompt_version"] !== undefined || input["model"] !== undefined;
  if (!hasSingle) return input;

  for (const plural of ["prompts", "deployments", "prompt_versions", "models"]) {
    if (Object.hasOwn(input, plural)) {
      throw new Error(`schema_version 1 prompt detail must use singular resources; found ${plural}`);
    }
  }
  const prompt = input["prompt"];
  const deployment = input["deployment"];
  const version = input["prompt_version"];
  const model = input["model"];
  if (!isRecord(prompt)) throw new Error("schema v1 prompt document prompt is required");
  if (!isRecord(deployment)) throw new Error("schema v1 prompt document deployment is required");
  if (!isRecord(version)) throw new Error("schema v1 prompt document prompt_version is required");
  if (!isRecord(model)) throw new Error("schema v1 prompt document model is required");

  const key = strictString(prompt["key"]);
  if (key === null || key.trim() === "") throw new Error("schema v1 prompt.key is required");
  const versionPrompt = strictString(version["prompt"]);
  if (versionPrompt !== key) throw new Error("schema v1 prompt_version.prompt must match prompt.key");
  const number = strictPositiveInteger(version["number"]);
  if (number === null) throw new Error("schema v1 prompt_version.number must be a positive integer");
  if (deployment["prompt_version"] !== number) {
    throw new Error("schema v1 deployment.prompt_version must match prompt_version.number");
  }
  const provider = strictString(model["provider"]);
  const modelName = strictString(model["model"]);
  if (provider === null || modelName === null) throw new Error("schema v1 model provider and model are required");
  if (deployment["provider"] !== provider || deployment["model"] !== modelName) {
    throw new Error("schema v1 deployment provider/model must match model");
  }

  const promptBody = { ...prompt };
  delete promptBody["key"];
  return {
    schema_version: 1,
    project: input["project"],
    environment: input["environment"],
    prompts: { [key]: promptBody },
    deployments: { [key]: deployment },
    prompt_versions: { [`${key}@${String(number)}`]: version },
    models: { [`${provider}:${modelName}`]: model },
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
      id: null,
      key,
      kind,
      variables: decodeVariables(value, warnings),
      defaultParams: asRecord(value["default_params"]),
      payloadPolicy: decodePayloadPolicy(value["payload_policy"], warnings),
      deployment: deployments[key] ?? null,
    };
  }
  return prompts;
}

function decodeVariables(rawPrompt: Record<string, unknown>, warnings: DecodeWarning[]): VariableDefinition[] {
  if (Object.hasOwn(rawPrompt, "input_schema")) {
    throw new Error("prompt variables must use variables, not input_schema");
  }
  const raw = rawPrompt["variables"];
  if (!Array.isArray(raw)) return [];
  const variables: VariableDefinition[] = [];
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
    const rawPromptPins = value["prompt_pins"];
    if (isRecord(rawPromptPins)) {
      for (const [name, rawNumber] of Object.entries(rawPromptPins)) {
        const pinNumber = strictPositiveInteger(rawNumber);
        if (pinNumber === null) warnings.push({ kind: "invalid_prompt_pin", detail: `${key}.${name}` });
        else pins[name] = `${key}@${String(pinNumber)}`;
      }
    } else {
      const number = strictPositiveInteger(value["prompt_version"]);
      if (number !== null) {
        pins["default"] = `${key}@${String(number)}`;
      } else if (value["prompt_version"] !== null && value["prompt_version"] !== undefined) {
        warnings.push({ kind: "invalid_prompt_pin", detail: `${key}.default` });
      }
    }
    const deploymentModelId = modelKey(value["provider"], value["model"]);
    if (deploymentModelId === null) warnings.push({ kind: "invalid_model_ref", detail: key });
    deployments[key] = {
      id: null,
      promptKey: asString(value["prompt_key"]) ?? key,
      revision: asRevision(value["revision"], key),
      modelId: deploymentModelId ?? `invalid:${key}`,
      api: asString(value["api"]),
      requestPath: asString(value["request_path"]),
      params: asRecord(value["params"]),
      providerOptions: asRecord(value["provider_options"]),
      templatePins: pins,
    };
  }
  return deployments;
}

function decodeById<T extends { id: string | null; lookupKey?: string | null }>(
  raw: unknown,
  decode: (entry: Record<string, unknown>, fallbackId: string) => T | null,
  warnings: DecodeWarning[],
): Record<string, T> {
  const out: Record<string, T> = {};
  const insert = (key: string, decoded: T): void => {
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      warnings.push({ kind: "invalid_entry", detail: `duplicate:${key}` });
      return;
    }
    out[key] = decoded;
  };
  if (raw === null || raw === undefined) return out;
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
    if (decoded === null) continue;
    insert(decoded.id ?? decoded.lookupKey ?? id, decoded);
  }
  return out;
}

function decodePromptVersion(
  raw: Record<string, unknown>,
  fallbackId: string,
  warnings: DecodeWarning[],
): PromptVersion | null {
  const engine = asString(raw["engine"]) ?? "liquid";
  const kind = asString(raw["kind"]);
  const promptKey = strictString(raw["prompt"]);
  const number = strictPositiveInteger(raw["number"]);
  const readableKey = promptKey !== null && number !== null ? `${promptKey}@${String(number)}` : null;
  if ((promptKey !== null || Object.hasOwn(raw, "prompt")) && readableKey === null) {
    warnings.push({ kind: "invalid_prompt_version", detail: fallbackId });
    return null;
  }
  if (readableKey !== null && readableKey !== fallbackId) {
    warnings.push({ kind: "invalid_prompt_version", detail: fallbackId });
    return null;
  }
  if (readableKey === null) {
    warnings.push({ kind: "invalid_prompt_version", detail: fallbackId });
    return null;
  }
  return {
    id: null,
    lookupKey: readableKey,
    promptTemplateId: promptKey,
    number,
    kind,
    engine: (ENGINES.has(engine) ? engine : "liquid") as Engine,
    messages: decodeMessages(raw["messages"]),
    textTemplate: asString(raw["text_template"]),
    decision: decodeDecision(raw["decision"]),
    tools: decodeTools(raw["tools"]),
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
    messages.push({ ...entry });
  }
  return messages;
}

function decodeTools(raw: unknown): ToolDefinitions | null {
  if (!isRecord(raw)) return null;
  const definitions = raw["definitions"];
  if (!Array.isArray(definitions)) return null;
  const out: ToolDefinitions = {
    definitions: definitions.filter(isRecord).map((entry) => ({ ...entry })),
  };
  if (raw["tool_choice"] !== undefined) out.tool_choice = raw["tool_choice"];
  if (typeof raw["parallel_tool_calls"] === "boolean") out.parallel_tool_calls = raw["parallel_tool_calls"];
  return out;
}

function decodeModel(
  raw: Record<string, unknown>,
  fallbackId: string,
  warnings: DecodeWarning[],
): PromptModel | null {
  const capabilities = Array.isArray(raw["capabilities"])
    ? raw["capabilities"].map((value) => asString(value)).filter((value): value is string => value !== null)
    : [];
  const provider = strictString(raw["provider"]);
  const model = strictString(raw["model"]);
  const readableKey = provider !== null && model !== null ? `${provider}:${model}` : null;
  if (readableKey === null || readableKey !== fallbackId) {
    warnings.push({ kind: "invalid_entry", detail: fallbackId });
    return null;
  }
  return {
    id: null,
    lookupKey: readableKey,
    provider,
    modelId: model,
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

function strictString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRevision(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  throw new Error(`deployment ${key} revision must be a string like v2026.09.30-1`);
}

function asInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function strictPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function modelKey(providerValue: unknown, modelValue: unknown): string | null {
  const provider = strictString(providerValue);
  const model = strictString(modelValue);
  return provider !== null && model !== null ? `${provider}:${model}` : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}
