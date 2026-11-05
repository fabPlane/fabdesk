import type { QuestionPart } from "@fabdesk/protocol";
import { useUiStore } from "../stores/ui";

/** The old request is closed: prepare a new message, never resolve or send it implicitly. */
export function reviewClosedQuestion(threadId: string, part: QuestionPart, answer: string) {
  const ui = useUiStore.getState();
  if (ui.activeThreadId !== threadId || part.answer !== "" || !answer.trim()) return false;
  const followup = `About your earlier question: ${part.question}\nMy answer: ${answer.trim()}`;
  const previous = ui.drafts[threadId] ?? "";
  if (!previous.endsWith(followup)) ui.setDraft(threadId, previous.trim() ? `${previous}\n\n${followup}` : followup);
  ui.focusComposer();
  return true;
}
