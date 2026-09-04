/** The minimal logging surface the SDK uses. Any object with these four methods will do. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Writes to the console with a `[prompton]` prefix. */
export const consoleLogger: Logger = {
  debug: () => undefined,
  info: (message) => {
    console.info(`[prompton] ${message}`);
  },
  warn: (message) => {
    console.warn(`[prompton] ${message}`);
  },
  error: (message) => {
    console.error(`[prompton] ${message}`);
  },
};

/** Says nothing at all. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Wraps a logger so a given message is emitted at most once per interval. */
export function throttled(logger: Logger, intervalMs: number): Logger {
  const lastSeen = new Map<string, number>();
  const gate = (key: string): boolean => {
    const now = Date.now();
    const previous = lastSeen.get(key);
    if (previous !== undefined && now - previous < intervalMs) return false;
    lastSeen.set(key, now);
    return true;
  };
  return {
    debug: (message) => {
      if (gate(`debug:${message}`)) logger.debug(message);
    },
    info: (message) => {
      if (gate(`info:${message}`)) logger.info(message);
    },
    warn: (message) => {
      if (gate(`warn:${message}`)) logger.warn(message);
    },
    error: (message) => {
      if (gate(`error:${message}`)) logger.error(message);
    },
  };
}
