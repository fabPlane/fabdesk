export function modelFixture(change?: (json: any) => void) {
  const json: any = {
    asset: { version: "2.0", generator: "private exporter /Users/secret" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "private source path", extras: { secret: "private" } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ],
    buffers: [{ byteLength: 42 }],
    materials: [{ name: "private", pbrMetallicRoughness: { baseColorFactor: [0.1, 0.6, 0.4, 1] } }],
  };
  change?.(json);
  const encoded = new TextEncoder().encode(JSON.stringify(json)),
    length = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(28 + length + 44),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + length);
  bytes.set(encoded, 20);
  view.setUint32(20 + length, 44, true);
  view.setUint32(24 + length, 0x004e4942, true);
  new Float32Array(bytes.buffer, 28 + length, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Uint16Array(bytes.buffer, 28 + length + 36, 3).set([0, 1, 2]);
  return bytes;
}
