import { UnknownPromptError, UnknownTemplateError, UnresolvedError } from "./errors.js";
import type { DecisionTemplate, PayloadPolicy, PromptDocument } from "./snapshotData.js";
import type { Engine, Message } from "./template.js";

/**
 * Local resolution: snapshot + prompt key (+ template name) → which model, params and template
 * version to use. This is exactly what the prompt endpoint does on the server, minus the rendering.
 *
 * A deployment revision is a pin, not a router: no rules, no conditions, no weights. The only
 * selection axis at request time is the template name; the environment decided which snapshot was
 * fetched.
 */

/** The name used when a call asks for no template. */
export const DEFAULT_TEMPLATE = "default";

/** Where the snapshot behind a resolution came from. */
export type ResolutionSource = "remote" | "disk" | "bundle" | "manual";

/** Something odd about the snapshot that did not stop resolution. */
export interface ResolutionWarning {
  kind: "missing_prompt_version" | "missing_model";
  detail: string;
}

/** "What to use for this call." */
export interface Resolution {
  /** The resolved prompt key. */
  promptKey: string;
  /** `chat`, `text` or `embedding`. */
  kind: string;
  /** The immutable pinned version kind. Null for legacy schema v5 prompt documents. */
  pinnedKind: string | null;
  /** The chosen template name; `null` for an embedding prompt. */
  template: string | null;
  /** Every template name this deployment pins, sorted. */
  availableTemplates: string[];
  /** The deployment revision that produced this resolution. */
  deploymentId: string | null;
  deploymentRevision: number | null;
  api: string | null;
  requestPath: string | null;
  /** The pinned prompt version. */
  promptVersionId: string | null;
  promptVersionNumber: number | null;
  /** Which template engine the version was committed with. */
  engine: Engine | null;
  /** The catalog model id (a UUID). */
  modelId: string | null;
  /** The provider model string to send in the request body, e.g. `openai/gpt-4o-mini`. */
  model: string | null;
  /** The provider that serves the model, e.g. `openrouter`. */
  provider: string | null;
  /** `prompt_key.default_params` overridden by `deployment.params`. */
  params: Record<string, unknown>;
  /** `model.provider_options` overridden by `deployment.provider_options`. */
  providerOptions: Record<string, unknown>;
  /** The raw chat template, before rendering; `null` unless the kind is `chat`. */
  messages: Message[] | null;
  /** The raw text template, before rendering; `null` unless the kind is `text`. */
  textTemplate: string | null;
  /** The raw Decisions state/questions template, before rendering; `null` unless the kind is `decision`. */
  decision: DecisionTemplate | null;
  /** The payload policy the monitoring-log buffer applies to this prompt's records. */
  payloadPolicy: PayloadPolicy | null;
  /** Whether the snapshot came from the network, the disk cache or a bundled file. */
  source: ResolutionSource;
  /** The ETag of the snapshot this resolution came from. */
  etag: string | null;
  warnings: ResolutionWarning[];
}

/** Options for looking up a prompt in a decoded document. */
export interface PromptLookupOptions {
  template?: string | null;
  source?: ResolutionSource;
  etag?: string | null;
}

/**
 * Resolves a prompt against a decoded snapshot.
 *
 * Throws {@link UnknownPromptError}, {@link UnresolvedError} or {@link UnknownTemplateError} — a
 * 404 from any of them is a bug in the deployment or the call, never a reason to fall back to a
 * hard-coded prompt.
 */
export function resolvePromptFromSnapshot(
  snapshot: PromptDocument,
  promptKey: string,
  options: PromptLookupOptions = {},
): Resolution {
  const prompt = snapshot.prompts[promptKey];
  if (!prompt) throw new UnknownPromptError(promptKey);

  const deployment = prompt.deployment;
  if (!deployment) throw new UnresolvedError(promptKey);

  const availableTemplates = Object.keys(deployment.templatePins).sort();
  const isEmbedding = prompt.kind === "embedding";

  let promptName: string | null = null;
  let versionId: string | null = null;
  if (!isEmbedding) {
    promptName = options.template ?? DEFAULT_TEMPLATE;
    const pinned = deployment.templatePins[promptName];
    if (pinned === undefined) {
      throw new UnknownTemplateError(promptKey, promptName, availableTemplates);
    }
    versionId = pinned;
  }

  const warnings: ResolutionWarning[] = [];
  const version = versionId === null ? null : (snapshot.promptVersions[versionId] ?? null);
  if (versionId !== null && version === null) {
    warnings.push({ kind: "missing_prompt_version", detail: versionId });
  }
  const model = deployment.modelId === null ? null : (snapshot.models[deployment.modelId] ?? null);
  if (deployment.modelId !== null && model === null) {
    warnings.push({ kind: "missing_model", detail: deployment.modelId });
  }

  const runtimeKind = version?.kind ?? prompt.kind;

  return {
    promptKey: prompt.key,
    kind: runtimeKind,
    pinnedKind: version?.kind ?? null,
    template: promptName,
    availableTemplates: isEmbedding ? [] : availableTemplates,
    deploymentId: deployment.id,
    deploymentRevision: deployment.revision,
    api: deployment.api,
    requestPath: deployment.requestPath,
    promptVersionId: version?.id ?? null,
    promptVersionNumber: version?.number ?? null,
    engine: version?.engine ?? null,
    modelId: model?.id ?? null,
    model: model?.modelId ?? null,
    provider: model?.provider ?? null,
    params: mergeParams(prompt.defaultParams, deployment.params),
    providerOptions: mergeParams(model?.providerOptions, deployment.providerOptions),
    messages: runtimeKind === "chat" ? (version?.messages ?? null) : null,
    textTemplate: runtimeKind === "text" ? (version?.textTemplate ?? null) : null,
    decision: runtimeKind === "decision" ? (version?.decision ?? null) : null,
    payloadPolicy: prompt.payloadPolicy,
    source: options.source ?? "remote",
    etag: options.etag ?? null,
    warnings,
  };
}

/**
 * The template names this prompt's live deployment pins, sorted. Empty when there is no
 * deployment. These are exactly the values `prompt()` accepts as a template name.
 */
export function templateNamesFromSnapshot(snapshot: PromptDocument, promptKey: string): string[] {
  const prompt = snapshot.prompts[promptKey];
  if (!prompt) throw new UnknownPromptError(promptKey);
  if (!prompt.deployment) return [];
  return Object.keys(prompt.deployment.templatePins).sort();
}

/**
 * Shallow merge where the right side wins. A nested object on the right replaces the left side
 * whole, and an override value of `null` is kept as `null` rather than deleting the key — apps
 * rely on sending `"only": null` to clear a provider restriction.
 */
export function mergeParams(
  base: Record<string, unknown> | null | undefined,
  override: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return { ...(base ?? {}), ...(override ?? {}) };
}
