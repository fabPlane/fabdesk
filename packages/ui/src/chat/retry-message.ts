import type { Message } from "@fabdesk/protocol";
import { useUiStore } from "../stores/ui";

/** Restore for review, never resend automatically or overwrite an unsent draft. */
export function reviewFailedPrompt(message: Message) {
  const ui = useUiStore.getState();
  if (ui.activeThreadId !== message.threadId) return false;
  if (!(ui.drafts[message.threadId] ?? "").trim() && !(ui.attachments[message.threadId]?.length)) {
    ui.setDraft(message.threadId, message.contentMd);
    for (const part of message.parts) if (part.type === "image") ui.addAttachment(message.threadId, {
      path: part.path, mime: part.mime, label: part.path.split(/[\\/]/).pop() ?? "Attachment",
    });
  }
  ui.focusComposer();
  return true;
}
