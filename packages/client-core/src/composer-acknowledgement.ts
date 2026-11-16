/** A send may finish after the user edits its draft or switches conversations. */
export function acknowledgeComposerDraft<A, C>(
  current: { text: string; attachments: readonly A[]; contexts: readonly C[] },
  submitted: { text: string; attachments: readonly A[]; contexts: readonly C[] },
) {
  return {
    text: current.text === submitted.text ? "" : current.text,
    // Identity matters: removing and reattaching the same path is a new draft item.
    attachments: current.attachments.filter(item => !submitted.attachments.includes(item)),
    contexts: current.contexts.filter(item => !submitted.contexts.includes(item)),
  };
}
