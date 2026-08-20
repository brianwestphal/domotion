# Unified shaping evidence

Status: **Shipped**

`npm run fonts:shaping:unified -- --json <path>` emits one normalized record per
representative face-and-run pair. Each record contains:

- Chromium CDP painted family/PostScript face, glyph count, custom-font flag,
  and per-scalar `Range` rectangles;
- helper face key, concrete file, collection member, variation axes, and
  fallback-run boundary;
- HarfBuzz glyph IDs, UTF-16 clusters/source spans, advances, offsets, glyph
  flags, direction, script, language, features, size, buffer flags, and cluster
  level; and
- the complete parity environment fingerprint.

This is a joined evidence record, not a claim that CDP exposes glyph IDs. At the
pinned Chromium revision, `ShapeResultRun` owns `HarfBuzzRunGlyphData` and its
offset collection, but the public `CSS.getPlatformFontsForNode` surface exposes
the faces that reached paint rather than Blink's glyph buffer. The report labels
that boundary explicitly. Exact glyph records therefore come from the same
concrete face shaped with Domotion's Chromium-configured vendored HarfBuzz,
while face ownership and painted origins come independently from Chromium.
The harness first tries a local PostScript-face rule; if a protected/system face
is not CSS-addressable that way, it probes a bounded family/generic and
weight/style matrix and accepts only the candidate whose CDP PostScript answer
equals the helper's concrete face. This discovery is oracle-only and contains
no production font-routing table. A protected or named-instance face that is
still unreachable after that walk remains in the report with
`faceAgreement: false`, `faceObservation:
"css-unaddressable-after-candidate-walk"`, and no cross-face glyph-equivalence
claim. This is evidence about a public CSS/CDP boundary, not a fabricated match.

The gate withholds its verdict unless every input dimension moves under a
negative control: face, axes, size/ptem, OpenType features, direction, script,
language, buffer flags, cluster level, and the browser-side painted-origin
probe. It also requires every record to contain painted-origin evidence and
either a concrete face match or the explicit exhausted CSS-addressability
classification above. Demo CI uses this report for both the face and shaping
evidence cards.

Related: [same-machine text parity](120-same-machine-text-parity-contract.md),
[exact pre-raster shaping](114-exact-shaping-oracle.md), and
[demo-review stage evidence](140-demo-review-stage-evidence.md).
