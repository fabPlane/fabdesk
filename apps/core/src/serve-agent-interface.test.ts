import { describe, expect, test } from "bun:test";
import { agentBridgeEnvironment, agentMcpProfile, configuredAgentInterface } from "./serve";

describe("experimental agent interface environment", () => {
  test("substrate clears direct IPC while programmable receives the attested bridge", () => {
    const url = "http://127.0.0.1:4020";
    expect(agentBridgeEnvironment("substrate", url)).toEqual({
      FABDESK_FP_PCB_BRIDGE_URL: "",
    });
    expect(agentBridgeEnvironment("programmable", url)).toEqual({
      FABDESK_FP_PCB_BRIDGE_URL: url,
    });
    expect(agentMcpProfile("substrate")).toBe("substrate");
    expect(agentMcpProfile("programmable")).toBe("substrate");
  });

  test("recognizes only explicit experimental modes", () => {
    expect(configuredAgentInterface({ FABDESK_AGENT_INTERFACE: "substrate" })).toBe("substrate");
    expect(configuredAgentInterface({ FABDESK_AGENT_INTERFACE: "programmable" })).toBe(
      "programmable",
    );
    expect(configuredAgentInterface({ FABDESK_AGENT_INTERFACE: "native" })).toBeUndefined();
  });
});
