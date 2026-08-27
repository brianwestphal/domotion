# Strict static frames for SVG and CSS images

Status: shipped macOS/Linux subset; strict two-platform production workflow

The opt-in `animatedImageFrames` request accepts a `slot` in addition to its
unique `selector` and non-negative `frameIndex`. `svg-href` selects an SVG
`<image>` owner. `background-image`, `border-image-source`, `mask-image`, and
`list-style-image` select an ordinary computed CSS image and require an
explicit zero-based `index` into the property's top-level comma-separated
items. Omitting `slot` retains the existing `<img>`/`<picture>`/image-input
behavior.

Only one plain computed `url(...)` item is eligible. The collector binds the
unique backend node, slot and index, full serialized computed property (or SVG
`href.baseVal`), resolved selected URL, frame/loader/document nonce, DPR and
viewport to exactly one completed pre-navigation Network-ledger entry. It
reopens the same owner before accepting bytes. Shared or repeated requests,
cache and service-worker responses, cross-origin bodies, `image-set()` and
other image functions, generated pseudos, shadow owners, missing indexes, and
owner/property/layer/document drift fail closed without exposing body facts.

After two fresh WebCodecs decoders agree exactly on the requested complete
frame, the transaction replaces only the authenticated slot with its static
PNG. For CSS it copies the complete computed image list into the element's
inline property and changes only the selected item, preserving the other
layers and the computed repeat, position, size, slice, mask and stacking
properties. SVG changes only `href.baseVal`. The normal capture and embedding
pipeline then serializes that static PNG, including the downstream resize and
digest ownership rules in [doc 234](234-frozen-animated-image-downstream-ownership.md).

The authority for this deliberately narrow production subset is the retained
macOS/Linux private owner/resource evidence and public-CDP adjudication in
[doc 235](235-public-svg-css-animated-image-owner-joins.md). Windows/global
ratification remains separate. Live playback is unsupported, no visual
tolerance changes, and capture without the option remains unchanged.

The optional `Animated-image macOS Linux production release` workflow retains
one native artifact per platform: the exact fresh-decoder proposal/validation
report, machine-readable results for the authenticated owner/slot/frozen-PNG/
resize/final-SVG production tests, and the runner/dependency fingerprint. Its
aggregate rejects either missing platform, any decoder drift, a non-headless
browser, a mismatched platform identity, an incomplete production test set, or
an empty runner record. This is the maximum non-Windows release checkpoint;
the global three-platform verdict remains withheld until the Windows authority
and production artifact exist.
