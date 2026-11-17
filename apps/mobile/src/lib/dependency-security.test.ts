import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shellQuote = require("shell-quote");
const forge = require("node-forge");

test.each(["\n", "\r", "\u2028", "\u2029"])("shell quoting rejects line terminators after a comment: %j", separator => {
  // Only quote/parse strings; no shell command is executed by this regression.
  expect(() => shellQuote.quote(["echo", { comment: "note" }, `value${separator}unexpected-command`])).toThrow(TypeError);
  expect(shellQuote.parse(shellQuote.quote(["echo", "ordinary argument"]))).toEqual(["echo", "ordinary argument"]);
});

test("a malformed TLS fragment reports a protocol error without crashing the caller", () => {
  const errors: string[] = [];
  const connection = forge.tls.createConnection({
    server: true,
    connected() {}, tlsDataReady() {}, dataReady() {}, closed() {},
    error(_connection: unknown, error: { message: string }) { errors.push(error.message); },
  });
  const records = forge.util.hexToBytes("160301000601000010030115030100020228");
  expect(() => connection.process(records)).not.toThrow();
  expect(errors).toContain("Invalid fragmented record.");
});

test("query-string decodes links through the patched ESM decoder", () => {
  const query = require("query-string");
  const parsed = query.parse("name=board%20one&symbol=%F0%9F%9B%A0&malformed=%E0%A4%A");
  expect(parsed.name).toBe("board one");
  expect(parsed.symbol).toBe("🛠");
  expect(typeof parsed.malformed).toBe("string");
});

test("Metro reads image dimensions from file bytes with patched image-size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobile-metro-image-"));
  try {
    const file = join(dir, "pixel.png");
    await writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4h8AAAAASUVORK5CYII=", "base64"));
    const { getAssetData } = require(join(import.meta.dir, "../../node_modules/metro/src/Assets.js"));
    const asset = await getAssetData(file, "pixel.png", [], "android", "/assets");
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.files).toEqual([file]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("CSS source-map comments cannot load an unrequested local file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mobile-css-map-"));
  try {
    const file = join(dir, "outside.map");
    await writeFile(file, JSON.stringify({ version: 3, sources: ["synthetic-external.css"], names: [], mappings: "" }));
    const result = require("postcss")().process(`a{color:red}\n/*# sourceMappingURL=${file} */`, { from: undefined }).sync();
    expect(result.root.source.input.map).toBeUndefined();
    expect(result.css).toContain("color:red");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("patched Markdown tokens retain the native renderer AST and reject unsafe content", () => {
  const MarkdownIt = require("markdown-it");
  const tokensToAST = require("react-native-markdown-display/src/lib/util/tokensToAST").default;
  const parser = new MarkdownIt({ typographer: true });
  type Node = { type: string; attributes: Record<string, string>; children: Node[] };
  const flatten = (nodes: Node[]): Node[] => nodes.flatMap(node => [node, ...flatten(node.children)]);
  const nodes = flatten(tokensToAST(parser.parse("# Board\n\n**Ready** [project](https://example.com)\n\n| Ref | Value |\n| --- | --- |\n| R1 | 1k |\n\n```ts\nconst ready = true;\n```", {})));
  expect(nodes.some(node => node.type === "heading1")).toBe(true);
  expect(nodes.some(node => node.type === "strong")).toBe(true);
  expect(nodes.some(node => node.type === "table")).toBe(true);
  expect(nodes.some(node => node.type === "fence")).toBe(true);
  expect(nodes.find(node => node.type === "link")?.attributes.href).toBe("https://example.com");
  expect(parser.render("[unsafe](javascript:alert(1))")).not.toContain('href="javascript:');
  expect(parser.render("<img src=x onerror=alert(1)>")).toContain("&lt;img");
});
