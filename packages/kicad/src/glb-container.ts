/** Validate GLB framing before exposing any geometry from a native export.
 * https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format */
export function parseGlbContainer(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    throw new Error("not a binary glTF file");
  if (view.getUint32(4, true) !== 2) throw new Error("unsupported glTF version");
  if (view.getUint32(8, true) !== bytes.byteLength)
    throw new Error("glTF file length does not match its header");
  let offset = 12,
    index = 0,
    json: unknown,
    binOffset = -1,
    binLength = 0;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("incomplete glTF chunk header");
    const length = view.getUint32(offset, true),
      type = view.getUint32(offset + 4, true);
    offset += 8;
    if (length % 4 || offset + length > bytes.byteLength)
      throw new Error("invalid glTF chunk length");
    if (index === 0) {
      if (type !== 0x4e4f534a) throw new Error("glTF JSON chunk missing");
      json = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + length)),
      );
      if (!json || typeof json !== "object" || Array.isArray(json))
        throw new Error("glTF JSON chunk must contain an object");
    } else if (type === 0x4e4f534a) throw new Error("duplicate glTF JSON chunk");
    else if (type === 0x004e4942) {
      if (index !== 1 || binOffset >= 0) throw new Error("invalid glTF binary chunk order");
      binOffset = offset;
      binLength = length;
    }
    // Unknown extension chunks are ignored as required by the GLB specification.
    offset += length;
    index++;
  }
  return { json, binOffset, binLength };
}
