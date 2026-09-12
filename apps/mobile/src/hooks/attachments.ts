/**
 * Photos for the next message: pick (camera or library), upload straight away as a project sketch,
 * keep the local uri for the thumbnail and the stored path for the send.
 *
 * Uploading on pick rather than on send is what the desktop's SketchPad does, and it means the
 * Send button knows before it is tapped whether everything is on the computer.
 */
import { useUploadSketch } from "@fabdesk/client-core";
import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { preflightImage, type PendingAttachment } from "@/lib/attachments";

export type AttachmentSource = "camera" | "library";

export function useAttachments(projectId: string | null | undefined) {
  const upload = useUploadSketch();
  const [pending, setPending] = useState<PendingAttachment[]>([]);

  const update = (key: string, patch: Partial<PendingAttachment>) =>
    setPending((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));

  const pick = useCallback(
    async (source: AttachmentSource) => {
      if (!projectId) return;
      const perm =
        source === "camera"
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          source === "camera" ? "Camera access is off" : "Photo access is off",
          "Allow it for fabPlane in the phone's Settings to attach photos.",
        );
        return;
      }
      // quality < 1 makes iOS re-encode HEIC as JPEG, which is the only way the daemon takes it.
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 0.85 };
      const result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync(opts)
          : await ImagePicker.launchImageLibraryAsync({ ...opts, allowsMultipleSelection: true });
      if (result.canceled) return;

      for (const asset of result.assets) {
        const check = preflightImage(asset);
        if (!check.ok) {
          Alert.alert("Cannot attach", check.reason);
          continue;
        }
        const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        setPending((list) => [
          ...list,
          { key, localUri: asset.uri, mime: check.mime, name: check.name },
        ]);
        upload
          .mutateAsync({
            projectId,
            file: { uri: asset.uri, name: check.name, type: check.mime },
            name: check.name,
          })
          .then(({ path }) => update(key, { path }))
          .catch((e: unknown) =>
            update(key, { error: e instanceof Error ? e.message : String(e) }),
          );
      }
    },
    [projectId, upload],
  );

  const remove = useCallback(
    (key: string) => setPending((list) => list.filter((a) => a.key !== key)),
    [],
  );
  const clear = useCallback(() => setPending([]), []);
  /** Puts a batch back after a failed send, so a retry does not mean re-picking. */
  const restore = useCallback((list: PendingAttachment[]) => setPending(list), []);

  return { pending, pick, remove, clear, restore };
}
