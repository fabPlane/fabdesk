/**
 * A supervised run's approval and question requests for one thread: what is pending, a haptic
 * when something new arrives, and answering them. The cards are dumb; this is where the daemon
 * calls and the optimistic cache patches live.
 *
 * Two sources feed it. The message parts (`approval` / `question`) arrive through the event
 * reducer once it knows those topics; until then — and for a request that came in while the
 * socket was down — `usePendingRequests` polls `GET /threads/:id` while a run is live. Whatever
 * the parts do not show yet is rendered from that block (`unplacedPending`).
 */
import {
  CoreHttpError,
  messagesKey,
  pendingRequestsKey,
  useAnswerQuestion,
  usePendingRequests,
  useResolveApproval,
  type PendingRequestsBlock,
} from "@fabdesk/client-core";
import type { Message } from "@fabdesk/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";
import {
  EMPTY_PENDING,
  newRequestIds,
  resolveInMessages,
  unplacedPending,
  withoutRequest,
  type ApprovalDecision,
  type PendingPart,
  type PendingRequests,
} from "@/lib/pending-requests";
import { haptic } from "@/state/haptics";

export function usePendingForThread(threadId: string | null, running: boolean) {
  const qc = useQueryClient();
  const query = usePendingRequests(threadId, { live: running });
  const approvals = useResolveApproval();
  const answers = useAnswerQuestion();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const pending: PendingRequests = query.data ?? EMPTY_PENDING;

  // Buzz once per new request. The first read after opening the screen counts too: if you
  // opened it because the desktop is waiting, the phone should say so the moment it knows.
  const seen = useRef<PendingRequests | undefined>(undefined);
  useEffect(() => {
    if (!query.data) return;
    if (newRequestIds(seen.current, query.data).length > 0) haptic("warning");
    seen.current = query.data;
  }, [query.data]);

  // The poll stops with the run; one more read clears whatever the last poll still showed.
  const refetch = query.refetch;
  useEffect(() => {
    if (!running && threadId) void refetch();
  }, [running, threadId, refetch]);

  const unplaced = useCallback(
    (messages: readonly Message[] | undefined): PendingPart[] => unplacedPending(messages, pending),
    [pending],
  );

  const mark = (requestId: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(requestId);
      else next.delete(requestId);
      return next;
    });

  const settle = useCallback(
    (
      requestId: string,
      outcome: { decision: ApprovalDecision; by: "device" } | { answer: string },
    ) => {
      if (!threadId) return;
      qc.setQueryData<Message[]>(messagesKey(threadId), (old) =>
        old ? resolveInMessages(old, requestId, outcome) : old,
      );
      qc.setQueryData<PendingRequestsBlock>(pendingRequestsKey(threadId), (old) =>
        old ? withoutRequest(old, requestId) : old,
      );
    },
    [qc, threadId],
  );

  const report = (title: string, e: unknown) => {
    // 409: the desktop (or a timeout) got there first; the refetch shows the outcome, no alarm.
    if (e instanceof CoreHttpError && e.status === 409) return;
    Alert.alert(title, e instanceof Error ? e.message : String(e));
  };

  const decide = useCallback(
    async (requestId: string, decision: ApprovalDecision) => {
      if (!threadId || busy.has(requestId)) return;
      mark(requestId, true);
      try {
        await approvals.mutateAsync({ threadId, requestId, decision });
        settle(requestId, { decision, by: "device" });
        haptic(decision === "approve" ? "success" : "tap");
      } catch (e) {
        report(decision === "approve" ? "Could not approve" : "Could not deny", e);
      } finally {
        mark(requestId, false);
      }
    },
    [threadId, busy, approvals, settle],
  );

  const answer = useCallback(
    async (requestId: string, text: string) => {
      if (!threadId || busy.has(requestId)) return;
      mark(requestId, true);
      try {
        await answers.mutateAsync({ threadId, requestId, answer: text });
        settle(requestId, { answer: text });
        haptic("success");
      } catch (e) {
        report("Could not send the answer", e);
      } finally {
        mark(requestId, false);
      }
    },
    [threadId, busy, answers, settle],
  );

  return useMemo(
    () => ({ pending, unplaced, decide, answer, busy }),
    [pending, unplaced, decide, answer, busy],
  );
}

export type PendingActions = Pick<
  ReturnType<typeof usePendingForThread>,
  "decide" | "answer" | "busy"
>;
