/** Bound validation work before Zod expands errors (GHSA-46jr-4wx8-v453).
 * 50,000 members leaves room for thousands of components/edits in one call.
 * Larger jobs must be split; increasing the byte ceiling does not disable this guard.
 */
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 50_000;
/** Preserve the SDK's 4 MiB ceiling explicitly for streamed and declared bodies. */
export const MCP_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
