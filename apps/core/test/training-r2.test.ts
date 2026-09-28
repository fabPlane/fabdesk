import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Store, openDatabase } from "../src/db";
import { TrainingArchive } from "../src/training-archive";
import { R2ArchiveWriter, r2ArchiveConfig } from "../src/training-r2";

const env = {
  FABDESK_TRAINING_R2_ENABLED: "1",
  FABDESK_TRAINING_R2_ACCOUNT_ID: "a".repeat(32),
  FABDESK_TRAINING_R2_BUCKET: "private-training",
  FABDESK_TRAINING_R2_ACCESS_KEY_ID: "access",
  FABDESK_TRAINING_R2_SECRET_ACCESS_KEY: "secret",
  FABDESK_TRAINING_R2_PREFIX: "team/fabdesk",
};

describe("R2 training archive", () => {
  test("requires explicit opt-in and complete configuration", () => {
    expect(r2ArchiveConfig({ ...env, FABDESK_TRAINING_R2_ENABLED: "0" })).toBeNull();
    expect(() => r2ArchiveConfig({ ...env, FABDESK_TRAINING_R2_BUCKET: "" })).toThrow();
    expect(r2ArchiveConfig(env)).toMatchObject({
      bucket: "private-training",
      prefix: "team/fabdesk",
    });
  });

  test("uploads the conversation and dump under the configured private key prefix", async () => {
    const config = r2ArchiveConfig(env)!;
    const uploads: Array<{
      Bucket?: string;
      Key?: string;
      Body?: Uint8Array;
      ContentMD5?: string;
    }> = [];
    const writer = new R2ArchiveWriter(config, async (input) => {
      uploads.push(input as (typeof uploads)[number]);
    });
    const store = new Store(openDatabase(":memory:"));
    try {
      const thread = store.threads.create({ agentId: "codex", title: "Board" });
      store.threads.addMessage({ threadId: thread.id, role: "user", contentMd: "Route the board" });
      await new TrainingArchive(writer).put(
        {
          runId: "run_1",
          traceId: "trace_1",
          threadId: thread.id,
          agentId: "codex",
          projectId: null,
          createdAt: new Date().toISOString(),
          dumpJson: '{"events":["tool"]}\n',
        },
        store.db,
      );
      expect(uploads.map((upload) => upload.Key)).toEqual([
        "team/fabdesk/run-dumps/run_1.json",
        `team/fabdesk/conversations/${thread.id}/run_1.json`,
      ]);
      expect(uploads.every((upload) => upload.Bucket === "private-training")).toBe(true);
      for (const upload of uploads) {
        expect(upload.ContentMD5).toBe(createHash("md5").update(upload.Body!).digest("base64"));
      }
    } finally {
      writer.close();
      store.close();
    }
  });
});
