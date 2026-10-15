/** Retain a few unchanged vector images so switching tabs can reuse browser decoding. */
export function createSvgImageCache(
  maxBytes = 8 * 1024 * 1024,
  urls = { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url) },
) {
  const entries = new Map<string, { url: string; bytes: number; users: number }>();
  let bytes = 0;
  const trim = () => {
    for (const [svg, entry] of entries) {
      if (bytes <= maxBytes) break;
      if (entry.users) continue;
      entries.delete(svg);
      bytes -= entry.bytes;
      urls.revoke(entry.url);
    }
  };
  return {
    acquire(svg: string) {
      let entry = entries.get(svg);
      if (!entry) {
        const blob = new Blob([svg], { type: "image/svg+xml" });
        entry = { url: urls.create(blob), bytes: blob.size, users: 0 };
        entries.set(svg, entry);
        bytes += entry.bytes;
      }
      entry.users++;
      // Move the most recently used source to the end of the eviction queue.
      entries.delete(svg);
      entries.set(svg, entry);
      trim();
      let released = false;
      return {
        url: entry.url,
        release() {
          if (released) return;
          released = true;
          entry.users--;
          trim();
        },
      };
    },
  };
}

// Inactive URLs are evicted above 8 MiB. Active images remain valid until unmounted.
export const svgImageCache = createSvgImageCache();
