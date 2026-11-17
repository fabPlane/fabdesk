import { expect, test } from "bun:test";

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
