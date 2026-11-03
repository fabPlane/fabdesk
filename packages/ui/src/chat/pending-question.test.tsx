import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CoreClient, CoreProvider, nullHost } from "@fabdesk/client-core";
import type { QuestionPart } from "@fabdesk/protocol";
import { PendingQuestionCard } from "./PendingRequestCard";

const client = new CoreClient({ baseUrl: "http://test.invalid", token: "test" });
const render = (part: QuestionPart) =>
  renderToStaticMarkup(
    <CoreProvider client={client} host={nullHost}>
      <PendingQuestionCard threadId="t" part={part} />
    </CoreProvider>,
  );
const part: QuestionPart = {
  type: "question",
  requestId: "q",
  question: "Connect to what?",
  options: ["USB", "Serial port"],
  answer: null,
};

test("choices are accessible radios with an explicit submit and no default answer", () => {
  const html = render(part);
  expect(html.match(/type="radio"/g)).toHaveLength(3);
  expect(html).toContain("<legend");
  expect(html).toContain("Write my own answer");
  expect(html).toContain("Waiting for your answer");
  expect(html).toMatch(/type="submit"[^>]*disabled=""/);
  expect(html).not.toContain("checked=");
});

test("questions without suggestions show a labelled multiline answer field", () => {
  const html = render({ ...part, options: [] });
  expect(html).toContain("<textarea");
  expect(html).toContain("Your answer");
  expect(html).not.toContain('type="radio"');
});

test("answers survive history rendering and closed questions never look answered", () => {
  const answered = render({ ...part, answer: "My custom connector" });
  expect(answered).toContain("Answer submitted");
  expect(answered).toContain("My custom connector");
  expect(answered).not.toContain("<form");
  expect(answered).not.toContain("Answer in chat");
  const closed = render({ ...part, answer: "" });
  expect(closed).toContain("Question closed without an answer");
  expect(closed).not.toContain("Answer submitted");
  expect(closed).toContain("Answer in chat");
  expect(closed).not.toContain("<form");
});
