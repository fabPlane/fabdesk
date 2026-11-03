import { ProjectImage } from "../chat/ProjectImage";
import { Icon } from "../components/Icon";
import { Button } from "../components/ui";

/** Entry choices use the existing upload/sketch loaders; no sample board is implied. */
export function ArtworkStart({ projectId, sketches, disabled, restoring, onUpload, onSketch, onRetry }: {
  projectId: string | null;
  sketches: readonly { path: string }[];
  disabled: boolean;
  restoring: boolean;
  onUpload: () => void;
  onSketch: (path: string) => void;
  onRetry?: () => void;
}) {
  return <div className="fd-art-start">
    <header>
      <h2>Artwork</h2>
      <p>Add a logo, drawing or photo to your board. Start with an image or a saved project sketch.</p>
    </header>
    <div className="fd-art-start-grid">
      <section className="fd-art-start-upload" aria-label="Upload artwork">
        <div className="fd-art-start-icon"><Icon name="image" width={32} height={32} aria-hidden="true" /></div>
        <h3>Bring your artwork</h3>
        <p>Drop an image here, or choose a file from your computer.</p>
        <Button variant="primary" disabled={disabled} onClick={onUpload}><Icon name="plus" width={16} height={16} />Choose image</Button>
        <span>PNG, JPG, WebP or GIF · up to 12 MB</span>
        {restoring && <span role="status">Loading saved artwork…</span>}
        {onRetry && <Button disabled={restoring} onClick={onRetry}>Retry saved artwork</Button>}
      </section>
      <section className="fd-art-start-sketches" aria-label="Project sketches for artwork">
        <div className="fd-art-start-sketch-heading"><Icon name="compose" width={18} height={18} aria-hidden="true" /><h3>Project sketches</h3>{sketches.length > 0 && <span>{sketches.length}</span>}</div>
        <p>Use a sketch already saved in this project.</p>
        {sketches.length ? <ul>{sketches.map(file => <li key={file.path}>
          <button type="button" disabled={disabled} onClick={() => onSketch(file.path)} title={file.path}>
            <span className="fd-art-start-thumbnail"><ProjectImage projectId={projectId} path={file.path} alt="" fallback={<Icon name="image" width={22} height={22} aria-hidden="true" />} /></span>
            <span className="fd-art-start-sketch-name">{file.path.split("/").pop()}<small>Use as artwork</small></span>
            <Icon name="plus" width={16} height={16} aria-hidden="true" />
          </button>
        </li>)}</ul> : <div className="fd-art-start-no-sketch"><Icon name="compose" width={24} height={24} aria-hidden="true" /><p>No saved sketches yet.</p></div>}
      </section>
    </div>
    <footer><Icon name="shield" width={16} height={16} aria-hidden="true" /><span>Adjust colors and placement after choosing an image. Saving artwork keeps your circuit files unchanged.</span></footer>
  </div>;
}
