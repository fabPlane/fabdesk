import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexAppServer } from "./codex-app-server";
import type { AgentEvent, AgentSession } from "../types";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fabdesk-question-rpc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function fixture(asyncQuestions = false, behavior: { batches?: number; secret?: boolean; reasoning?: boolean; interruptError?: boolean; tools?: boolean } = {}) {
  const path = join(dir, "server.ts");
  writeFileSync(path, `
const send = (m) => console.log(JSON.stringify(m));
let turns = 0;
for await (const line of console) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({id:m.id,result:{}});
  if (m.method === 'thread/resume' || m.method === 'thread/start') send({id:m.id,result:{thread:{id:'native-thread'}}});
  if (m.method === 'turn/start') {
    turns++;
    send({id:m.id,result:{turn:{id:'turn'}}});
    send({method:'turn/started',params:{threadId:'native-thread',turn:{id:'turn'}}});
    if (${!!behavior.tools}) {
      // Field names match the installed CLI's generated v2 ThreadItem protocol.
      const items = [
        {id:'cmd',type:'commandExecution',command:'echo ready',status:'completed',aggregatedOutput:'ready',exitCode:0},
        {id:'file',type:'fileChange',changes:[{path:'board.txt',kind:{type:'add'},diff:'+ready'}],status:'completed'},
        {id:'mcp',type:'mcpToolCall',server:'fabdesk',tool:'board_check',arguments:{},status:'failed',result:null,error:{message:'Board missing'}},
        {id:'search',type:'webSearch',query:'USB connector',action:null,results:[]},
      ];
      for(const item of items) {
        send({method:'item/started',params:{threadId:'native-thread',turnId:'turn',item:{...item,status:'inProgress',exitCode:null,error:null}}});
        send({method:'item/completed',params:{threadId:'native-thread',turnId:'turn',item}});
      }
      send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn',status:'completed'}}});
      continue;
    }
    if (${!!behavior.reasoning}) {
      send({method:'item/started',params:{threadId:'native-thread',turnId:'turn',item:{id:'reason',type:'reasoning',summary:[],content:[]}}});
      send({method:'item/reasoning/summaryTextDelta',params:{threadId:'native-thread',turnId:'turn',itemId:'reason',summaryIndex:0,delta:'Checking the board.'}});
      send({method:'item/completed',params:{threadId:'native-thread',turnId:'turn',item:{id:'reason',type:'reasoning',summary:['Checking the board.'],content:['Private reasoning must not be shown.']}}});
      send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn',status:'completed'}}});
      continue;
    }
    if (${asyncQuestions}) {
      if(turns === 1) {
        for(let batch=0;batch<${behavior.batches ?? 1};batch++) send({method:'item/completed',params:{threadId:'native-thread',turnId:'turn',item:{id:'async-question-'+batch,type:'agentMessage',text:'Question fallback text',questions:[{title:'7 × 8?',options:['56','48']},{title:'Your own question?'}]}}});
      } else {
        send({method:'item/agentMessage/delta',params:{threadId:'native-thread',itemId:'answer',delta:m.params.input[0].text}});
        send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn',status:'completed'}}});
      }
      continue;
    }
    send({id:'question-request',method:'item/tool/requestUserInput',params:{threadId:'native-thread',turnId:'turn',questions:[{id:'one',question:'7 × 8?',options:[{label:'56',description:''},{label:'48',description:''}]},{id:'two',question:'Your own question?',isSecret:${!!behavior.secret}}]}});
  }
  if (m.method === 'turn/interrupt') {
    if (${!!behavior.interruptError}) { send({id:m.id,error:{message:'Could not pause the turn.'}}); continue; }
    send({id:m.id,result:{}});
    send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn',status:'interrupted'}}});
  }
  if (m.id === 'question-request' && m.result) {
    send({method:'item/agentMessage/delta',params:{threadId:'native-thread',itemId:'answer',delta:JSON.stringify(m.result)}});
    send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn',status:'completed'}}});
  }
}
`);
  return [process.execPath, path];
}
const session = (): AgentSession => ({ cwd: dir, prompt: "Ask two questions", attachments: [], permission: "acceptEdits", mcp: { url: "http://test.invalid", token: "test" } });

async function collect(run: ReturnType<typeof runCodexAppServer>) {
  const events: AgentEvent[] = [];
  try { for await (const event of run.events) events.push(event); }
  finally { run.abort(); }
  return events;
}

test("separate question items in one turn resume together exactly once", async () => {
  let count = 0;
  const events = await collect(runCodexAppServer({ ...session(), requestInput: async () => String(++count) }, fixture(true, { batches: 2 }), {}));
  expect(count).toBe(4);
  const text = events.filter((e) => e.type === "text").map((e) => e.delta).join("");
  expect(JSON.parse(text.slice(text.indexOf("[")))).toHaveLength(4);
  expect(events.filter((e) => e.type === "done")).toEqual([{ type: "done", exitCode: 0, sessionId: "native-thread" }]);
});

for (const asyncQuestions of [false, true]) test(`unanswered ${asyncQuestions ? "async" : "blocking"} questions give recovery guidance`, async () => {
  const events = await collect(runCodexAppServer({ ...session(), requestInput: async () => "" }, fixture(asyncQuestions), {}));
  expect(events.find((e) => e.type === "error")).toMatchObject({ message: expect.stringContaining("No answer was received") });
  expect(events.at(-1)).toMatchObject({ type: "done", exitCode: 1 });
  expect(events.some((e) => e.type === "text")).toBe(false);
});

test("secret questions reject the entire batch before opening any cards", async () => {
  let opened = 0;
  const events = await collect(runCodexAppServer({ ...session(), requestInput: async () => { opened++; return "secret"; } }, fixture(false, { secret: true }), {}));
  expect(opened).toBe(0);
  expect(events.find((e) => e.type === "error")).toMatchObject({ message: "Secret input cannot be collected in chat history." });
});

test("a failed question cancels sibling cards", async () => {
  const signals: AbortSignal[] = [];
  const events = await collect(runCodexAppServer({ ...session(), requestInput: (q) => {
    signals.push(q.signal!);
    if (signals.length === 1) return Promise.reject(new Error("Question service disconnected."));
    return new Promise((resolve) => q.signal!.addEventListener("abort", () => resolve(""), { once: true }));
  } }, fixture(), {}));
  expect(signals).toHaveLength(2);
  expect(signals.every((s) => s.aborted)).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: "done", exitCode: 1 });
});

test("interrupt failures cancel questions immediately without waiting for answers", async () => {
  const signals: AbortSignal[] = [];
  const events = await collect(runCodexAppServer({ ...session(), requestInput: (q) => {
    signals.push(q.signal!);
    return new Promise((resolve) => q.signal!.addEventListener("abort", () => resolve(""), { once: true }));
  } }, fixture(true, { interruptError: true }), {}));
  expect(signals.every((s) => s.aborted)).toBe(true);
  expect(events.find((e) => e.type === "error")).toMatchObject({ message: "Could not pause the turn." });
});

test("public progress summaries stream once without exposing private reasoning", async () => {
  const events = await collect(runCodexAppServer(session(), fixture(false, { reasoning: true }), {}));
  expect(events.filter((e) => e.type === "thinking")).toEqual([{ type: "thinking", delta: "Checking the board." }]);
  expect(JSON.stringify(events)).not.toContain("Private reasoning");
});

test("native command, file, MCP and web items preserve tool inputs and results", async () => {
  const events = await collect(runCodexAppServer(session(), fixture(false, { tools: true }), {}));
  expect(events.filter((e) => e.type === "tool_use").map((e) => e.name)).toEqual(["command_execution", "file_change", "mcp__fabdesk__board_check", "web_search"]);
  expect(events.find((e) => e.type === "tool_use" && e.id === "cmd")).toMatchObject({ input: { command: "echo ready" } });
  expect(events.find((e) => e.type === "tool_result" && e.id === "cmd")).toMatchObject({ output: { aggregated_output: "ready", exit_code: 0 } });
  expect(events.find((e) => e.type === "tool_result" && e.id === "mcp")).toMatchObject({ isError: true, output: { message: "Board missing" } });
  expect(events.find((e) => e.type === "tool_use" && e.id === "search")).toMatchObject({ input: { query: "USB connector" } });
  expect(events.filter((e) => e.type === "tool_result")).toHaveLength(4);
});

test("done is delivered only after the transport has exited", async () => {
  const run = runCodexAppServer(session(), fixture(false, { reasoning: true }), {});
  await collect(run);
  expect(() => process.kill(run.pid!, 0)).toThrow();
});

test.skipIf(process.platform === "win32")("stop escalates when a transport ignores SIGTERM", async () => {
  const path = join(dir, "stubborn.ts");
  writeFileSync(path, `process.on('SIGTERM', () => {}); console.log(JSON.stringify({method:'item/agentMessage/delta',params:{itemId:'ready',delta:'ready'}})); setInterval(() => {}, 1000);`);
  const run = runCodexAppServer(session(), [process.execPath, path], {});
  for await (const event of run.events) {
    if (event.type === "text") run.abort();
    if (event.type === "done") expect(() => process.kill(run.pid!, 0)).toThrow();
  }
}, 10_000);

test("native questions open together, wait, and return selected/custom answers by original ID", async () => {
  const questions: Array<{ question: string; options?: string[] }> = [];
  const answers: Array<(s: string) => void> = [];
  const run = runCodexAppServer({ ...session(), resume: "native-thread", requestInput: (q) => { questions.push(q); return new Promise((resolve) => answers.push(resolve)); } }, fixture(), {});
  const events: AgentEvent[] = [];
  let complete = false;
  const consume = (async () => { for await (const e of run.events) events.push(e); complete = true; })();
  try {
    for (let i = 0; i < 100 && questions.length < 2; i++) await Bun.sleep(10);
    expect(questions.map((q) => q.question)).toEqual(["7 × 8?", "Your own question?"]);
    expect(questions[0]?.options).toEqual(["56", "48"]);
    expect(complete).toBe(false);
    answers[0]!("56");
    await Bun.sleep(10);
    expect(complete).toBe(false);
    answers[1]!("My custom answer");
    await consume;
    const response = events.find((e) => e.type === "text");
    expect(response?.type === "text" && JSON.parse(response.delta)).toEqual({answers:{one:{answers:["56"]},two:{answers:["My custom answer"]}}});
    expect(events.at(-1)).toMatchObject({type:"done",exitCode:0,sessionId:"native-thread"});
  } finally { run.abort(); }
});

test("stopping cancels native pending questions and releases the event stream", async () => {
  const signals: AbortSignal[] = [];
  const run = runCodexAppServer({ ...session(), requestInput: (q) => { signals.push(q.signal!); return new Promise((resolve) => q.signal!.addEventListener("abort", () => resolve(""), { once:true })); } }, fixture(), {});
  const consume = (async () => { for await (const _ of run.events) {} })();
  try {
    for (let i = 0; i < 100 && signals.length < 2; i++) await Bun.sleep(10);
    expect(signals).toHaveLength(2);
    run.abort();
    await consume;
    expect(signals.every((s) => s.aborted)).toBe(true);
  } finally { run.abort(); }
});

test("async native question metadata pauses the turn and resumes only after all answers", async () => {
  const answers: Array<(s: string) => void> = [];
  const run = runCodexAppServer({ ...session(), requestInput: () => new Promise((resolve) => answers.push(resolve)) }, fixture(true), {});
  const events: AgentEvent[] = [];
  let complete = false;
  const consume = (async () => { for await (const e of run.events) events.push(e); complete = true; })();
  try {
    for (let i=0; i<100 && answers.length<2; i++) await Bun.sleep(10);
    expect(answers).toHaveLength(2);
    answers[0]!("56");
    await Bun.sleep(30);
    expect(complete).toBe(false);
    expect(events.some((e) => e.type === "text")).toBe(false);
    answers[1]!("My own answer");
    await consume;
    const reply = events.find((e) => e.type === "text");
    expect(reply?.type === "text" && reply.delta).toContain('"answer":"My own answer"');
    expect(events.at(-1)).toMatchObject({type:"done",exitCode:0});
  } finally { run.abort(); }
});
