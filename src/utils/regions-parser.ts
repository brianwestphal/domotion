/** Dependency-neutral parser for the canonical REGIONS: interchange block. */
export type Region = {
  index: number;
  image?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  caption?: string;
};

export type ParseResult = {
  regions: Region[];
  warnings: string[];
};

const REGIONS_HEADER = /^REGIONS:\s*$/m;
const ENTRY_LINE = /^-\s*(?:\[(\d+)\]\s*)?(?:image=(\S+?)\s+)?\(x=(-?\d+)\s+y=(-?\d+)\s+w=(-?\d+)\s+h=(-?\d+)\)(?:\s*[—-]+\s*(.+?))?\s*$/;

export function parseRegionsBlock(noteBody: string): ParseResult {
  const warnings: string[] = [];
  const headerMatch = REGIONS_HEADER.exec(noteBody);
  if (!headerMatch) return { regions: [], warnings };

  const tail = noteBody.slice(headerMatch.index + headerMatch[0].length);
  const lines = tail.split(/\r?\n/);
  const regions: Region[] = [];
  let positional = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") {
      if (regions.length > 0) break;
      continue;
    }
    if (!line.startsWith("-")) break;

    positional += 1;
    const match = ENTRY_LINE.exec(line);
    if (!match) {
      warnings.push(`Skipped malformed REGIONS entry: ${line}`);
      continue;
    }
    const [, index, image, xValue, yValue, widthValue, heightValue, caption] = match;
    const x = Number(xValue);
    const y = Number(yValue);
    const w = Number(widthValue);
    const h = Number(heightValue);
    if (w <= 0 || h <= 0 || x < 0 || y < 0) {
      warnings.push(`Skipped REGIONS entry with non-positive size or negative origin: ${line}`);
      continue;
    }
    regions.push({
      index: index ? Number(index) : positional,
      ...(image ? { image } : {}),
      x,
      y,
      w,
      h,
      ...(caption ? { caption: caption.trim() } : {}),
    });
  }
  return { regions, warnings };
}
