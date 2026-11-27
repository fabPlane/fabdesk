import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import test from "node:test";
import { identifyController, makeIdentificationRequest, parseIdentificationReply } from "./omni-x-identify.mjs";

// Synthetic reply for a loopback peer. No bytes were captured from a real laser.
const peer = "127.0.0.1";
const requestBytes = "feff00148000f013000000000000000000000003";
const reply = Buffer.alloc(36);
reply.set([0xfe, 0xff, 0, 36, 0x80, 0, 0xf0, 0x13]);
reply.set([127, 0, 0, 1], 10);
reply.set([0x02, 0xab, 0xcd, 0x12, 0x34, 0x56], 22);
reply[35] = 0x03;
const identity = { address: peer, mac: "02:ab:cd:12:34:56" };

test("uses the vendor identification request and reads the replying interface", () => {
  assert.equal(makeIdentificationRequest().toString("hex"), requestBytes);
  assert.deepEqual(parseIdentificationReply(reply, peer), identity);
  assert.equal(parseIdentificationReply(Buffer.from(requestBytes, "hex"), peer), null);
  assert.equal(parseIdentificationReply(reply, "127.0.0.2"), null);
  assert.equal(parseIdentificationReply(reply.subarray(0, 27), peer), null);
  for (const index of [0, 3, 7, 35]) {
    const damaged = Buffer.from(reply);
    damaged[index] ^= 1;
    assert.equal(parseIdentificationReply(damaged, peer), null);
  }
});

test("identifies a simulated controller and releases the socket after a timeout", async () => {
  const server = createSocket("udp4");
  const listening = once(server, "listening");
  server.bind(2000, peer);
  await listening;
  let count = 0;
  try {
    server.on("message", (data, remote) => {
      count++;
      assert.equal(remote.address, peer);
      assert.equal(remote.port, 2378);
      assert.equal(data.toString("hex"), requestBytes);
      if (count !== 2) server.send(reply, remote.port, remote.address);
    });
    const options = { address: peer, localAddress: peer, timeoutMs: 1000 };
    assert.deepEqual(await identifyController(options), identity);
    await assert.rejects(identifyController({ ...options, timeoutMs: 200 }), /timed?\s*out|timeout|no.*reply/i);
    assert.deepEqual(await identifyController(options), identity);
    assert.equal(count, 3);
  } finally {
    server.close();
  }
});
