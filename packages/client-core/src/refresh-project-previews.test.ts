import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { projectBlobQueryKey } from "./stable-project-blob";
import { refreshProjectPreviews } from "./refresh-project-previews";

test("refresh recovers failed mounted media without touching another project, endpoint or query kind", async () => {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let available = false;
  const calls = new Map<string, number>();
  const subscriptions: Array<() => void> = [];
  const watch = (id: string, key: readonly unknown[]) => {
    const observer = new QueryObserver(queries, { queryKey: key, queryFn: async () => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === "target" && !available) throw new Error("Temporary connection failure");
      return new Blob([id]);
    } });
    subscriptions.push(observer.subscribe(() => {}));
    return observer;
  };
  try {
    const target = watch("target", projectBlobQueryKey("core-a", "one", "renders/top.png"));
    await target.refetch();
    const otherProject = watch("other-project", projectBlobQueryKey("core-a", "two", "renders/top.png"));
    const otherCore = watch("other-core", projectBlobQueryKey("core-b", "one", "renders/top.png"));
    const otherKind = watch("other-kind", ["file", "one", "renders/top.png", "text", "core-a"]);
    await Promise.all([otherProject.refetch(), otherCore.refetch(), otherKind.refetch()]);
    expect(target.getCurrentResult().isError).toBe(true);
    const before = new Map(calls);
    available = true;
    await refreshProjectPreviews(queries, "core-a", "one");
    expect(target.getCurrentResult().isSuccess).toBe(true);
    expect(await target.getCurrentResult().data!.text()).toBe("target");
    expect(calls.get("target")).toBe(before.get("target")! + 1);
    for (const id of ["other-project", "other-core", "other-kind"]) expect(calls.get(id)).toBe(before.get(id) ?? 0);
    available = false;
    await expect(refreshProjectPreviews(queries, "core-a", "one")).rejects.toThrow("Temporary connection failure");
  } finally { subscriptions.forEach(unsubscribe => unsubscribe()); queries.clear(); }
});
