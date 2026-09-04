/** The published version of this SDK. Sent as `sdk.version` on every monitoring log. */
export const VERSION = "0.1.0";

/** The `sdk.name` every monitoring log carries. */
export const SDK_NAME = "prompton-nodejs";

/** The `User-Agent` the SDK sends. */
export const USER_AGENT = `${SDK_NAME}/${VERSION}`;
