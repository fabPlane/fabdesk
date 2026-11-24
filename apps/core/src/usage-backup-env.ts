/** Operator kill switch for remote usage-archive upload. Unset means on (opt-out). */

const OFF = new Set(["0", "false", "off", "no", ""]);

/**
 * Remote upload is on unless `FABDESK_USAGE_REMOTE_BACKUP` is an explicit off value
 * (`0` / `false` / `off` / `no` / empty). Unset means on.
 */
export function usageRemoteBackupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["FABDESK_USAGE_REMOTE_BACKUP"];
  if (raw === undefined) return true;
  return !OFF.has(raw.trim().toLowerCase());
}
