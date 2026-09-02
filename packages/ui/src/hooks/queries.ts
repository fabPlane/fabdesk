import type { Message } from "@fabdesk/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useCoreClient } from "../core/CoreProvider";
import { CoreHttpError, type CreateThreadInput, type PatchThreadInput } from "../core/CoreClient";
import { messagesKey } from "../core/CoreProvider";
import { useAuthStore } from "../stores/auth";

export function useProjects() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["projects"], queryFn: () => client.listProjects() });
}

export function useProject(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["project", projectId],
    queryFn: () => client.getProject(projectId!),
    enabled: !!projectId,
  });
}

export function useThreads(params?: { q?: string; projectId?: string | null }) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["threads", params?.q ?? "", params?.projectId ?? ""],
    queryFn: () => client.listThreads(params),
  });
}

export function useMessages(threadId: string | null) {
  const client = useCoreClient();
  return useQuery<Message[]>({
    queryKey: messagesKey(threadId ?? "__none__"),
    queryFn: () => client.listMessages(threadId!),
    enabled: !!threadId,
  });
}

export function useDoctor() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["doctor"], queryFn: () => client.doctor(), staleTime: 60_000 });
}

export function useSettings() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["settings"], queryFn: () => client.getSettings() });
}

export function usePatchSettings() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Parameters<typeof client.patchSettings>[0]) => client.patchSettings(patch),
    onSuccess: (data) => qc.setQueryData(["settings"], data),
  });
}

export function useAuthState() {
  const client = useCoreClient();
  const setState = useAuthStore((s) => s.setState);
  const q = useQuery({ queryKey: ["auth"], queryFn: () => client.authState(), staleTime: 10_000 });
  useEffect(() => {
    if (q.data) setState(q.data);
  }, [q.data, setState]);
  return q;
}

export function useToolManifest() {
  const client = useCoreClient();
  return useQuery({ queryKey: ["tools"], queryFn: () => client.toolManifest(), staleTime: 60_000 });
}

export function useJob(jobId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["job", jobId],
    queryFn: () => client.getJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === "queued" || s === "running" ? 1000 : false;
    },
  });
}

/** Text file from the project; `null` data when the file does not exist (404). */
export function useProjectText(projectId: string | null, path: string | null) {
  const client = useCoreClient();
  return useQuery<string | null>({
    queryKey: ["file", projectId, path, "text"],
    queryFn: async () => {
      try {
        return await client.readFile(projectId!, path!);
      } catch (e) {
        if (e instanceof CoreHttpError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!projectId && !!path,
  });
}

export function useProjectJson<T = unknown>(projectId: string | null, path: string | null) {
  const q = useProjectText(projectId, path);
  let data: T | null | undefined;
  let parseError: string | null = null;
  if (q.data === null) data = null;
  else if (typeof q.data === "string") {
    try {
      data = JSON.parse(q.data) as T;
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
      data = null;
    }
  }
  return { ...q, data, parseError };
}

/** Object URL for a binary project file, revoked on unmount. */
export function useProjectBlobUrl(projectId: string | null, path: string | null) {
  const client = useCoreClient();
  const q = useQuery<Blob | null>({
    queryKey: ["file", projectId, path, "blob"],
    queryFn: async () => {
      try {
        return await client.readFileBlob(projectId!, path!);
      } catch (e) {
        if (e instanceof CoreHttpError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!projectId && !!path,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(q.data);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [q.data]);
  return { ...q, url };
}

export function useThreadMutations() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["threads"] });
  const create = useMutation({
    mutationFn: (input: CreateThreadInput) => client.createThread(input),
    onSuccess: () => void invalidate(),
  });
  const patch = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PatchThreadInput }) => client.patchThread(id, patch),
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteThread(id),
    onSuccess: () => void invalidate(),
  });
  return { create, patch, remove };
}
