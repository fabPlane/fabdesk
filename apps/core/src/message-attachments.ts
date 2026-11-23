import type { MessagePart } from "@fabdesk/protocol";

type Attachment = { path: string; mime: string; role?: "sketch" | "markup" };

/** Persist sketch/markup roles on stored image parts so queued sends restore them. */
export function imagePartsFromAttachments(
  attachments: readonly { path: string; mime: string; role?: Attachment["role"] | undefined }[],
): MessagePart[] {
  return attachments.map((a) => ({
    type: "image" as const,
    path: a.path,
    mime: a.mime,
    ...(a.role ? { role: a.role } : {}),
  }));
}

export function attachmentsFromImageParts(parts: readonly MessagePart[]): Attachment[] {
  return parts.flatMap((p) =>
    p.type === "image" ? [{ path: p.path, mime: p.mime, ...(p.role ? { role: p.role } : {}) }] : [],
  );
}
