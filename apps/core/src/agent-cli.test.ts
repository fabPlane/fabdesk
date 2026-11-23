import {expect,test} from "bun:test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {prepareAgentCli} from "./agent-cli";
test("active CLI wrapper preserves executable/argument spaces and shell metacharacters",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"agent-cli-"));
 try {const entry=join(dir,"entry with spaces.ts");await writeFile(entry,'console.log(JSON.stringify(process.argv.slice(2)))');const cli=await prepareAgentCli(dir,[process.execPath,entry]);const p=Bun.spawn([cli,"tool","describe","literal $(echo nope)"],{stdout:"pipe",stderr:"pipe"});expect(JSON.parse(await new Response(p.stdout).text())).toEqual(["tool","describe","literal $(echo nope)"]);expect(await p.exited).toBe(0);const win=await prepareAgentCli(dir,['C:\\Apps\\fabdesk-core.exe'],"win32");expect(await readFile(win,"utf8")).toContain('"C:\\Apps\\fabdesk-core.exe" %*');} finally {await rm(dir,{recursive:true,force:true});}
});
