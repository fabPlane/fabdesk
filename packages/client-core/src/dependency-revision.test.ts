import { expect, test } from "bun:test";
import { dependenciesMatch } from "./dependency-revision";
const snapshot = { revision: "a".repeat(64), files: [], unresolved: [] };
test("dependency readers require a fresh daemon scan, including added files absent from old receipts", async () => {
  const readFileBlob = async () => new Blob();
  expect(await dependenciesMatch({ readFileBlob }, "p", snapshot)).toBe(false);
  const client = { readFileBlob, inspectOutputDependencies: async (_id: string, directory: string) => { expect(directory).toBe("member"); return { revision: "b".repeat(64) }; } };
  expect(await dependenciesMatch(client, "p", snapshot, "member/")).toBe(false);
  client.inspectOutputDependencies = async () => ({ revision: snapshot.revision });
  expect(await dependenciesMatch(client, "p", snapshot)).toBe(true);
});
