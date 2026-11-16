import { expect, test } from "bun:test";
import { acknowledgeComposerDraft } from "./composer-acknowledgement";

test("accepted messages clear only their original draft items", () => {
  const submitted = { text: "Inspect R1", attachments: [{ path: "board.png" }], contexts: [{ sourceKey: "board-a" }] };
  expect(acknowledgeComposerDraft(submitted, submitted)).toEqual({ text: "", attachments: [], contexts: [] });
  const replacement = { path: "board.png" }, context = { sourceKey: "board-b" };
  const edited = { text: "Also inspect C1", attachments: [submitted.attachments[0]!, replacement], contexts: [submitted.contexts[0]!, context] };
  expect(acknowledgeComposerDraft(edited, submitted)).toEqual({ text: "Also inspect C1", attachments: [replacement], contexts: [context] });
});

test("delayed acceptance preserves edits made while another chat is open", async () => {
  const attachment = { path: "a.png" }, nextAttachment = { path: "next.png" };
  const sent = { text: "First question", attachments: [attachment], contexts: [] as object[] };
  const drafts = { a: sent, b: { text: "Other chat's unsent question", attachments: [], contexts: [] } };
  let accept!: () => void;
  const request = new Promise<void>(resolve => { accept = resolve; });
  const completion = request.then(() => { drafts.a = acknowledgeComposerDraft(drafts.a, sent); });
  drafts.a = { ...sent, text: "Next question", attachments: [attachment, nextAttachment] };
  accept(); await completion;
  expect(drafts.a).toEqual({ text: "Next question", attachments: [nextAttachment], contexts: [] });
  expect(drafts.b.text).toBe("Other chat's unsent question");
});
