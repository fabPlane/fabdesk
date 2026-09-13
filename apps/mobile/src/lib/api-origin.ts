import { PRODUCTION_API_ORIGIN } from "@fabdesk/auth-client/browser";

/**
 * Where the phone talks to fabplane.com. Override with `EXPO_PUBLIC_FABPLANE_API_ORIGIN`
 * (staging, a local mock, the Android emulator's `http://10.0.2.2:…` host loopback).
 */
export function fabplaneApiOrigin(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  const raw = env["EXPO_PUBLIC_FABPLANE_API_ORIGIN"]?.trim();
  return (raw && raw.length > 0 ? raw : PRODUCTION_API_ORIGIN).replace(/\/+$/, "");
}
