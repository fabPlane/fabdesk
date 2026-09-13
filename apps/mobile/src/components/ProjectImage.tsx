/**
 * A project file rendered as an image.
 *
 * `GET /projects/:id/files/*` takes the bearer in a header only, so the URL alone is not enough —
 * expo-image can carry headers, which is the one thing the desktop cannot do (it fetches a blob
 * instead, see packages/ui/src/chat/ProjectImage.tsx).
 */
import { Image } from "expo-image";
import type { ImageStyle, StyleProp } from "react-native";
import { useConnection } from "@/transport/CoreConnection";
import { useCoreClient } from "@fabdesk/client-core";

export function useProjectFileSource(projectId: string, path: string) {
  const client = useCoreClient();
  const { baseUrl, authHeaders } = useConnection();
  if (!baseUrl) return null;
  return { uri: client.fileUrl(projectId, path), headers: authHeaders };
}

export function ProjectImage({
  projectId,
  path,
  style,
  contentFit = "contain",
}: {
  projectId: string;
  path: string;
  style?: StyleProp<ImageStyle>;
  contentFit?: "contain" | "cover";
}) {
  const source = useProjectFileSource(projectId, path);
  if (!source) return null;
  return <Image source={source} style={style} contentFit={contentFit} transition={120} />;
}
