import type { AuthState } from "@fabdesk/protocol";
import type { QueryClient } from "@tanstack/react-query";

const cloudRoots = new Set(["cloud", "project-share", "contributions", "team-projects", "team-boards"]);
export const cloudAccountId = (state: AuthState | null) => state?.mode === "fabplane" && state.status === "signed_in"
  ? state.principal?.subject ?? null : null;

/** Drop private cloud results immediately on logout/account changes, including in-flight results. */
export function resetCloudAccountCache(qc: QueryClient, previous: AuthState | null, next: AuthState | null) {
  if (cloudAccountId(previous) === cloudAccountId(next)) return;
  const filters = { predicate: (query: { queryKey: readonly unknown[] }) => cloudRoots.has(String(query.queryKey[0])) };
  void qc.cancelQueries(filters);
  qc.removeQueries(filters);
}
