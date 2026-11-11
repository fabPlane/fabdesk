/** A router result can exist and still be refused by the board checks; that is not the router being unavailable. */
export function runFailureNotice(run: { status: string; candidate?: { available?: boolean } | null } | undefined, routerDisabled: boolean): { title: string; hint: string } {
  if (run?.status === "timed_out") return { title: "Routing timed out", hint: routerDisabled ? "This router is currently unavailable." : "Review the saved result and board constraints before trying again." };
  if (run?.status === "failed" && run.candidate?.available) return { title: "Routing result not applied", hint: "The router finished, but its result failed the board checks. Review the result and board constraints before trying again." };
  return { title: "Routing stopped", hint: routerDisabled ? "This router is currently unavailable." : "Review the saved result and board constraints before trying again." };
}

/** The error text of a run that did not finish normally, so a failed run says why instead of only showing its first frame. */
export function runFailureText(run?: { status: string; error: string | null }): string | null {
  if (!run) return null;
  if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "interrupted") return null;
  return run.error?.trim() || `the run ended as ${run.status.replace("_", " ")} without an error message`;
}
