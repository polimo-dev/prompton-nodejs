/**
 * Every error the SDK raises deliberately carries a stable `code`, so callers can branch on it
 * without matching messages.
 */
export type PromptOnErrorCode =
  | "not_ready"
  | "unknown_use_case"
  | "unresolved"
  | "unknown_prompt"
  | "no_template"
  | "missing_variable"
  | "parse_error"
  | "render_error"
  | "invalid_config"
  | "invalid_record"
  | "http_error"
  | "transport_error";

/** Base class of every error this SDK throws. */
export class PromptOnError extends Error {
  readonly code: PromptOnErrorCode;

  constructor(code: PromptOnErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Nothing is cached and PromptOn could not be reached: neither memory, disk nor a bundle holds a
 * snapshot for this environment. This is the only resolution failure that means "PromptOn is
 * unreachable"; the others mean the deployment or the call is wrong.
 */
export class NotReadyError extends PromptOnError {
  constructor(message: string) {
    super("not_ready", message);
  }
}

/** The use case key is not in the snapshot. */
export class UnknownUseCaseError extends PromptOnError {
  readonly useCase: string;

  constructor(useCase: string) {
    super("unknown_use_case", `unknown use case: ${useCase}`);
    this.useCase = useCase;
  }
}

/** The use case exists but has no live deployment in this environment. */
export class UnresolvedError extends PromptOnError {
  readonly useCase: string;

  constructor(useCase: string) {
    super(
      "unresolved",
      `use case ${useCase} has no live deployment in this environment — deploy it, never fall back to a hard-coded prompt`,
    );
    this.useCase = useCase;
  }
}

/** The live deployment pins no prompt version under the requested name. */
export class UnknownPromptError extends PromptOnError {
  readonly useCase: string;
  readonly prompt: string;
  readonly availablePrompts: string[];

  constructor(useCase: string, prompt: string, availablePrompts: string[]) {
    super(
      "unknown_prompt",
      `the live deployment of ${useCase} pins no prompt named "${prompt}" — available prompts: ${availablePrompts.join(", ")}`,
    );
    this.useCase = useCase;
    this.prompt = prompt;
    this.availablePrompts = availablePrompts;
  }
}

/** `render()` was called on a resolution that carries no template (an embedding use case). */
export class NoTemplateError extends PromptOnError {
  constructor(useCase: string) {
    super("no_template", `use case ${useCase} has no prompt template to render`);
  }
}

/** A variable the template reads is absent from the variables map. */
export class MissingVariableError extends PromptOnError {
  readonly variable: string;

  constructor(variable: string) {
    super("missing_variable", `missing variable: ${variable}`);
    this.variable = variable;
  }
}

/** The template uses a construct outside the allowed subset, or is malformed. */
export class TemplateParseError extends PromptOnError {
  constructor(message: string) {
    super("parse_error", message);
  }
}

/** The template parsed but rendering failed for another reason. */
export class TemplateRenderError extends PromptOnError {
  constructor(message: string) {
    super("render_error", message);
  }
}

/** A configuration value is unusable. */
export class ConfigError extends PromptOnError {
  constructor(message: string) {
    super("invalid_config", message);
  }
}

/** A monitoring-log record is missing a required field. */
export class InvalidRecordError extends PromptOnError {
  constructor(message: string) {
    super("invalid_record", message);
  }
}

/** A PromptOn API call came back with a non-success status. */
export class ApiError extends PromptOnError {
  readonly status: number;
  readonly body: unknown;
  /**
   * How long the server asked us to wait, in milliseconds: `Retry-After`, or
   * `error.details.retry_after`. `null` when the response carried neither.
   */
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, body: unknown, retryAfterMs: number | null = null) {
    super("http_error", message);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}
