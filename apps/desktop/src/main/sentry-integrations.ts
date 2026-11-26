const NATIVE_MINIDUMP_INTEGRATIONS = new Set(["SentryMinidump", "ElectronMinidump"]);

/** Raw crash attachments bypass event-field scrubbing; do not initialize their collectors. */
export function withoutNativeMinidumps<T extends { name: string }>(defaults: readonly T[]): T[] {
  return defaults.filter(({ name }) => !NATIVE_MINIDUMP_INTEGRATIONS.has(name));
}
