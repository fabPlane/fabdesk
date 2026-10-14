/**
 * OS locales for the core's offline privacy-region guess (`FABDESK_SYSTEM_LOCALES`). GUI launches
 * on macOS and Windows carry no `LANG`, so the core cannot read them itself. Call after app ready.
 */
export function systemLocaleEnv(source: {
  getSystemLocale(): string;
  getPreferredSystemLanguages(): string[];
}): Record<string, string> {
  const locales: string[] = [];
  const add = (read: () => string[]) => {
    try {
      for (const l of read()) if (l.trim() && !l.includes(",") && !locales.includes(l.trim())) locales.push(l.trim());
    } catch {
      /* best effort: a missing locale only weakens the guess */
    }
  };
  add(() => [source.getSystemLocale()]);
  add(() => source.getPreferredSystemLanguages());
  return locales.length ? { FABDESK_SYSTEM_LOCALES: locales.join(",") } : {};
}
