import { useEffect, useRef, useState } from "react";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

/** A saved idea stays visible while the existing composer owns its unsent message. */
export function SketchStartReference({ projectId, paths, preferred, checking, failed, conversation, assistantOpen, attached }: {
  projectId: string; paths: string[]; preferred: string; checking: boolean; failed: boolean; conversation: boolean; assistantOpen: boolean; attached: string | undefined;
}) {
  const [choice, setChoice] = useState(preferred);
  const lastAttachment = useRef(attached);
  useEffect(() => {
    if (attached && attached !== lastAttachment.current) setChoice(attached);
    lastAttachment.current = attached;
  }, [attached]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const drawing = useRef<HTMLButtonElement>(null);
  const path = paths.includes(choice) ? choice : preferred;
  const selected = selectedPath === path;
  const ui = () => useUiStore.getState();
  const active = () => ui().activeProjectId === projectId;
  const dismiss = () => { setSelectedPath(null); requestAnimationFrame(() => drawing.current?.focus()); };
  return <section className="fd-start-reference" data-conversation={conversation} data-assistant-open={assistantOpen} aria-label="Saved design reference" onKeyDown={event => {
    if (event.key === "Escape" && selected) { event.preventDefault(); event.stopPropagation(); dismiss(); }
  }}>
    <div className="fd-start-reference-tools">
      {selected ? <div className="fd-board-context-tools" aria-label="Sketch actions">
        <span><Icon name="image" width={16} height={16} />Sketch</span>
        <Button size="sm" variant="ghost" onClick={() => {
          if (!active()) return;
          const key = ui().activeThreadId ?? newChatDraftKey(projectId);
          if (!ui().attachments[key]?.some(item => item.path === path)) ui().addAttachment(key, { path, mime: /\.jpe?g$/i.test(path) ? "image/jpeg" : "image/png", label: path.slice("sketches/".length) });
          ui().focusComposer();
        }}>Use in message</Button>
        <Button size="sm" variant="ghost" onClick={() => { if (active()) ui().setSketchOpen(true, "draw"); }}>Draw or open a copy</Button>
        <Button size="sm" variant="ghost" onClick={() => { if (active()) { ui().openProjectFile(path); ui().setAssistantOpen(false); } }}>View file</Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>Deselect</Button>
      </div> : <p>Select your sketch to see its tools</p>}
    </div>
    <button ref={drawing} className="fd-start-reference-image" aria-label="Select saved sketch to show tools" aria-pressed={selected} onClick={() => setSelectedPath(selected ? null : path)}>
      <ProjectImage projectId={projectId} path={path} alt="Saved project sketch reference" />
    </button>
    <div className="fd-start-reference-caption">
      {paths.length > 1 ? <label>Reference<select aria-label="Choose project sketch reference" value={path} onChange={event => { setChoice(event.target.value); setSelectedPath(null); }}>{paths.map(item => <option key={item} value={item}>{item.slice("sketches/".length)}</option>)}</select></label> : <strong title={path}>{path.slice("sketches/".length)}</strong>}
      <span role="status">{failed ? "Saved references could not be refreshed" : checking ? "Checking saved references…" : "Saved to this project · Design reference"}</span>
    </div>
  </section>;
}
