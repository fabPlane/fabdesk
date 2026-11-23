import { expect, test } from "bun:test";
import { Address4, Address6 } from "ip-address";
import katex from "katex";
import qs from "qs";

test("subnet membership never crosses IPv4 and IPv6 families", () => {
  const v4 = new Address4("10.0.0.0/8");
  const v6 = new Address6("a00::1");
  expect(v6.isInSubnet(v4)).toBe(false);
  expect(v6.isHostInSubnet(v4)).toBe(false);
  expect(new Address4("32.0.0.1").isInSubnet(new Address6("2000::/3"))).toBe(false);
  expect(new Address4("10.1.2.3").isInSubnet(v4)).toBe(true);
  expect(new Address6("2001:db8::5").isInSubnet(new Address6("2001:db8::/32"))).toBe(true);
});

test("math rendering ignores inherited trust and still renders ordinary expressions", () => {
  const inherited = Object.create({ trust: true });
  const html = katex.renderToString(String.raw`\href{javascript:alert(1)}{unsafe}`, inherited);
  expect(html).not.toContain('href="javascript:');
  expect(katex.renderToString(String.raw`\frac{1}{2}+x^2`)).toContain('class="katex"');
});

test.each([false, true])("comma query serialization handles hostile own toString, encodeValuesOnly=%s", encodeValuesOnly => {
  const input = { columns: [{ toString: "not callable" }] };
  expect(() => qs.stringify(input, { arrayFormat: "comma", encodeValuesOnly })).not.toThrow();
  expect(qs.stringify({ columns: ["a", "b"] }, { arrayFormat: "comma" })).toBe("columns=a%2Cb");
});
