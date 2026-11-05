import type { QueryClient } from "@tanstack/react-query";

/** Retry mounted saved-file previews without refetching other projects or core endpoints. */
export function refreshProjectPreviews(queries: QueryClient, baseUrl: string, projectId: string) {
  return queries.refetchQueries({
    type: "active",
    predicate: query => {
      const key = query.queryKey;
      return key[0] === "file" && key[1] === projectId && key[3] === "blob" && key[4] === baseUrl;
    },
  }, { throwOnError: true });
}
