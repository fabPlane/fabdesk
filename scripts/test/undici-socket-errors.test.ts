import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Inject the error Node emits after failed TLS renegotiation into an established
// connection. This covers the fatal HTTP/1 and HTTP/2 handlers, not a TLS handshake.
const source = String.raw`
const assert = require("node:assert/strict");
const net = require("node:net");
const http = require("node:http");
const http2 = require("node:http2");
const { Client } = require(process.argv[1]);
const h2 = process.argv[2] === "h2";
let socket;
const server = h2 ? http2.createServer() : http.createServer();
server.on(h2 ? "stream" : "request", incoming => {
  incoming.on("error", () => {});
  const error = Object.assign(new Error("test-only post-connect certificate mismatch"), {
    code: "ERR_TLS_CERT_ALTNAME_INVALID"
  });
  socket.destroy(error);
});
if (h2) server.on("session", session => session.on("error", () => {}));
server.listen(0, "127.0.0.1", async () => {
  const client = new Client("https://localhost:" + server.address().port, {
    allowH2: h2,
    connect(options, callback) {
      socket = net.connect(server.address().port, "127.0.0.1");
      socket.alpnProtocol = h2 ? "h2" : "http/1.1";
      socket.once("connect", () => callback(null, socket));
    }
  });
  try {
    await assert.rejects(client.request({ path: "/", method: "GET" }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    await new Promise(resolve => setTimeout(resolve, 100));
    console.log("REJECTED_WITHOUT_CRASH");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await client.destroy(); server.close(); }
});
`;

for (const parent of ["@electron/get", "node-gyp"]) {
  for (const protocol of ["http/1.1", "h2"]) {
    test(`${parent}'s ${protocol} client handles a post-connect certificate error`, async () => {
      const parentRequire = createRequire(require.resolve(parent));
      const entry = join(dirname(parentRequire.resolve("undici/package.json")), "index.js");
      const child = Bun.spawn(
        ["node", "--disable-warning=UNDICI-H2", "-e", source, entry, protocol],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("REJECTED_WITHOUT_CRASH");
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    }, 15_000);
  }
}
