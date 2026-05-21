/**
 * Inspect the framer-mobile-scroll composed SVG: identify which segment
 * contributes content at composite y=762..844 (REGION [1] of DM-633).
 *
 * The scroll composer wraps each segment in
 *   <g transform="translate(0 OFFSET)"><svg ...>SEGMENT_CONTENT</svg></g>
 * where OFFSET is the segment's scrollY. So content inside segment N's <g>
 * appears at composite y=OFFSET..OFFSET+844.
 *
 * At t=0 the viewport shows composite y=0..844. So content visible in REGION
 * [1] (0, 762, 390, 82) must come from segment N where OFFSET <= 762 <
 * OFFSET+844. That's segment 0 (OFFSET=0).
 *
 * This probe locates segment 0's <g> in the SVG and dumps the elements
 * within that group whose y position intersects 762..844 (in segment-local
 * coords).
 */
import { readFileSync } from "node:fs";

const svg = readFileSync("./tests/output/real-world/framer-mobile-scroll.svg", "utf8");

// Find <g transform="translate(0 N)"> open tags + their containing <svg>.
const re = /<g transform="translate\(0 (\d+(?:\.\d+)?)\)">/g;
const segs: Array<{ ty: number; offset: number }> = [];
let m;
while ((m = re.exec(svg)) !== null) {
  segs.push({ ty: parseFloat(m[1]), offset: m.index });
}
console.log(`Segment <g> groups: ${segs.length}`);
for (let i = 0; i < segs.length; i++) {
  console.log(`  [${i}] tY=${segs[i].ty.toFixed(2)}  at offset ${segs[i].offset}`);
}

// Look inside segment 0 (tY=0): find <text role="img" aria-label="..."> tags
// and figure out which ones live at viewport-y in 762..844 range.
//
// Each text-run uses <g transform="translate(X,Y)" ... aria-label="...">.
// The Y here is the segment-local viewport y (positive going down).
function inspectSegment(seg: { ty: number; offset: number }, label: string) {
  // Find segment end: the next `</g></g>` after the next `</svg>` closes the segment's inner SVG.
  // For simplicity, take a 3MB window after offset.
  const window = svg.slice(seg.offset, seg.offset + 3_000_000);
  const textBlockRe = /<g transform="translate\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)"[^>]*aria-label="([^"]{0,80})"/g;
  let tm;
  let hits = 0;
  console.log(`\n=== ${label} (tY=${seg.ty}) text blocks at viewport-y 700..844 ===`);
  while ((tm = textBlockRe.exec(window)) !== null) {
    const x = parseFloat(tm[1]);
    const y = parseFloat(tm[2]);
    const text = tm[3];
    if (y >= 700 && y <= 844) {
      console.log(`  x=${x.toFixed(1)} y=${y.toFixed(1)} "${text}"`);
      hits++;
      if (hits > 30) break;
    }
  }
  if (hits === 0) console.log("  (none)");
}

if (segs.length > 0) inspectSegment(segs[0], "segment 0");
if (segs.length > 1) inspectSegment(segs[1], "segment 1");
