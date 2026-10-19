import { join } from "node:path";
import { Store } from "../../src/db";
import { RunTelemetry } from "../../src/run-telemetry";

const root = process.argv[2]!;
const store = Store.open(join(root, "fabdesk.db"));
const thread = store.threads.create({ agentId: "claude" });
const run = store.runs.create({ threadId: thread.id, agentId: "claude" });
const telemetry = new RunTelemetry({ version: "test", runDumps: store.runDumps });
const trace = await telemetry.startAgentRun({ runId: run.id, threadId: thread.id,
  agentId: "claude", projectId: null, cwd: join(root, "project"), prompt: "interrupted" });
store.runs.setLogPath(run.id, trace.logPath);
console.log(JSON.stringify({ runId: run.id, threadId: thread.id }));
process.exit(0); // Leave the same durable state as a core exit without finalization.
