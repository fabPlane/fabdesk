import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const childSource = String.raw`
const net = require("node:net");
const { fetch, Client } = require(process.argv[1]);
const server = net.createServer(socket => {
  socket.once("data", () => socket.end(
    "HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n"
  ));
});
server.listen(0, "127.0.0.1", async () => {
  const url = "http://127.0.0.1:" + server.address().port;
  const client = new Client(url);
  try {
    await fetch(url, { dispatcher: client });
    process.exitCode = 2;
  } catch (error) {
    if (!error.cause?.message.includes("content-encoding")) throw error;
    console.log("FETCH_REJECTED");
  }
  // Give an orphaned stream's late error time to surface after fetch rejection.
  await new Promise(resolve => setTimeout(resolve, 100));
  await client.close();
  server.close(() => console.log("SURVIVED"));
});
`;

// Make the late transport error deterministic as well: TCP close ordering can
// hide the vulnerable path on some operating systems.
const lateErrorSource = String.raw`
const { fetch, errors } = require(process.argv[1]);
let aborted = false;
const dispatcher = {
  dispatch(options, handler) {
    handler.onConnect(error => { aborted = true; handler.onError(error); });
    queueMicrotask(() => {
      handler.onHeaders(200, [
        Buffer.from("content-encoding"), Buffer.from("gzip,gzip,gzip,gzip,gzip,gzip"),
        Buffer.from("content-length"), Buffer.from("1")
      ], () => {}, "OK");
      if (!aborted) handler.onError(new errors.ResponseContentLengthMismatchError());
    });
    return true;
  }
};
(async () => {
  try { await fetch("http://localhost/", { dispatcher }); process.exitCode = 2; }
  catch (error) {
    if (!error.cause?.message.includes("content-encoding")) throw error;
    console.log("FETCH_REJECTED");
  }
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log("SURVIVED");
})();
`;

// Test each installed major in Node, where an unhandled stream error is fatal.
// A subprocess keeps the vulnerable-version reproduction from killing Bun.
for (const parent of ["@electron/get", "node-gyp"]) {
  for (const [name, source] of [
    ["truncated TCP response", childSource],
    ["late transport error", lateErrorSource],
  ] as const) {
    test(`${parent}'s Undici survives excessive encodings and ${name}`, async () => {
      const parentRequire = createRequire(require.resolve(parent));
      // Bun treats bare "undici" as a built-in. Resolve its package manifest to
      // ensure the Node child exercises this parent's actual installed major.
      const entry = join(dirname(parentRequire.resolve("undici/package.json")), "index.js");
      const child = Bun.spawn(["node", "-e", source, entry], { stdout: "pipe", stderr: "pipe" });
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(stdout).toContain("FETCH_REJECTED");
        expect(stdout).toContain("SURVIVED");
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    }, 15_000);
  }
}
