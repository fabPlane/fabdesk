import { expect, test } from "bun:test";
import { inspectLedDirections, evaluateLedCurrent } from "../src/tools/release-led";

export function fixture(a = "LED", k = "GROUND", value = "330", names = true, sink = false) {
  const node = (ref: string, pin: string, fn = "", type = "passive") =>
    `(node (ref "${ref}") (pin "${pin}") (pinfunction "${fn}") (pintype "${type}"))`;
  const nets: Record<string, string[]> = {
    GROUND: [node("U1", "1", "GND", "power_in")],
    SUPPLY: [node("U1", "8", "VCC", "power_in")],
    DRIVE: [],
    LED: [],
  };
  (nets[a] ??= []).push(node("D1", "2", names ? "A_2" : ""));
  (nets[k] ??= []).push(node("D1", "1", names ? "K_1" : ""));
  nets.LED!.push(node("R1", "1"));
  nets[sink ? "SUPPLY" : "DRIVE"]!.push(node("R1", "2"));
  return `(export (components (comp (ref D1) (value LED) (libsource (lib Device) (part LED))) (comp (ref R1) (value "${value}") (libsource (lib Device) (part R)))) (nets ${Object.entries(
    nets,
  )
    .map(([name, nodes]) => `(net (name "${name}") ${nodes.join(" ")})`)
    .join(" ")}))`;
}
const check = {
  supplyVolts: 5,
  forwardVolts: 2,
  resistanceOhms: 330,
  minMa: 5,
  maxMa: 15,
  led: "D1",
  driveNet: "DRIVE",
};
test("source direction and current use saved resistor", () => {
  const net = fixture();
  expect(inspectLedDirections(net).leds[0]).toMatchObject({ status: "pass", mode: "source" });
  expect(evaluateLedCurrent(check, net)).toMatchObject({
    status: "pass",
    evidenceLevel: "computed",
    resistor: { reference: "R1", resistanceOhms: 330 },
    assumptions: { forwardVolts: 2 },
  });
});
test("sink direction", () => {
  const net = fixture("LED", "DRIVE", "330", true, true);
  expect(inspectLedDirections(net).leds[0]).toMatchObject({ status: "pass", mode: "sink" });
  expect(evaluateLedCurrent(check, net).status).toBe("pass");
});
test("anode on ground fails automatically", () =>
  expect(inspectLedDirections(fixture("GROUND", "LED")).status).toBe("fail"));
test("cathode on positive supply fails automatically", () =>
  expect(inspectLedDirections(fixture("LED", "SUPPLY")).status).toBe("fail"));
test("same net fails", () =>
  expect(inspectLedDirections(fixture("LED", "LED")).status).toBe("fail"));
test("resistor mismatch fails and uses saved value", () =>
  expect(evaluateLedCurrent(check, fixture("LED", "GROUND", "1k"))).toMatchObject({
    status: "fail",
    resistor: { resistanceOhms: 1000 },
  }));
test("standard library fallback without pin names", () =>
  expect(inspectLedDirections(fixture("LED", "GROUND", "330", false)).leds[0]).toMatchObject({
    status: "pass",
    pinEvidence: "library-fallback",
  }));
test("unbound arithmetic remains declared", () =>
  expect(evaluateLedCurrent({ ...check, led: undefined }, fixture())).toMatchObject({
    status: "pass",
    evidenceLevel: "declared",
  }));
test("missing drive or reference is not decided", () => {
  expect(evaluateLedCurrent({ ...check, driveNet: undefined }, fixture()).status).toBe("unknown");
  expect(evaluateLedCurrent({ ...check, led: "D9" }, fixture()).status).toBe("unknown");
});
test("net names do not establish rail identity", () =>
  expect(inspectLedDirections(fixture().replaceAll("power_in", "passive")).status).toBe("unknown"));
test("invalid netlist is unknown", () =>
  expect(inspectLedDirections("output").status).toBe("unknown"));
test("power symbols establish rails without name guessing or IC pins", () => {
  const net = fixture().replaceAll("power_in", "passive");
  const sch = '(kicad_sch (symbol (lib_id "power:GND") (property "Value" "GROUND")))';
  expect(inspectLedDirections(net, [sch]).leds[0]?.status).toBe("pass");
  expect(
    inspectLedDirections(net, [
      '(kicad_sch (symbol (lib_id "power:PWR_FLAG") (property "Value" "GROUND")))',
    ]).status,
  ).toBe("unknown");
});
test("unconnected library LED is unknown", () =>
  expect(
    inspectLedDirections(
      "(export (components (comp (ref D1) (libsource (lib Device) (part LED)))) (nets))",
    ).status,
  ).toBe("unknown"));
test("branched resistor path and active device topology are unknown", () => {
  const branched = fixture().replace(
    '(node (ref "R1") (pin "1")',
    '(node (ref "Q1") (pin "1")) (node (ref "R1") (pin "1")',
  );
  expect(evaluateLedCurrent(check, branched).status).toBe("unknown");
  expect(
    inspectLedDirections(
      fixture("DRIVE", "LED").replace("(lib Device) (part R)", "(lib Transistor) (part Q_NPN)"),
    ).status,
  ).toBe("unknown");
});

test("solder jumper A/B pins are not an LED", () => {
  const net =
    "(export (components (comp (ref SJ1) (libsource (lib Jumper) (part SolderJumper_2_Open)))) (nets (net (name ground) (node (ref SJ1) (pin 1) (pinfunction A)) (node (ref U1) (pin 1) (pinfunction GND) (pintype power_in))) (net (name supply) (node (ref SJ1) (pin 2) (pinfunction B)) (node (ref U1) (pin 8) (pinfunction VCC) (pintype power_in)))))";
  expect(inspectLedDirections(net)).toMatchObject({ status: "pass", leds: [] });
});

test("unknown direction explains the missing rail evidence", () => {
  const result = inspectLedDirections(fixture().replaceAll("power_in", "passive"));
  expect(result.leds[0]?.reasons).toEqual([
    "forward path not decided: no recognized ground or positive-supply rail evidence",
  ]);
});
