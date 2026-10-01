import { useCore } from "@fabdesk/client-core";

/** Keep adapter instructions intact while making documentation and commands readable. */
export function InstallHint({ text }: { text: string }) {
  const { host } = useCore();
  const commands = text.match(/curl [^,)]+|npm install [^(,]+|brew install [^),]+/g) ?? [];
  const prose = commands.reduce((value, command) => value.replace(command, ""), text);
  const guide = prose.match(/https:\/\/[^\s),]+/)?.[0];
  const next = text.split(", then ")[1];
  const inline = (value: string) => value.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") ? <code key={index} className="rounded-md bg-panel-2 px-1.5 py-0.5 font-mono text-fg">{part.slice(1, -1)}</code> : <span key={index}>{part}</span>);
  return <div className="space-y-2 break-words text-xs leading-5 text-muted">
    {guide && <button type="button" className="text-accent underline underline-offset-4 hover:text-fg" title={guide} onClick={() => void host.openExternal(guide)}>Open installation guide</button>}
    {commands.length > 0 && <div>
      <p className="mb-2">{commands.length > 1 ? "Install using either command:" : "Install using your terminal:"}</p>
      {commands.map((command, index) => <code key={index} className="mb-2 block select-all overflow-x-auto rounded-lg border border-border bg-panel-2 px-2.5 py-1.5 font-mono text-fg">{command.trim()}</code>)}
    </div>}
    {next ? <p>Then {inline(next)}</p> : !commands.length && !guide ? <p>{inline(text)}</p> : null}
  </div>;
}
