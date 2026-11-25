import type { AuthState } from "@fabdesk/protocol";

/**
 * Text beside the header's connection dot. A core on this computer is the normal case, so it gets
 * no label; "Local" is reserved for local auth (no fabPlane account). A fabPlane session that
 * is signed out, pending or expired is still fabPlane mode and is reported by the account controls.
 */
export function connectionLabel(opts: { connected: boolean; localCore: boolean; authMode: AuthState["mode"] | undefined }): string | null {
  if (!opts.connected) return "Reconnecting…";
  if (!opts.localCore) return "Remote workspace";
  return opts.authMode === "local" ? "Local" : null;
}
