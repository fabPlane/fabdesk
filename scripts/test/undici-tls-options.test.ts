import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Test the Agent-to-Pool boundary where JSON cloning lost the callback. This
// deliberately does not claim to perform a real certificate handshake.
const source = String.raw`
const assert = require("node:assert/strict");
const http = require("node:http");
const { Agent, Pool, request } = require(process.argv[1]);
const option = process.argv[2];
const expected = new Error("test-only certificate rejection");
const checkServerIdentity = () => expected;
const supplied = { servername: "before", checkServerIdentity };
let captured;
const agent = new Agent({
  [option]: supplied,
  factory(origin, options) { captured = options[option]; return new Pool(origin, options); }
});
supplied.servername = "after";
const server = http.createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", async () => {
  try {
    const response = await request("http://127.0.0.1:" + server.address().port, { dispatcher: agent });
    assert.equal(await response.body.text(), "ok");
    assert.notEqual(captured, supplied);
    assert.equal(captured.servername, "before");
    assert.equal(captured.checkServerIdentity, checkServerIdentity);
    assert.equal(captured.checkServerIdentity(), expected);
    console.log("CALLBACK_PRESERVED");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await agent.close(); server.close(); }
});
`;

for (const parent of ["@electron/get", "node-gyp"]) {
  for (const option of ["tls", "connect"]) {
    test(`${parent}'s Agent preserves ${option} certificate checks`, async () => {
      const parentRequire = createRequire(require.resolve(parent));
      const entry = join(dirname(parentRequire.resolve("undici/package.json")), "index.js");
      const child = Bun.spawn(["node", "-e", source, entry, option], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("CALLBACK_PRESERVED");
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    }, 15_000);
  }
}
