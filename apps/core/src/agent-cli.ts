import { mkdir, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
const quoteSh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** A per-runtime executable avoids selecting a different installation's global CLI. */
export async function prepareAgentCli(home: string, command: string[], platform = process.platform): Promise<string> {
  const dir = join(home,"agent-cli"); await mkdir(dir,{recursive:true});
  const path = join(dir, platform === "win32" ? "fabpcb.cmd" : "fabpcb");
  const text = platform === "win32" ? `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${command.map(arg=>'"'+arg.replaceAll('%','%%').replaceAll('"','""')+'"').join(' ')} %*\r\n` : `#!/bin/sh\nexec ${command.map(quoteSh).join(' ')} "$@"\n`;
  await writeFile(path,text,{mode:0o700}); if(platform!=="win32")await chmod(path,0o700);
  return path;
}
