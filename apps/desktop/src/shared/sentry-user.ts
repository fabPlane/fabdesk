/** Sentry user derived from the core's auth state: id + handle only, never email (docs/sentry.md). */
import type { AuthState } from "@fabdesk/protocol";

export interface SentryUser {
  id: string;
  username?: string;
}

export function sentryUserFromAuth(
  state: Pick<AuthState, "mode" | "status" | "principal"> | null | undefined,
): SentryUser | null {
  if (!state || state.status !== "signed_in") return null;
  if (state.mode === "local") return { id: "local:dev", username: "local" };
  const p = state.principal;
  if (!p) return null;
  return { id: p.subject, ...(p.handle ? { username: p.handle } : {}) };
}
