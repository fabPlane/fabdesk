import { expect, test } from "bun:test";
import { traceBreakdown } from "../pilot-trace-breakdown";
test("trace analysis measures failures and identical attempts without declaring them redundant", () => {
  const events = [1,2].flatMap(id => [{ type:"agent.tool_use", timeUnixNano:String(id*1e9), body:{id:String(id), name:"mcp__fabdesk__capability_call",input:{name:"verify_drc"}} }, {type:"agent.tool_result",timeUnixNano:String((id+0.5)*1e9),body:{id:String(id),isError:id===1}}]);
  const result = traceBreakdown(events.map(e=>JSON.stringify(e)).join("\n"));
  expect(result.totals.verification).toEqual({calls:2,failed:1,repeatedInput:1,observedCallSeconds:1}); expect(result.limits).toContain("not proven redundant");
});
