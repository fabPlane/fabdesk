import type { CoreClient } from "@fabdesk/client-core";
import type { AgentId } from "@fabdesk/protocol";

export function needsAntigravityProjectStart(input: { agentId: AgentId; home: boolean; draft: boolean; prepared: boolean }) {
  return input.agentId === "antigravity" && (input.home || input.draft) && !input.prepared;
}

/** Only call after explicit confirmation. A draft moves in place so its references survive. */
export async function prepareAntigravityProject(
  client: Pick<CoreClient, "createProject" | "promoteIdeaDraft">,
  draftId: string | null,
  name: string,
) {
  const title = name.trim();
  if (!title) throw new Error("Enter a project name before starting Antigravity.");
  if (draftId) {
    const promoted = await client.promoteIdeaDraft(draftId, title);
    if (promoted.id !== draftId || promoted.manifest.ideaDraft)
      throw new Error("The idea was not confirmed as an active project. Your message was not sent.");
    return promoted;
  }
  const project = await client.createProject(title);
  if (project.isDraft) throw new Error("The project was created as a draft. Your message was not sent.");
  return project;
}
