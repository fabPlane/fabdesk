/** Electron IPC adds transport details that are not useful to the person recording. */
export function speechErrorMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
  if (/Siri and Dictation are disabled/i.test(message)) {
    return "macOS Dictation is turned off. Enable Dictation in System Settings → Keyboard, then try again.";
  }
  return message;
}
