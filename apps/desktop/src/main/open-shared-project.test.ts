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

test("queues authenticated project intents without accepting credentials, arbitrary hosts or query data",()=>{
 const q=new OpenSharedProjectQueue(),id="13d40081-c953-42ce-bbed-a90e8eedf709";
 expect(q.offer(`fabplane://project/${id}`)).toEqual({projectId:id});expect(q.take()).toEqual({projectId:id});
 expect(q.offer(`https://app.fabplane.com/projects/${id}`)).toEqual({projectId:id});q.take();
 for(const url of [`fabplane://project/not-a-uuid`,`fabplane://project/${id}?token=secret`,`https://evil.test/projects/${id}`,`fabplane://user:pass@project/${id}`])expect(q.offer(url)).toBeNull();
});
