import { useState } from "react";
import { Button, Dialog } from "../components/ui";
import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useUiStore } from "../stores/ui";

type View = "share" | "sync" | "history";
const TITLES: Record<View, string> = { share: "Share for review", sync: "KiCad push / pull", history: "Recovery & history" };

/** Structural home for pending integrations. No publication, remote sync or general undo is implemented here. */
export function HostedReviewTools({ projectId }: { projectId: string }) {
  const [view, setView] = useState<View | null>(null);
  const openLocal = (tab: "files" | "diff") => {
    if (useUiStore.getState().activeProjectId !== projectId) return;
    setView(null); useUiStore.getState().setBoardTab(tab);
  };
  return <>
    <WorkspaceMenu className="fd-review-publishing" label={<><span>Publish & sync</span><Icon name="chevronDown" width={14} height={14} /></>}>
      <div className="fd-menu-caption">Review integrations</div>
      {(["share", "sync", "history"] as const).map(item => <button key={item} onClick={() => setView(item)}>{TITLES[item]}</button>)}
      <p className="fd-menu-caption">Hosted sharing, sync and full undo are not connected in this build.</p>
    </WorkspaceMenu>
    <Dialog open={view !== null} onClose={() => setView(null)} title={view ? TITLES[view] : "Review integrations"} className="fd-review-integration-dialog">
      <div className="fd-review-integration-status" role="status">Integration pending</div>
      {view === "share" ? <section><h3>Share a review link</h3><p>Hosted review links and access controls are not connected in this build. You can review local changes and saved files here.</p><Button disabled>Share review link</Button></section> : view === "sync" ? <>
        <section><h3>Push reviewed changes</h3><p>Review the exact files and revision before publishing. Hosted project status and push review are not connected yet.</p><Button disabled>Review changes to push</Button></section>
        <section><h3>Preview incoming changes</h3><p>Inspect additions, replacements and deletions before choosing a pull. Remote revisions and the pull preview are not connected yet.</p><Button disabled>Preview pull</Button></section>
      </> : <section><h3>Recover a change</h3><p>General undo history is not connected yet. Saved revision comparisons remain available. Native position and board-size tools offer their own limited revert when an eligible saved edit exists.</p><Button disabled>Open undo history</Button></section>}
      <div className="fd-review-integration-actions"><Button size="sm" onClick={() => openLocal("diff")}>Review local changes</Button><Button size="sm" variant="ghost" onClick={() => openLocal("files")}>Browse project files</Button></div>
      <p className="fd-review-integration-note">Opening this panel does not publish, pull, restore or modify project files.</p>
    </Dialog>
  </>;
}
