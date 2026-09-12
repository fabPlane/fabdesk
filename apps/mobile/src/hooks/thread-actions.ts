/**
 * Rename / pin / archive / branch / delete for one thread, over the same mutations the desktop
 * sidebar uses, so the change shows up there too. Navigation after a destructive action is the
 * caller's (the thread screen goes back; the Archived list stays put).
 */
import { useCoreClient, useThreadMutations } from "@fabdesk/client-core";
import type { Message, Thread } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { branchInput, renamedTitle } from "@/lib/thread-actions";

export function useThreadActions() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const { create, patch, remove } = useThreadMutations();
  const [busy, setBusy] = useState(false);

  const guard = useCallback(
    async <T>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      try {
        return await work();
      } catch (e) {
        Alert.alert(label, e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const rename = useCallback(
    (thread: Thread, raw: string) => {
      const title = renamedTitle(raw, thread.title);
      if (!title) return Promise.resolve(undefined);
      return guard("Could not rename", () =>
        patch.mutateAsync({ id: thread.id, patch: { title } }),
      );
    },
    [guard, patch],
  );

  const togglePin = useCallback(
    (thread: Thread) =>
      guard("Could not pin", () =>
        patch.mutateAsync({ id: thread.id, patch: { pinned: !thread.pinned } }),
      ),
    [guard, patch],
  );

  const toggleArchive = useCallback(
    (thread: Thread) =>
      guard("Could not archive", () =>
        patch.mutateAsync({ id: thread.id, patch: { archived: !thread.archived } }),
      ),
    [guard, patch],
  );

  /** Branches from the last message, like the desktop; resolves to the new thread. */
  const branch = useCallback(
    (thread: Thread) =>
      guard("Could not branch", async () => {
        const msgs =
          qc.getQueryData<Message[]>(["messages", thread.id]) ??
          (await client.listMessages(thread.id).catch(() => [] as Message[]));
        return create.mutateAsync(branchInput(thread, msgs[msgs.length - 1]?.id));
      }),
    [guard, qc, client, create],
  );

  /** Resolves true once the thread is gone; false/undefined when cancelled or failed. */
  const del = useCallback(
    (thread: Thread) =>
      new Promise<boolean>((resolve) => {
        Alert.alert("Delete this chat?", `"${thread.title}" and its messages will be removed.`, [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          {
            text: "Delete",
            style: "destructive",
            onPress: () =>
              void guard("Could not delete", () =>
                remove.mutateAsync(thread.id).then(() => true),
              ).then((r) => resolve(r === true)),
          },
        ]);
      }),
    [guard, remove],
  );

  return { rename, togglePin, toggleArchive, branch, delete: del, busy };
}
