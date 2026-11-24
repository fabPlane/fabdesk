import { inspectStudioTemplate, localDraft, makeStudioCopperProject, MAX_STUDIO_TEMPLATE_BYTES, sha256Blob } from "@fabdesk/client-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type TemplateFile = { filename: string; bytes: Uint8Array };

async function describe(file: TemplateFile) {
  const summary = inspectStudioTemplate(file.bytes);
  const sha256 = await sha256Blob(new Blob([new Uint8Array(file.bytes)]));
  return { ...file, summary, sha256 };
}

/** Material files belong to the local workstation, including when its FabDesk core is remote. */
export function useStudioTemplate(lens: string, foilUm: string) {
  const foil = Number(foilUm);
  const stockKey = lens && Number.isFinite(foil) && foil > 0 ? `${lens}:${foil}` : "";
  const storageKey = `commarker-studio-template:${stockKey}`;
  const cache = useQueryClient();
  const saved = useQuery({
    queryKey: [storageKey],
    enabled: !!stockKey,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const file = await localDraft<TemplateFile>(storageKey);
      return file ? describe(file) : null;
    },
  });
  const change = useMutation({
    mutationFn: async (file: File | null) => {
      if (!stockKey) throw new Error("Select the lens and foil thickness first.");
      let attachment: Awaited<ReturnType<typeof describe>> | null = null;
      if (file) {
        if (!/\.orzr$/i.test(file.name)) throw new Error("Choose a project saved by ComMarker Studio (.orzr).");
        if (file.size > MAX_STUDIO_TEMPLATE_BYTES) throw new Error("Choose a smaller Studio project containing one filled graphic.");
        // Keep the qualified material locally without retaining the source board artwork.
        const { default: coupon } = await import("../../../../docs/examples/omni-x-copper-coupon-remove.svg?raw");
        const bytes = makeStudioCopperProject(coupon, new Uint8Array(await file.arrayBuffer()));
        attachment = await describe({ filename: file.name, bytes });
      }
      await localDraft<TemplateFile | null>(storageKey,
        attachment ? { filename: attachment.filename, bytes: attachment.bytes } : null);
      return { storageKey, attachment };
    },
    onSuccess: result => cache.setQueryData([result.storageKey], result.attachment),
  });
  return { stockKey, file: saved.data, loading: saved.isLoading, readFailed: saved.isError, change };
}
