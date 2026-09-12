import type { Message, Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useCoreClient } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { truncate } from "../util";
import { useThreadMutations } from "@fabdesk/client-core";

/** Creates a branch of `thread` from its last message and makes it active. */
export function useBranchThread() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const { create } = useThreadMutations();
  const setActiveThread = useUiStore((s) => s.setActiveThread);
  return useCallback(
    async (t: Thread) => {
      const msgs = qc.getQueryData<Message[]>(["messages", t.id]) ?? (await client.listMessages(t.id).catch(() => [] as Message[]));
      const last = msgs[msgs.length - 1];
      const created = await create.mutateAsync({
        projectId: t.projectId,
        title: `${truncate(t.title, 50)} (branch)`,
        agentId: t.agentId,
        ...(t.model ? { model: t.model } : {}),
        parentThreadId: t.id,
        ...(last ? { branchFromMessageId: last.id } : {}),
      });
      setActiveThread(created.id);
      return created;
    },
    [client, qc, create, setActiveThread],
  );
}
