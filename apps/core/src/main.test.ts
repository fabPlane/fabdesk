import { describe, expect, test } from "bun:test";
import { cliUsage } from "./main";

describe("CLI exposure profiles", () => {
  test("full usage advertises MCP and registry tool access", () => {
    const usage = cliUsage({});
    expect(usage).toContain("fabdesk-core mcp");
    expect(usage).toContain("fabpcb tool search");
    expect(usage).toContain("fabdesk-core funnel");
  });

  test("substrate usage omits MCP and registry tool access", () => {
    const usage = cliUsage({ FABDESK_AGENT_INTERFACE: "substrate" });
    expect(usage).not.toContain("fabdesk-core mcp");
    expect(usage).not.toContain("fabpcb tool");
    expect(usage).toContain("fabpcb env describe");
    expect(usage).toContain("fabpcb verify");
    expect(usage).not.toContain("fabpcb ipc");
  });

  test("programmable usage adds direct IPC while keeping construction interfaces absent", () => {
    const usage = cliUsage({ FABDESK_AGENT_INTERFACE: "programmable" });
    expect(usage).not.toContain("fabdesk-core mcp");
    expect(usage).not.toContain("fabpcb tool");
    expect(usage).toContain("fabpcb ipc search");
    expect(usage).toContain("fabpcb env describe");
    expect(usage).toContain("fabpcb verify");
  });
});
