import { Icon } from "./Icon";

const FEATURES = {
  enclosure: { title: "Assembly & enclosure", icon: "cube" as const, message: "The enclosure workspace is waiting for the team update to be integrated. Importing a case, generating an enclosure and assembly editing are on hold." },
  replacement: { title: "Part replacement", icon: "pcb" as const, message: "Part replacement is waiting for the team update to be integrated. You can keep inspecting the board and working with its existing parts." },
  resize: { title: "Board resizing", icon: "pcb" as const, message: "Board resizing is waiting for the team update to be integrated. Your current board outline stays as saved." },
};

/** Explicit temporary integration boundary; no illustrative model is presented as project evidence. */
export function IntegrationPending({ feature }: { feature: keyof typeof FEATURES }) {
  const item = FEATURES[feature];
  return <section className="fd-integration-pending" role="status" aria-label={`${item.title} awaiting integration`}>
    <Icon name={item.icon} width={30} height={30} />
    <div><span className="fd-integration-pending-badge">Awaiting integration</span><h2>{item.title}</h2><p>{item.message}</p></div>
  </section>;
}
