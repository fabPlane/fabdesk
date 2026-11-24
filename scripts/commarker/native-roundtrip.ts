import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectStudioTemplate, makeStudioCopperProject } from "../../packages/client-core/src/commarker-project";
import { encodeStudioFixture } from "../../packages/client-core/test-fixtures/commarker-template";

const [, , action, directory] = process.argv;
assert.ok(directory && (action === "prepare" || action === "verify"), "Expected prepare|verify and a working directory");
const svg = readFileSync("docs/examples/omni-x-copper-coupon-remove.svg", "utf8");
const job = join(directory, "fabdesk.orzr");

// Format 0 is Studio's inspectable document serialization. The editor can also save
// its normal format 1, tested separately through the production template reader.
function readProject(bytes: Uint8Array) {
  assert.deepEqual([...bytes.subarray(0, 8)], Array(8).fill(0));
  return JSON.parse(Buffer.from(Buffer.from(bytes.subarray(8)).toString("ascii"), "base64").toString("utf8"));
}

if (action === "prepare") {
  writeFileSync(job, makeStudioCopperProject(svg, encodeStudioFixture()));
} else {
  const input = readFileSync(job);
  const expected = readProject(input);
  const actual = readProject(readFileSync(join(directory, "reopened.orzr")));
  assert.equal(actual.shapes.length, 1);
  const [shape] = actual.shapes;
  assert.equal(shape.type, 4);
  assert.equal(shape.basePaths.length, 3);
  assert.deepEqual(shape.position, { from: [-10, -6], to: [20, 12] });
  assert.equal(shape.penIndex, 3);
  for (const key of ["basePaths", "fillParam", "userData", "matrix", "postTransformMatrix", "arrayParam"]) {
    assert.deepEqual(shape[key], expected.shapes[0][key], key);
  }
  assert.deepEqual(actual.penPar.params[3], expected.penPar.params[3], "complete selected pen");
  const ordinary = readFileSync(join(directory, "studio-save.orzr"));
  assert.equal(ordinary[0], 1, "Studio ordinary Save mode");
  assert.deepEqual(inspectStudioTemplate(ordinary), inspectStudioTemplate(input));
  const regenerated = readProject(makeStudioCopperProject(svg, ordinary));
  assert.deepEqual(regenerated.shapes, expected.shapes, "reusing Studio's normal save as a template");
  assert.deepEqual(regenerated.penPar, expected.penPar);
  console.log("Studio reopened the 20 × 12 mm coupon with three paths and the exact calibrated pen, Fill and transforms. FabDesk reused its ordinary save.");
}
