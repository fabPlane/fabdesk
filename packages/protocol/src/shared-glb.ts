import { z } from "zod/v4";
const number = z.number().finite();
const index = z.number().int().nonnegative().max(2_000_000);
const vec = (length: number) => z.array(number).length(length);
const gltfSchema = z.object({
  asset: z.object({ version: z.literal("2.0") }),
  scene: index.optional(),
  scenes: z.array(z.object({ nodes: z.array(index).max(20_000) })).max(128),
  nodes: z
    .array(
      z.object({
        mesh: index.optional(),
        children: z.array(index).max(20_000).optional(),
        matrix: vec(16).optional(),
        translation: vec(3).optional(),
        rotation: vec(4).optional(),
        scale: vec(3).optional(),
      }),
    )
    .max(20_000),
  meshes: z
    .array(
      z.object({
        primitives: z
          .array(
            z.object({
              attributes: z.object({
                POSITION: index,
                NORMAL: index.optional(),
                TEXCOORD_0: index.optional(),
                COLOR_0: index.optional(),
              }),
              indices: index.optional(),
              material: index.optional(),
              mode: z.literal(4).optional(),
            }),
          )
          .min(1)
          .max(20_000),
      }),
    )
    .min(1)
    .max(20_000),
  accessors: z
    .array(
      z.object({
        bufferView: index,
        byteOffset: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 1024 * 1024)
          .optional(),
        componentType: z.union([
          z.literal(5120),
          z.literal(5121),
          z.literal(5122),
          z.literal(5123),
          z.literal(5125),
          z.literal(5126),
        ]),
        count: index,
        type: z.enum(["SCALAR", "VEC2", "VEC3", "VEC4"]),
        normalized: z.boolean().optional(),
        min: z.array(number).max(4).optional(),
        max: z.array(number).max(4).optional(),
      }),
    )
    .max(50_000),
  bufferViews: z
    .array(
      z.object({
        buffer: z.literal(0),
        byteOffset: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 1024 * 1024)
          .optional(),
        byteLength: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 1024 * 1024),
        byteStride: z.number().int().min(4).max(252).optional(),
        target: z.union([z.literal(34962), z.literal(34963)]).optional(),
      }),
    )
    .max(50_000),
  buffers: z
    .array(
      z.object({
        byteLength: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 1024 * 1024),
      }),
    )
    .length(1),
  materials: z
    .array(
      z.object({
        pbrMetallicRoughness: z
          .object({
            baseColorFactor: vec(4).optional(),
            metallicFactor: number.optional(),
            roughnessFactor: number.optional(),
          })
          .optional(),
        emissiveFactor: vec(3).optional(),
        alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]).optional(),
        alphaCutoff: number.optional(),
        doubleSided: z.boolean().optional(),
      }),
    )
    .max(2048)
    .optional(),
});

/** Share static geometry only. Rebuild JSON from an allowlist: no names, extras, textures, external URIs, extensions or animations. */
export function sanitizeSharedGlb(bytes: Uint8Array): Uint8Array {
  const fail = () => new Error("Use a self-contained static GLB board model under 10 MiB.");
  if (bytes.byteLength < 32 || bytes.byteLength > 10 * 1024 * 1024) throw fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength
  )
    throw fail();
  const jsonLength = view.getUint32(12, true),
    binHeader = 20 + jsonLength;
  if (
    jsonLength % 4 ||
    jsonLength > 2 * 1024 * 1024 ||
    binHeader + 8 > bytes.length ||
    view.getUint32(16, true) !== 0x4e4f534a ||
    view.getUint32(binHeader + 4, true) !== 0x004e4942
  )
    throw fail();
  const binLength = view.getUint32(binHeader, true),
    binOffset = binHeader + 8;
  if (binLength % 4 || binOffset + binLength !== bytes.length) throw fail();
  let raw: any;
  try {
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, binHeader)),
    );
  } catch {
    throw fail();
  }
  if (
    raw.extensionsRequired?.length ||
    raw.buffers?.some((buffer: any) => buffer.uri !== undefined)
  )
    throw fail();
  const parsed = gltfSchema.safeParse(raw);
  if (!parsed.success) throw fail();
  const model = parsed.data;
  if (
    !model.scenes.length ||
    model.buffers[0]!.byteLength > binLength ||
    binLength - model.buffers[0]!.byteLength > 3
  )
    throw fail();
  const at = <T>(items: T[], i: number): T => {
    const item = items[i];
    if (item === undefined) throw fail();
    return item;
  };
  const visitState = new Map<number, number>();
  const visit = (i: number, depth: number) => {
    if (depth > 128 || visitState.get(i) === 1) throw fail();
    if (visitState.get(i) === 2) return;
    const node = at(model.nodes, i);
    visitState.set(i, 1);
    if (node.mesh !== undefined) at(model.meshes, node.mesh);
    for (const child of node.children ?? []) visit(child, depth + 1);
    visitState.set(i, 2);
  };
  const parents = new Set<number>();
  for (const node of model.nodes)
    for (const child of node.children ?? []) {
      if (parents.has(child)) throw fail();
      parents.add(child);
    }
  for (let i = 0; i < model.nodes.length; i++) visit(i, 0);
  at(model.scenes, model.scene ?? 0);
  for (const scene of model.scenes) {
    if (new Set(scene.nodes).size !== scene.nodes.length) throw fail();
    for (const i of scene.nodes) {
      at(model.nodes, i);
      if (parents.has(i)) throw fail();
    }
  }
  let vertices = 0;
  for (const mesh of model.meshes)
    for (const primitive of mesh.primitives) {
      const position = at(model.accessors, primitive.attributes.POSITION);
      if (position.type !== "VEC3" || position.componentType !== 5126) throw fail();
      vertices += position.count;
      if (vertices > 2_000_000) throw fail();
      for (const i of Object.values(primitive.attributes))
        if (i !== undefined) at(model.accessors, i);
      if (primitive.indices !== undefined) {
        const a = at(model.accessors, primitive.indices);
        if (a.type !== "SCALAR" || ![5121, 5123, 5125].includes(a.componentType)) throw fail();
      }
      if (primitive.material !== undefined) at(model.materials ?? [], primitive.material);
    }
  let rendered = 0;
  for (const node of model.nodes)
    if (node.mesh !== undefined) {
      for (const primitive of at(model.meshes, node.mesh).primitives)
        rendered += at(model.accessors, primitive.attributes.POSITION).count;
    }
  if (!vertices || !rendered || rendered > 2_000_000) throw fail();
  for (const accessor of model.accessors) {
    const buffer = at(model.bufferViews, accessor.bufferView),
      count = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type],
      size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
    const element = count * size,
      stride = buffer.byteStride ?? element,
      offset = accessor.byteOffset ?? 0;
    if (
      stride < element ||
      offset % size ||
      ((buffer.byteOffset ?? 0) + offset) % size ||
      offset + (accessor.count ? stride * (accessor.count - 1) + element : 0) > buffer.byteLength
    )
      throw fail();
  }
  for (const buffer of model.bufferViews)
    if ((buffer.byteOffset ?? 0) + buffer.byteLength > model.buffers[0]!.byteLength) throw fail();
  // URI fields, including URIs hidden in unused buffers/images, never survive parsing above.
  const json = new TextEncoder().encode(JSON.stringify(model));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const output = new Uint8Array(28 + paddedLength + binLength);
  const out = new DataView(output.buffer);
  out.setUint32(0, 0x46546c67, true);
  out.setUint32(4, 2, true);
  out.setUint32(8, output.length, true);
  out.setUint32(12, paddedLength, true);
  out.setUint32(16, 0x4e4f534a, true);
  output.fill(32, 20, 20 + paddedLength);
  output.set(json, 20);
  out.setUint32(20 + paddedLength, binLength, true);
  out.setUint32(24 + paddedLength, 0x004e4942, true);
  output.set(bytes.subarray(binOffset), 28 + paddedLength);
  return output;
}
