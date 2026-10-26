/**
 * Decide whether the renderer may use the microphone. Only the app's own windows
 * (file://, app://, or the Vite dev server) may ask.
 */

const MEDIA_PERMISSIONS = new Set(["media", "microphone", "audioCapture"]);

export function isMediaPermission(permission: string): boolean {
  return MEDIA_PERMISSIONS.has(permission);
}

export function rendererMayUseMicrophone(
  requestingUrl: string,
  extraOrigins: readonly string[] = [],
): boolean {
  const raw = requestingUrl.trim();
  if (!raw) return false;
  if (raw === "null" || raw.startsWith("file://") || raw.startsWith("app://")) return true;
  try {
    const url = new URL(raw);
    if (url.protocol === "file:" || url.protocol === "app:") return true;
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    ) {
      return true;
    }
  } catch {
    return extraOrigins.includes(raw);
  }
  return extraOrigins.includes(raw);
}

export function decideMediaPermission(permission: string, requestingUrl: string): boolean {
  if (!isMediaPermission(permission)) return false;
  return rendererMayUseMicrophone(requestingUrl);
}
