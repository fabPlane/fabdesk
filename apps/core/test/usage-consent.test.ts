import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockServices } from "../../../packages/tools/test/mock-services";
import { Store } from "../src/db";
import { serve, type Daemon } from "../src/serve";

test("Settings opt-out cancels a pending retry, and opting back in resumes the unsent backfill", async () => {
  const root = await mkdtemp(join(tmpdir(), "fabdesk-usage-consent-"));
  const store = Store.open(join(root, "fabdesk.db"));
  store.settings.patch({
    usageArchiveConsent: true,
    usageArchiveChoiceComplete: true,
    errorReporting: false,
  });
  const thread = store.threads.create({ agentId: "codex", title: "Synthetic consent test" });
  store.threads.addMessage({
    threadId: thread.id,
    role: "user",
    contentMd: "Synthetic fixture only.",
  });
  store.close();
  let firstAttempt!: () => void;
  const attempted = new Promise<void>((resolve) => {
    firstAttempt = resolve;
  });
  const uploads: number[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (request.method === "POST")
        return Response.json(
          {
            installationId: "550e8400-e29b-41d4-a716-446655440000",
            token: "550e8400-e29b-41d4-a716-446655440000." + "a".repeat(64),
          },
          { status: 201 },
        );
      if (request.method !== "PUT") return new Response(null, { status: 404 });
      uploads.push(Date.now());
      if (uploads.length === 1) {
        firstAttempt();
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
      }
      return new Response(null, { status: 201 });
    },
  });
  const env = {
    FABDESK_HOME: root,
    FABDESK_PROJECTS_DIR: join(root, "projects"),
    FABPLANE_API_ORIGIN: receiver.url.origin,
    FABDESK_USAGE_REMOTE_BACKUP: "1",
    FABDESK_PRIVACY_SCREEN: "always",
    FABDESK_TAILSCALE_CLI: "off",
    FABDESK_CHANNEL: "internal",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let daemon: Daemon | undefined;
  try {
    daemon = await serve({
      port: 0,
      dataDir: root,
      quiet: true,
      noHandshake: true,
      localAuth: true,
      watchProjects: false,
      services: ({ projects, bus, store }) =>
        mockServices([], {
          projects,
          bus: { emit: (event) => bus.emit(event) },
          routeRuns: store.routeRuns,
          channel: "internal",
        }),
    });
    await Promise.race([
      attempted,
      Bun.sleep(2000).then(() => {
        throw new Error("no initial upload");
      }),
    ]);
    const settings = async (allowed: boolean) => {
      const response = await fetch(`${daemon!.url}/settings`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${daemon!.token}`, "content-type": "application/json" },
        body: JSON.stringify({ usageArchiveConsent: allowed, usageArchiveChoiceComplete: true }),
      });
      expect(response.status).toBe(200);
    };
    await settings(false);
    await Bun.sleep(50);
    expect(uploads).toHaveLength(1);
    // Cancellation must not permanently close the writer or strand a still-settling backfill.
    await settings(true);
    const db = Store.open(join(root, "fabdesk.db"));
    try {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const count = db.db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_archive_uploads")
          .get()!.n;
        if (count === 1 && uploads.length === 3) break;
        await Bun.sleep(10);
      }
      expect(
        db.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM usage_archive_uploads").get()!.n,
      ).toBe(1);
      expect(uploads).toHaveLength(3); // Rejected attempt, then conversation + manifest after fresh consent.
      await settings(false);
      await Bun.sleep(50);
      expect(uploads).toHaveLength(3);
    } finally {
      db.close();
    }
  } finally {
    await daemon?.close("usage consent test complete");
    receiver.stop(true);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 5000);
