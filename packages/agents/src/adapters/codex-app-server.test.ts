import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexAppServer } from "./codex-app-server";
import type { AgentEvent, AgentSession } from "../types";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "fabdesk-question-rpc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function fixture(asyncQuestions = false) {
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
    if (${asyncQuestions}) {
      if(turns === 1) {
        send({method:'item/completed',params:{threadId:'native-thread',turnId:'turn',item:{id:'async-question',type:'agentMessage',text:'Question fallback text',questions:[{title:'7 × 8?',options:['56','48']},{title:'Your own question?'}]}}});
      } else {
        send({method:'item/agentMessage/delta',params:{threadId:'native-thread',itemId:'answer',delta:m.params.input[0].text}});
        send({method:'turn/completed',params:{threadId:'native-thread',turn:{id:'turn',status:'completed'}}});
      }
      continue;
    }
    send({id:'question-request',method:'item/tool/requestUserInput',params:{threadId:'native-thread',turnId:'turn',questions:[{id:'one',question:'7 × 8?',options:[{label:'56',description:''},{label:'48',description:''}]},{id:'two',question:'Your own question?'}]}});
  }
  if (m.method === 'turn/interrupt') {
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
