import { expect, test } from "bun:test";
import { OpenSharedProjectQueue } from "./open-shared-project";
test("queues a share through cold startup and ignores unrelated catalog arguments", () => {
  const queue = new OpenSharedProjectQueue();
  expect(queue.offer(["--foo", "fabplane://share/share_0123456789abcdef"])).toEqual({
    shareId: "share_0123456789abcdef",
  });
  expect(queue.offer("fabplane://open?catalog=foostan/crkbd")).toBeNull();
  expect(queue.take()).toEqual({ shareId: "share_0123456789abcdef" });
  expect(queue.take()).toBeNull();
});
