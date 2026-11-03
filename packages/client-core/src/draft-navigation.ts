import type { Message, ProjectSummary, QuestionPart, Thread } from "@fabdesk/protocol";

/** Resume the latest saved, unarchived conversation belonging to this workspace only. */
export function draftConversation(projectId: string, threads: readonly Thread[]): Thread | undefined {
  return threads.filter(thread => thread.projectId === projectId && !thread.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}

export function draftWorkspaceTitle(project: Pick<ProjectSummary, "id" | "name" | "isDraft">, threads: readonly Thread[]): string {
  if (!project.isDraft || project.name !== "Untitled idea") return project.name;
  const title = draftConversation(project.id, threads)?.title.trim();
  return title && title !== "New chat" ? title : project.name;
}

/** Unanswered history is not a live question once its run has ended. */
export function activeQuestion(messages: readonly Message[], runId: string | undefined): QuestionPart | undefined {
  if (!runId) return undefined;
  for (const message of messages) {
    if (message.role !== "assistant" || message.runId !== runId) continue;
    const question = message.parts.find((part): part is QuestionPart => part.type === "question" && part.answer === null);
    if (question) return question;
  }
  return undefined;
}
