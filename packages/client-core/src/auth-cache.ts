import type { AuthState } from "@fabdesk/protocol";
import type { QueryClient } from "@tanstack/react-query";
import { useAuthStore } from "./stores/auth";

const cloudRoots = new Set(["cloud", "project-share", "contributions", "team-projects", "team-boards"]);
export const hasFabplaneSession = (state: AuthState | null) => state?.mode === "fabplane" && state.status === "signed_in";
// An unidentified approved session is distinct from signed-out for cache invalidation.
export const cloudAccountId = (state: AuthState | null) => hasFabplaneSession(state)
  ? state?.principal?.subject ?? "" : null;

/** A delayed action response is a snapshot, not authority over a newer SSE update. */
export function acceptAuthSnapshot(qc: QueryClient, expected: AuthState | null, next: AuthState): boolean {
  void qc.cancelQueries({ queryKey: ["auth"] });
  const current = useAuthStore.getState().state;
  if (current !== expected) {
    if (current) qc.setQueryData(["auth"], current);
    return false;
  }
  qc.setQueryData(["auth"], next);
  useAuthStore.getState().setState(next);
  return true;
}

/** Drop private cloud results immediately on logout/account changes, including in-flight results. */
export function resetCloudAccountCache(qc: QueryClient, previous: AuthState | null, next: AuthState | null) {
  if (cloudAccountId(previous) === cloudAccountId(next)) return;
  const filters = { predicate: (query: { queryKey: readonly unknown[] }) => cloudRoots.has(String(query.queryKey[0])) };
  void qc.cancelQueries(filters);
  qc.removeQueries(filters);
}
