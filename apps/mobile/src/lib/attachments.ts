/**
 * Photos attached to a message. The daemon stores them as project sketches (`POST
 * /projects/:id/sketches`, PNG or JPEG only) and the message carries `{ path, mime }` references,
 * exactly what the desktop's SketchPad sends. Everything here is pure; the hook that talks to
 * expo-image-picker and uploads sits on top.
 */

/** Generous, but a phone camera's 48 MP HEIC-turned-JPEG can pass it; the picker recompresses. */
export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg";

/** The subset of an expo-image-picker asset we look at. */
export interface PickedImage {
  uri: string;
  mimeType?: string | null | undefined;
  fileName?: string | null | undefined;
  fileSize?: number | undefined;
}

export type Preflight = { ok: true; mime: ImageMime; name: string } | { ok: false; reason: string };

export interface PendingAttachment {
  key: string;
  localUri: string;
  mime: ImageMime;
  name: string;
  /** Set once the daemon has stored it; the message references this. */
  path?: string;
  error?: string;
}

/**
 * Whether the daemon will take the file, and what to call it. The mime comes from the picker when
 * it knows, else from the extension; anything but PNG/JPEG is refused here rather than as a 415
 * after the upload.
 */
export function preflightImage(asset: PickedImage, now = Date.now()): Preflight {
  const mime = imageMime(asset.mimeType) ?? imageMime(mimeFromName(asset.fileName ?? asset.uri));
  if (!mime) return { ok: false, reason: "Only PNG and JPEG photos can be attached." };
  if (asset.fileSize !== undefined && asset.fileSize > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: `That photo is ${Math.round(asset.fileSize / (1024 * 1024))} MB; the limit is ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB.`,
    };
  }
  return { ok: true, mime, name: uploadName(asset.fileName, mime, now) };
}

function imageMime(raw: string | null | undefined): ImageMime | null {
  const m = (raw ?? "").toLowerCase().split(";")[0]!.trim();
  if (m === "image/png") return "image/png";
  if (m === "image/jpeg" || m === "image/jpg") return "image/jpeg";
  return null;
}

function mimeFromName(name: string): string | null {
  const ext = name.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return null;
}

/**
 * The stored file name. The daemon sanitises and de-duplicates, but a timestamped name means two
 * camera shots called `IMG_0001.jpg` do not turn into `IMG_0001-2.jpg` and confuse the agent.
 */
export function uploadName(
  fileName: string | null | undefined,
  mime: ImageMime,
  now: number,
): string {
  const ext = mime === "image/png" ? "png" : "jpg";
  const stem = (fileName ?? "")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${stem || "photo"}-${now}.${ext}`;
}

/** What goes into `POST /threads/:id/messages`: only what the daemon has actually stored. */
export function toMessageAttachments(
  pending: readonly PendingAttachment[],
): Array<{ path: string; mime: string }> {
  return pending.flatMap((a) => (a.path ? [{ path: a.path, mime: a.mime }] : []));
}

/** True while any upload is still in flight or failed — sending would drop those. */
export function attachmentsSettled(pending: readonly PendingAttachment[]): boolean {
  return pending.every((a) => a.path && !a.error);
}

/**
 * The daemon requires non-empty content; a photo on its own gets a stand-in line so it can still
 * be sent, the way you would text someone a picture with no caption.
 */
export function messageContent(draft: string, pending: readonly PendingAttachment[]): string {
  const text = draft.trim();
  if (text) return text;
  return toMessageAttachments(pending).length > 0 ? "(see attached image)" : "";
}

/** Why the `+` is greyed out, or null when attachments are possible. */
export function attachmentsBlockedReason(
  thread: { projectId: string | null } | undefined,
): string | null {
  if (!thread) return "Still loading this chat.";
  if (!thread.projectId) {
    return "Photos are saved into a project's sketches folder, and this chat has no project.";
  }
  return null;
}
