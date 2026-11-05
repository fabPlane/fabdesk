import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { checkPinMap, type BoardPartSummary } from "@fabdesk/protocol";
import { BoardLegend } from "./BoardPairView";
import { ConnectPanel } from "./ConnectPanel";

const bounds = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
const part = (ref: string, pads: Array<[string, string]>): BoardPartSummary => ({ ref, x: 0, y: 0, bounds, nets: pads.map(([, net]) => net), connector: true, pads: pads.map(([pin, net]) => ({ pin, net, bounds })) });
const J1 = part("J1", [["1", "GND"], ["2", "SDA"]]), J9 = part("J9", [["7", "+5V"], ["8", "SDA"]]);
const noop = () => {};
const panel = (props: Partial<Parameters<typeof ConnectPanel>[0]>) => renderToStaticMarkup(<ConnectPanel
  source={J1} sourceBoard="a.kicad_pcb" boards={[{ path: "a.kicad_pcb", name: "a" }, { path: "b.kicad_pcb", name: "b" }]}
  targetBoard="b.kicad_pcb" targetParts={[J9]} targetLoading={false} target={null} link={null} sourceLinks={[]}
  pinMap={{}} pinCheck={checkPinMap(J1.pads, [], [])} pinsEdited={false} activePin={null} busy={false} nameOf={path => path}
  onClose={noop} onTargetBoard={noop} onTarget={noop} onOpenLink={noop} onNewTarget={noop} onActivePin={noop} onPin={noop} onSave={noop} onReview={noop} onRemove={noop}
  {...props}
/>);

test("before a target is chosen, the panel asks where the part connects and lists parts to pick", () => {
  const html = panel({});
  expect(html).toContain("Connect to");
  expect(html).toContain('aria-label="Target board"');
  expect(html).toContain(">J9<");
  expect(html).toContain("1 shared net name");
  // SDA counts; the shared part of a rail would not.
  expect(panel({ source: part("J1", [["1", "GND"]]), targetParts: [part("J9", [["7", "GND"]])] })).not.toContain("shared net name");
});

test("with a target, every source pin gets a row and an unsaved map offers Save connection", () => {
  const html = panel({ target: J9, pinMap: { "2": "8" }, pinCheck: checkPinMap(J1.pads, J9.pads, [{ a: "2", b: "8" }]) });
  expect(html).toContain('aria-label="Pin on J9 for pin 1"');
  expect(html).toContain('aria-label="Pin on J9 for pin 2"');
  expect(html).toContain("Save connection");
  expect(html).toContain("1 named not mapped");
});

test("joining ground to a power rail is shown as a conflict", () => {
  const html = panel({ target: J9, pinMap: { "1": "7" }, pinCheck: checkPinMap(J1.pads, J9.pads, [{ a: "1", b: "7" }]), pinsEdited: true });
  expect(html).toContain('data-check="conflict"');
  expect(html).toContain("Different power or ground nets");
  expect(html).toContain("1 power conflict");
});

test("the legend names every colour it shows", () => {
  const html = renderToStaticMarkup(<BoardLegend items={[{ tone: "new", label: "New" }, { tone: "connector", label: "Connector" }]} />);
  expect(html).toContain('data-tone="new"');
  expect(html).toContain("Connector");
});
