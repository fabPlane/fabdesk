import { useCore } from "@fabdesk/client-core";
import { useQuery } from "@tanstack/react-query";

export function useNativeSpeech(language: string) {
  const { host } = useCore();
  const service = host.nativeSpeech;
  const query = useQuery({
    queryKey: ["native-speech", host.platform, language],
    queryFn: () => service ? service.status(language) : Promise.resolve({ available: false, message: "", needsDownload: false }),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  return { service, available: query.data?.available === true, message: query.data?.message ?? "", needsDownload: query.data?.needsDownload === true, checking: query.isPending };
}
