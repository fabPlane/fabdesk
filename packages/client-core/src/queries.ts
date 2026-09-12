import type { Message, OrderVendorId, ProjectSummary } from "@fabdesk/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useCoreClient } from "./provider";
import { messagesKey } from "./events";
import { CoreHttpError, type CreateThreadInput, type PatchThreadInput } from "./CoreClient";
import { useAuthStore } from "./stores/auth";

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

export function useOpenCatalog(q = "") {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["opensource", q],
    queryFn: () => client.listOpenSource(q),
    staleTime: 60_000,
  });
}

export function useOpenSourceProject(id: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["opensource", "project", id],
    queryFn: () => client.getOpenSource(id!),
    enabled: !!id,
  });
}

export function useProjectOrder(projectId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["project-order", projectId],
    queryFn: () => client.projectOrder(projectId!),
    enabled: !!projectId,
  });
}

export function useStartOrder() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, vendor }: { projectId: string; vendor: OrderVendorId }) => client.startOrder(projectId, vendor),
    onSuccess: (_data, vars) => void qc.invalidateQueries({ queryKey: ["project-order", vars.projectId] }),
  });
}

export function useRemixOpenSource() {
  const client = useCoreClient();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.remixOpenSource(id),
    onSuccess: (result) => {
      qc.setQueryData<ProjectSummary[]>(["projects"], (old) => {
        const next = old ?? [];
        if (next.some((p) => p.id === result.project.id)) return next;
        return [result.project, ...next];
      });
      qc.setQueryData(["project", result.project.id], result.project);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      void qc.invalidateQueries({ queryKey: ["project", result.project.id] });
      void qc.invalidateQueries({ queryKey: ["file", result.project.id] });
    },
  });
}

export function useThreads(params?: { q?: string; projectId?: string | null }) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["threads", params?.q ?? "", params?.projectId ?? ""],
    queryFn: () => client.listThreads(params),
  });
}

export function useThread(threadId: string | null) {
  const client = useCoreClient();
  return useQuery({
    queryKey: ["thread", threadId],
    queryFn: () => client.getThread(threadId!),
    enabled: !!threadId,
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

export function useThreadMutations() {
  const client = useCoreClient();
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["threads"] });
    void qc.invalidateQueries({ queryKey: ["thread"] });
  };
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
