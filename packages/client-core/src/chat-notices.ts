import type { Message } from "@fabdesk/protocol";

const SHARED_SETTINGS_NOTICE = "Windows denied a Codex overlay symlink (EPERM).";

/** Keep the first setup notice in saved history, without changing the stored messages. */
export function deduplicateChatNotices(messages: Message[]): Message[] {
  const seenThreads = new Set<string>();
  return messages.map((message) => {
    if (message.role !== "assistant") return message;
    const alreadySeen = seenThreads.has(message.threadId);
    const stripRepeated = (text: string, state: { seen: boolean }): string => {
      let changed = false;
      const paragraphs = text.split(/\r?\n\r?\n/).filter((paragraph) => {
        if (!paragraph.replace(/^\s*⚠\s*/, "").trim().startsWith(SHARED_SETTINGS_NOTICE)) return true;
        if (!state.seen) { state.seen = true; return true; }
        changed = true;
        return false;
      });
      return changed ? paragraphs.join("\n\n") : text;
    };
    // contentMd mirrors text parts; it must not count as a second occurrence.
    const partState = { seen: alreadySeen };
    const parts = message.parts.map((part) => {
      if (part.type !== "text") return part;
      const text = stripRepeated(part.text, partState);
      return text === part.text ? part : { ...part, text };
    });
    const contentState = { seen: alreadySeen };
    const contentMd = stripRepeated(message.contentMd, contentState);
    if (partState.seen || contentState.seen) seenThreads.add(message.threadId);
    return contentMd === message.contentMd && parts.every((part, i) => part === message.parts[i])
      ? message : { ...message, parts, contentMd };
  });
}
