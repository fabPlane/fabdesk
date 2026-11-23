import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Exercise Node's real HTTP/zlib streams in a child: the old parser can emit
// an unhandled decoder error after responding and terminate the entire server.
const source = String.raw`
const http = require("node:http");
const zlib = require("node:zlib");
const assert = require("node:assert/strict");
const parser = require(process.argv[1]).json();
const mode = process.argv[2];
let request;
const server = http.createServer((req, res) => {
  parser(req, res, error => {
    if (mode === "deflate" && req.url === "/attack") {
      // Downstream consumers must still receive the rest of the request.
      req.on("end", () => res.end(JSON.stringify(req.body)));
      request.end(Buffer.alloc(1024));
      return;
    }
    res.statusCode = error?.status || 200;
    res.end(error ? "rejected" : JSON.stringify(req.body));
  });
});
function post(path, body, encoding, charset = "utf-8", remaining = 0) {
  return new Promise((resolve, reject) => {
    request = http.request({
      hostname: "127.0.0.1", port: server.address().port, path, method: "POST", agent: false,
      headers: { "Content-Type": "application/json; charset=" + charset,
        "Content-Encoding": encoding, "Content-Length": body.length + remaining }
    }, res => {
      let result = "";
      res.setEncoding("utf8");
      res.on("data", part => result += part);
      res.on("end", () => resolve({ status: res.statusCode, result }));
    });
    request.on("error", reject);
    if (remaining) request.write(body); else request.end(body);
  });
}
server.listen(0, "127.0.0.1", async () => {
  try {
    const json = JSON.stringify({ board: "Pulse" });
    const compressed = mode === "deflate" ? zlib.deflateSync(json) : zlib.gzipSync(json);
    const body = Buffer.concat([compressed, Buffer.from([0]), ...(mode === "deflate" ? [] : [Buffer.alloc(100 * 1024, 0x58)])]);
    const attack = await post("/attack", body, mode === "deflate" ? "deflate" : "gzip",
      mode === "charset" ? "utf-999" : "utf-8", mode === "deflate" ? 1024 : 0);
    assert.equal(attack.status, mode === "charset" ? 415 : 200);
    if (mode !== "charset") assert.equal(attack.result, json);
    await new Promise(resolve => setTimeout(resolve, 200));
    // A malformed request must not break subsequent legitimate compressed JSON.
    assert.deepEqual(await post("/normal", zlib.gzipSync(json), "gzip"), { status: 200, result: json });
    console.log("SURVIVED_AND_PARSED");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { server.close(); }
});
`;

for (const mode of ["gzip", "charset", "deflate"]) {
  test(`body-parser survives trailing compressed bytes (${mode})`, async () => {
    const child = Bun.spawn(["node", "-e", source, require.resolve("body-parser"), mode], {
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
      expect(stdout).toContain("SURVIVED_AND_PARSED");
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 15_000);
}
