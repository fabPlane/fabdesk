import { describe, expect, test } from "bun:test";
import { IpcCallError, type IpcCallResult, type KiCadClient } from "@fp-pcb/client";
import { directIpcCall, directIpcDescribe, directIpcSearch, type DirectIpcConnection } from "./ipc-cli";

const connection = (closed: { value: boolean }): DirectIpcConnection => ({
  client: {} as KiCadClient,
  session: {
    id: "direct-test",
    socketPath: "/tmp/kicad/direct-test.sock",
    kicadToken: "direct-token",
    kicadVersion: "10.99.0-test",
  },
  close: async () => {
    closed.value = true;
  },
});

const versionResult: IpcCallResult = {
  operation: "GetVersion",
  requestType: "kiapi.common.commands.GetVersion",
  responseType: "kiapi.common.commands.GetVersionResponse",
  response: { version: { fullVersion: "10.99.0-test" } },
  catalog: {
    version: "direct-kicad-ipc/1.0.0",
    sha256: "a".repeat(64),
    schemaSha256: "b".repeat(64),
    operationSchemaSha256: "c".repeat(64),
  },
};

describe("direct IPC CLI contract", () => {
  test("searches and describes the generated catalog without a live service", () => {
    const search = directIpcSearch({ objectType: "footprint", headless: "ok", limit: 100 }) as any;
    expect(search.ok).toBe(true);
    expect(search.catalog.version).toBe("direct-kicad-ipc/1.0.0");
    expect(search.catalog.sha256).toHaveLength(64);
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.every((entry: any) => entry.headless === "ok")).toBe(true);

    const description = directIpcDescribe("GetBoardOrigin", 3) as any;
    expect(description.ok).toBe(true);
    expect(description.requestType).toBe("kiapi.board.commands.GetBoardOrigin");
    expect(description.responseSchema.fields.find((field: any) => field.name === "xNm")?.units).toBe("nanometres");
    expect(description.requestExample).toBeDefined();
  });

  test("calls through a direct connection and returns transport/session/schema identity", async () => {
    const closed = { value: false };
    const result = (await directIpcCall(
      { operation: "GetVersion", request: {} },
      {
        connect: async () => connection(closed),
        callOperation: async () => versionResult,
      },
    )) as any;
    expect(result.ok).toBe(true);
    expect(result.transport).toEqual({ kind: "nng-ipc", socketPath: "/tmp/kicad/direct-test.sock" });
    expect(result.session.kicadToken).toBe("direct-token");
    expect(result.schema.operationSha256).toHaveLength(64);
    expect(result.response.version.fullVersion).toBe("10.99.0-test");
    expect(closed.value).toBe(true);
  });

  test("fails closed on stale revisions and distinguishes caller failures", async () => {
    const staleClosed = { value: false };
    const stale = (await directIpcCall(
      {
        operation: "GetDocumentRevision",
        request: { document: { type: "DOCTYPE_PCB", boardFilename: "board.kicad_pcb" } },
        projectDir: "/tmp/direct-ipc-project",
        expectedDocumentRevision: 4,
      },
      {
        connect: async () => connection(staleClosed),
        exists: async () => true,
        readFile: async () => new TextEncoder().encode("board"),
        readRevision: async () => 5,
        callOperation: async () => {
          throw new Error("must not call a stale document");
        },
      },
    )) as any;
    expect(stale.ok).toBe(false);
    expect(stale.failure).toMatchObject({ code: "stale_document", detail: { expected: 4, actual: 5 } });
    expect(stale.document.beforeSha256).toHaveLength(64);
    expect(staleClosed.value).toBe(true);

    const failed = (await directIpcCall(
      { operation: "GetVersion", request: {} },
      {
        connect: async () => connection({ value: false }),
        callOperation: async () => {
          throw new IpcCallError("invalid_schema", "bad request", { requestType: "GetVersion" });
        },
      },
    )) as any;
    expect(failed.failure).toMatchObject({ code: "invalid_schema", detail: { requestType: "GetVersion" } });
    expect((directIpcDescribe("not-an-operation") as any).failure.code).toBe("unknown_operation");
  });
});
