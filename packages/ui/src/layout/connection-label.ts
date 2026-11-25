/**
 * Text beside the header's connection dot. A core on this computer is the normal case, so it gets
 * no label while a fabPlane account is signed in: "local" is reserved for running without one,
 * where it would otherwise read as an account state.
 */
export function connectionLabel(opts: { connected: boolean; localCore: boolean; fabplaneSession: boolean }): string | null {
  if (!opts.connected) return "Reconnecting…";
  if (!opts.localCore) return "Remote workspace";
  return opts.fabplaneSession ? null : "Local mode";
}
