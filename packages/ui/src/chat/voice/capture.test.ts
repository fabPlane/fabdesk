import { describe, expect, test } from "bun:test";
import { createVoiceCapture } from "./capture";

describe("voice capture", () => {
  test("cancel during getUserMedia stops the stream that arrives later", async () => {
    let stopped = 0;
    const track = { stop: () => {
      stopped += 1;
    } };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let release: (media: MediaStream) => void = () => undefined;
    const gum = () =>
      new Promise<MediaStream>((resolve) => {
        release = resolve;
      });
    const capture = createVoiceCapture(
      {
        onLevel: () => undefined,
        onPartial: () => undefined,
        onError: () => undefined,
      },
      { getUserMedia: gum },
    );
    const started = capture.start("en");
    capture.cancel();
    release(stream);
    await started;
    expect(stopped).toBe(1);
  });
});
