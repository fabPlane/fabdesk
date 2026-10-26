/** Map getUserMedia / speech errors into composer events. */

export function classifyMediaError(error: unknown): {
  type: "permission_denied" | "unavailable";
  message: string;
} {
  const name = error instanceof DOMException ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    /denied|permission/i.test(message)
  ) {
    return {
      type: "permission_denied",
      message:
        "Microphone access was denied. Allow the microphone for fabPlane in system settings, then try again.",
    };
  }
  if (name === "NotFoundError" || /no.*microphone|not found/i.test(message)) {
    return {
      type: "unavailable",
      message: "No microphone was found. Plug one in and try again.",
    };
  }
  return {
    type: "unavailable",
    message: message.trim() || "The microphone is not available.",
  };
}
