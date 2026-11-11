import { expect, test } from "bun:test";
import { checkPinMap, isConnectorPart, isRailNet } from "./board-workspace";

const a = [{ pin: "1", net: "GND" }, { pin: "2", net: "+3V3" }, { pin: "3", net: "SDA" }, { pin: "4", net: "Net-(J1-Pad4)" }, { pin: "5" }];
const b = [{ pin: "1", net: "GND" }, { pin: "2", net: "+5V" }, { pin: "3", net: "/sheet/SDA" }, { pin: "4", net: "SCL" }];

test("connectors are found by reference or footprint", () => {
  expect(isConnectorPart("J1")).toBe(true);
  expect(isConnectorPart("USB2")).toBe(true);
  expect(isConnectorPart("R1")).toBe(false);
  expect(isConnectorPart("JP")).toBe(false);
  expect(isConnectorPart("U9", "Connector_FFC:Hirose")).toBe(true);
  expect(isConnectorPart("U9", "Package_QFP:LQFP-48")).toBe(false);
  expect(isConnectorPart("D1", "LED_0603")).toBe(false);
});

test("names that agree pass, including across hierarchical sheets", () => {
  const check = checkPinMap(a.slice(0, 1).concat(a[2]!), b, [{ a: "1", b: "1" }, { a: "3", b: "3" }]);
  expect(check.status).toBe("agree");
  expect(check.rows.map((row) => row.kind)).toEqual(["match", "match"]);
});

test("different power and ground nets are a conflict", () => {
  expect(checkPinMap(a, b, [{ a: "1", b: "2" }]).rows[0]?.kind).toBe("conflict");
  expect(checkPinMap(a, b, [{ a: "2", b: "1" }]).rows[0]?.kind).toBe("conflict");
  expect(checkPinMap(a, b, [{ a: "2", b: "2" }]).status).toBe("conflict");
});

test("different signal names ask for a look, and so does a signal on a rail", () => {
  expect(checkPinMap(a, b, [{ a: "3", b: "4" }]).rows[0]?.kind).toBe("differs");
  expect(checkPinMap(a, b, [{ a: "3", b: "1" }]).rows[0]?.kind).toBe("differs");
});

test("generated and missing names say nothing either way", () => {
  expect(checkPinMap(a, b, [{ a: "4", b: "4" }]).rows[0]?.kind).toBe("unnamed");
  expect(checkPinMap(a, b, [{ a: "5", b: "1" }]).rows[0]?.kind).toBe("unnamed");
});

test("named pins left out are listed, and leave the map short of agreeing", () => {
  const check = checkPinMap(a, b, [{ a: "1", b: "1" }]);
  expect(check.unmapped).toEqual(["2", "3"]);
  expect(check.status).toBe("review");
});

test("rails are told apart from signals, including across sheets", () => {
  for (const net of ["GND", "AGND", "/power/GND", "+3V3", "VBUS", "VCC_IO", "+5V"]) expect(isRailNet(net)).toBe(true);
  for (const net of ["SDA", "USB_D+", "KB_LED_SCRL", "CLK"]) expect(isRailNet(net)).toBe(false);
});

test("voltage rails are recognised however they are written", () => {
  for (const net of ["+3V3", "3V3", "+3.3V", "3.3V", "+1.8V", "-12V", "+12V", "VCC", "+VBAT", "/Power/+3.3V"]) expect(isRailNet(net)).toBe(true);
  for (const net of ["SDA", "V_OUT", "3D_SENSE", "PV1"]) expect(isRailNet(net)).toBe(false);
  const kind = (x: string, y: string) => checkPinMap([{ pin: "1", net: x }], [{ pin: "1", net: y }], [{ a: "1", b: "1" }]).rows[0]?.kind;
  expect(kind("+3.3V", "GND")).toBe("conflict");
  expect(kind("-12V", "+12V")).toBe("conflict");
  expect(kind("vcc", "VCC")).toBe("match");
  expect(kind("0V", "GND")).toBe("differs");
  expect(kind("0V", "+5V")).toBe("conflict");
});

test("no pins stated is not a result", () => {
  expect(checkPinMap(a, b, undefined).status).toBe("none");
  expect(checkPinMap(a, b, []).rows).toEqual([]);
});
