import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const source = String.raw`
const assert = require("node:assert/strict");
const http = require("node:http");
const { Agent, interceptors, cacheStores } = require(process.argv[1]);
const mode = process.argv[2];
let redirect = true, hits = 0;
const other = http.createServer((req, res) => {
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.end("other-origin");
});
const origin = http.createServer((req, res) => {
  hits++;
  if (req.url === "/resource" && redirect) {
    res.statusCode = 302;
    res.setHeader("Location", mode === "cross" ? "http://127.0.0.1:" + other.address().port + "/target" : "/target");
    if (mode === "private") res.setHeader("Cache-Control", "private, no-store");
    res.end();
  } else if (req.url === "/target") {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(mode === "private" ? "private-object" : "public-object");
  } else {
    res.setHeader("Cache-Control", "no-store");
    res.end(mode === "private" ? "denied" : "fresh-origin");
  }
});
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
(async () => {
  await Promise.all([listen(origin), listen(other)]);
  const agent = new Agent().compose(interceptors.redirect({ maxRedirections: 2 }),
    interceptors.cache({ type: "shared", store: new cacheStores.MemoryCacheStore() }));
  const read = async headers => {
    const response = await agent.request({ origin: "http://127.0.0.1:" + origin.address().port,
      path: mode === "public" ? "/target" : "/resource", method: "GET", headers });
    return response.body.text();
  };
  try {
    assert.equal(await read(mode === "private" ? { authorization: "Bearer not-a-secret:test-fixture" } : {}),
      mode === "cross" ? "other-origin" : mode === "private" ? "private-object" : "public-object");
    redirect = false;
    const before = hits;
    const second = await read({});
    assert.equal(second, mode === "cross" ? "fresh-origin" : mode === "private" ? "denied" : "public-object");
    assert.equal(hits, mode === "public" ? before : before + 1);
    console.log("CACHE_ISOLATED");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { await agent.close(); origin.close(); other.close(); }
})();
`;

for (const mode of ["cross", "private", "public"]) {
  test(`Undici redirect cache preserves ${mode} response boundaries`, async () => {
    const parentRequire = createRequire(require.resolve("@electron/get"));
    const entry = join(dirname(parentRequire.resolve("undici/package.json")), "index.js");
    const child = Bun.spawn(["node", "-e", source, entry, mode], {
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
      expect(stdout).toContain("CACHE_ISOLATED");
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }, 15_000);
}
