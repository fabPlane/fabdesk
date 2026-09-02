/**
 * Tolerant JSONL reader: yields one parsed value per non-empty line, skips lines that are not
 * JSON (CLI banners, warnings printed to stdout, partial writes) and flushes a trailing line
 * without a newline.
 */
export async function* readJsonl(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const parsed = parseJsonlLine(line);
        if (parsed !== undefined) yield parsed;
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    const parsed = parseJsonlLine(buffer);
    if (parsed !== undefined) yield parsed;
  } finally {
    reader.releaseLock();
  }
}

/** Parses one line; returns `undefined` for blank or non-JSON lines. Only objects/arrays count. */
export function parseJsonlLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Collects a byte stream into a string, keeping only the last `maxChars` characters. */
export async function readTail(
  stream: ReadableStream<Uint8Array>,
  maxChars = 8192,
): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars * 2) text = text.slice(-maxChars);
    }
  } finally {
    reader.releaseLock();
  }
  text += decoder.decode();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
