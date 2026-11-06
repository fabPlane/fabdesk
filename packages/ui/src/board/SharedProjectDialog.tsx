import { useQuery } from "@tanstack/react-query";
import { useAuthStore, useCore } from "@fabdesk/client-core";
import { sharedProjectUrl } from "@fabdesk/protocol";
import { Button, Dialog, Spinner } from "../components/ui";
import { SharedProjectContent } from "./SharedProjectContent";
import "./project-sharing.css";

/** Public snapshots are never imported into the local project's editable state. */
export function SharedProjectDialog({
  shareId,
  onClose,
}: {
  shareId: string;
  onClose: () => void;
}) {
  const { client, host } = useCore();
  const appOrigin = useAuthStore((s) => s.state?.dashboardUrl);
  const result = useQuery({
    queryKey: ["shared-project", client.baseUrl, shareId],
    queryFn: () => client.getSharedProject(shareId),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 60_000,
  });
  return (
    <Dialog open onClose={onClose} title="Shared project" className="fd-shared-project-dialog">
      {result.isPending ? (
        <p role="status">
          <Spinner />
          Opening shared project…
        </p>
      ) : result.isError ? (
        <div role="alert">
          <h2>Shared project unavailable</h2>
          <p className="fd-share-muted">
            This link may have been disabled, or the sharing service is unavailable. Check the link
            or try again.
          </p>
          <Button onClick={() => void result.refetch()}>Try again</Button>
        </div>
      ) : (
        <>
          <p className="fd-share-muted">
            Published {new Date(result.data.publishedAt).toLocaleString()} · revision{" "}
            {result.data.revision}
          </p>
          <SharedProjectContent snapshot={result.data.snapshot} />
        </>
      )}
      <footer className="fd-share-footer">
        <Button
          variant="ghost"
          onClick={() => {
            void host.openExternal(sharedProjectUrl(shareId, appOrigin));
          }}
        >
          Open in browser
        </Button>
        <Button onClick={onClose}>Done</Button>
      </footer>
    </Dialog>
  );
}
