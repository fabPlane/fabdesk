import { useEffect } from "react";
import { useSettings } from "./queries";

export type ThemePreference = "system" | "light" | "dark";

export function applyTheme(pref: ThemePreference): boolean {
  const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset["theme"] = dark ? "dark" : "light";
  return dark;
}

/** Applies `settings.theme` (falling back to the OS preference) to the document. */
export function useTheme(): ThemePreference {
  const settings = useSettings();
  const pref: ThemePreference = settings.data?.theme ?? "system";
  useEffect(() => {
    applyTheme(pref);
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);
  return pref;
}

export function useIsDark(): boolean {
  const pref = useTheme();
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}
