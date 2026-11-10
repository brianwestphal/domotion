# Strict native shadow image witnesses

The strict knockout, selected-root and integral-inset fixtures keep their
original screenshot calls, options, source HTML, viewport and RGBA assertions.
`tests/native-shadow-evidence.ts` writes representative existing PNG buffers
without another capture, browser query, pixel conversion or re-encoding.

Files live in `shadow-knockout/witnesses/<case>-<uuid>/` below the configured
visual output root. Linux defaults to `tests/output-linux`; macOS and Windows
default to `tests/output`. `DOMOTION_OUTPUT_DIR` overrides the root. Unique
directories keep a later failed run from inheriting an earlier output pair.
The existing native profile uploads this directory alongside its test report.
Main macOS upload retention is separately tracked by DM-XGXXWN.

`source.png` and `metadata.json` are written before the first relevant
structural/pixel assertion. Each already-captured selector output is written
as `output-only.png`, `output-container.png` or `output-body.png` before its
strict RGBA comparison. A failure before output capture leaves a source-only
record; an output entry proves bytes were retained, not that an assertion
passed. Assertion outcome stays explicitly unobserved in the metadata and must
be qualified against the native test report.

Metadata records the full source commit when supplied, platform, architecture,
Node/browser versions, case/selector, authored fixture HTML digest and size,
PNG digests/sizes/dimensions and the existing CSS viewport. PNG-to-CSS scale is
derived from those dimensions; no claim of a newly queried
`window.devicePixelRatio` is made. Fixture/helper source hashes normalize CRLF
to LF and declare that normalization. Compare those normalized hashes to the
qualified source, rather than requiring raw Windows and POSIX checkout bytes
or platform raster PNGs to be equal.

The writer accepts only owned test modules, bounded case IDs/labels, fixed
selectors, a 32 KiB fixture, a 4 MiB PNG and a 16 KiB metadata document. It
records no arguments, environment dump, page values or arbitrary URLs. Evidence
I/O failure fails the test; absent files are never treated as successful paint.

The original J2 zero-origin knockout, selected boxless/inset roots and accepted
integral inset radii retain witnesses. Other existing refusal/neighborhood
assertions remain intact. A separate native control retains real source/output
buffers before a deliberately failing comparison, then checks the saved bytes.
It does not mutate those images or claim a fidelity defect. Actual native CI
archive inspection is still required; local macOS witnesses do not establish
Windows/Linux painting or artifact availability.
