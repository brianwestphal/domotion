/** fontkit's WOFF2 variation instances cannot read the parent tables. Decode
 * to a real SFNT before instancing; callers decide whether failure is fatal. */
export async function normalizedFontData(bytes: Buffer, maxBytes = Infinity): Promise<Buffer | null> {
  if (bytes.toString("ascii", 0, 4) !== "wOF2") return bytes.length <= maxBytes ? bytes : null;
  if (bytes.length < 20 || bytes.readUInt32BE(16) > maxBytes) return null;
  try {
    const wawoff = (await import("wawoff2" as string)) as { decompress(data: Uint8Array): Promise<Uint8Array> };
    const normalized = Buffer.from(await wawoff.decompress(bytes));
    return normalized.length <= maxBytes ? normalized : null;
  } catch {
    return null;
  }
}
