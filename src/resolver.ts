import { UnknownPromptError, UnknownUseCaseError, UnresolvedError } from "./errors.js";
import type { PayloadPolicy, SnapshotData } from "./snapshotData.js";
import type { Engine, Message } from "./template.js";

/**
 * Local resolution: snapshot + use case key (+ prompt name) → which model, params and prompt
 * version to use. This is exactly what `POST /resolve` does on the server, minus the rendering.
 *
 * A deployment revision is a pin, not a router: no rules, no conditions, no weights. The only
 * selection axis at request time is the prompt name; the environment decided which snapshot was
 * fetched.
 */

/** The name used when a call asks for no prompt. */
export const DEFAULT_PROMPT = "default";

/** Where the snapshot behind a resolution came from. */
export type ResolutionSource = "remote" | "disk" | "bundle" | "manual";

/** Something odd about the snapshot that did not stop resolution. */
export interface ResolutionWarning {
  kind: "missing_prompt_version" | "missing_model";
  detail: string;
}

/** "What to use for this call." */
export interface Resolution {
  /** The resolved use case key. */
  useCase: string;
  /** `chat`, `text` or `embedding`. */
  kind: string;
  /** The chosen prompt name; `null` for an embedding use case. */
  prompt: string | null;
  /** Every prompt name this deployment pins, sorted. */
  availablePrompts: string[];
  /** The deployment revision that produced this resolution. */
  deploymentId: string | null;
  deploymentRevision: number | null;
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
  /** `use_case.default_params` overridden by `deployment.params`. */
  params: Record<string, unknown>;
  /** `model.provider_options` overridden by `deployment.provider_options`. */
  providerOptions: Record<string, unknown>;
  /** The raw chat template, before rendering; `null` unless the kind is `chat`. */
  messages: Message[] | null;
  /** The raw text template, before rendering; `null` unless the kind is `text`. */
  textTemplate: string | null;
  /** The payload policy the monitoring-log buffer applies to this use case's records. */
  payloadPolicy: PayloadPolicy | null;
  /** Whether the snapshot came from the network, the disk cache or a bundled file. */
  source: ResolutionSource;
  /** The ETag of the snapshot this resolution came from. */
  etag: string | null;
  warnings: ResolutionWarning[];
}

/** Options for {@link resolveFromSnapshot}. */
export interface ResolveOptions {
  prompt?: string | null;
  source?: ResolutionSource;
  etag?: string | null;
}

/**
 * Resolves a use case against a decoded snapshot.
 *
 * Throws {@link UnknownUseCaseError}, {@link UnresolvedError} or {@link UnknownPromptError} — a
 * 404 from any of them is a bug in the deployment or the call, never a reason to fall back to a
 * hard-coded prompt.
 */
export function resolveFromSnapshot(
  snapshot: SnapshotData,
  useCaseKey: string,
  options: ResolveOptions = {},
): Resolution {
  const useCase = snapshot.useCases[useCaseKey];
  if (!useCase) throw new UnknownUseCaseError(useCaseKey);

  const deployment = useCase.deployment;
  if (!deployment) throw new UnresolvedError(useCaseKey);

  const availablePrompts = Object.keys(deployment.promptPins).sort();
  const isEmbedding = useCase.kind === "embedding";

  let promptName: string | null = null;
  let versionId: string | null = null;
  if (!isEmbedding) {
    promptName = options.prompt ?? DEFAULT_PROMPT;
    const pinned = deployment.promptPins[promptName];
    if (pinned === undefined) {
      throw new UnknownPromptError(useCaseKey, promptName, availablePrompts);
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

  return {
    useCase: useCase.key,
    kind: useCase.kind,
    prompt: promptName,
    availablePrompts: isEmbedding ? [] : availablePrompts,
    deploymentId: deployment.id,
    deploymentRevision: deployment.revision,
    promptVersionId: version?.id ?? null,
    promptVersionNumber: version?.number ?? null,
    engine: version?.engine ?? null,
    modelId: model?.id ?? null,
    model: model?.modelId ?? null,
    provider: model?.provider ?? null,
    params: mergeParams(useCase.defaultParams, deployment.params),
    providerOptions: mergeParams(model?.providerOptions, deployment.providerOptions),
    messages: useCase.kind === "chat" ? (version?.messages ?? null) : null,
    textTemplate: useCase.kind === "text" ? (version?.textTemplate ?? null) : null,
    payloadPolicy: useCase.payloadPolicy,
    source: options.source ?? "remote",
    etag: options.etag ?? null,
    warnings,
  };
}

/**
 * The prompt names this use case's live deployment pins, sorted. Empty when there is no
 * deployment. These are exactly the values `resolve()` accepts as a prompt name.
 */
export function promptNamesFromSnapshot(snapshot: SnapshotData, useCaseKey: string): string[] {
  const useCase = snapshot.useCases[useCaseKey];
  if (!useCase) throw new UnknownUseCaseError(useCaseKey);
  if (!useCase.deployment) return [];
  return Object.keys(useCase.deployment.promptPins).sort();
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
