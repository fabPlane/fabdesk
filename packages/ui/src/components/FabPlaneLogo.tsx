/** The official desktop app icon, shared unchanged with the canvas header. */
const iconUrl = new URL("../assets/fabplane-icon.png", import.meta.url).href;

export function FabPlaneLogo() {
  return <img className="fd-canvas-logo" src={iconUrl} alt="" aria-hidden="true" />;
}
