/** The error text of a run that did not finish normally, so a failed run says why instead of only showing its first frame. */
export function runFailureText(run?: { status: string; error: string | null }): string | null {
  if (!run) return null;
  if (run.status !== "failed" && run.status !== "timed_out" && run.status !== "interrupted") return null;
  return run.error?.trim() || `the run ended as ${run.status.replace("_", " ")} without an error message`;
}
