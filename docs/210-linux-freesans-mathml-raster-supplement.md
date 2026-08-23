# Linux FreeSans MathML native-raster supplement

Status: **source/logical exact; independent Linux envelope ratified**

This supplement adds one Linux-only, source-owned `mathml-mi-greek-italic` cell beside
the ratified paths/native-raster floor. It does not add a seventh technology to
the existing corpus: the six-technology matrix remains exactly 348 cells per
run, and `tools/paths-native-raster-envelopes.json` is unchanged. The new cell
has its own contract, collector, lossless artifacts, gate, reviewed envelope,
and proposal/validation workflow.

## Authenticated source and logical ownership

The workflow downloads Ubuntu Noble main package `fonts-freefont-ttf`
`20211204+svn4273-2` from its exact archive URL. It checks the 5,640,794-byte
`.deb` SHA-256
`c8283ec9ca390e6ad8d2114cb0942182db62bb97f5142c2f955218fc5f2027b4`
before extraction, then checks the package member
`usr/share/fonts/truetype/freefont/FreeSans.ttf`: 1,844,796 bytes, SHA-256
`350badd6ab6a58e7fd7a0ea2ae0c10174941a08e1cd06b3c6010e10b3d5ae319`.
The collector verifies package name/source/version/architecture, FreeSans
family/PostScript name, face index, units per em, vertical metrics, glyph
count, and required mathematical-glyph outlines. It copies only that face into
a one-file Fontconfig configuration; that exact inventory and configuration
are fingerprinted before Chromium starts.

The cell retains the four Greek `<mi>` scalars used by the feature fixture:

- `α → U+1D6FC 𝛼 → gid 6548`
- `β → U+1D6FD 𝛽 → gid 6549`
- `π → U+1D70B 𝜋 → gid 6563`
- `θ → U+1D703 𝜃 → gid 6555`

For every token, the pre-terminal record requires computed `math-auto`, the
captured transformed scalar, exactly one CDP-painted non-custom FreeSans face,
source-owned gid/cluster/advance/offset and outline identity, and the captured
fragment-top-plus-ascent baseline with its identity matrix. The exported
`validateLinuxMathmlGreekTokenEvidence` projection stops at that boundary, so
the repaired logical MathML oracle can grade a capture-owned raster terminal
without inventing paths provenance.

The exact retained-gid HarfBuzz subsets are also part of the cell identity.
The hinted subset is 43,184 bytes with SHA-256
`9208b3c4b2468f5b3040d45dfec40208f6ca269b1d3d7ab372677c59e796b5a4`;
the no-hint subset is 41,600 bytes with SHA-256
`1fa8efe98f3acead5ccc5d4e04f961cc4dd47cd0a63a3fff9d14a39ca76f2e00`.
Reopening both must preserve retained gids, advances, and outlines.

## Raster arms and strict ordering

The native arm is real HTML MathML under the isolated system inventory. The
paths arm registers the authenticated full FreeSans bytes with the production
renderer and places each transformed scalar at its capture-owned baseline. A
third browser-native `<text>` arm loads the authenticated no-hint subset at the
same positions. It is a causal negative control: all logical glyph and
placement facts must remain exact while its PNG must move relative to the
system-native FreeSans PNG. An inert hinting control withholds ratification; it
does not authorize a tolerance change.

`tools/linux-mathml-greek-raster-gate.ts` rejects package, inventory,
math-auto, face, glyph, outline, subset, baseline, matrix, warning, or artifact
authentication failures before considering raster residuals. It confines and
reopens every lossless PNG, verifies dimensions and SHA-256, and recomputes the
same device-pixel edge/ink/channel residual used by the main floor. There is no
global percentage score and no changed scalar threshold.

The workflow runs proposal and validation on separate `ubuntu-24.04` machines
and records a hashed Linux boot identity to prove they are independent. An
unreviewed but exact pair produces `logical-exact-unratified` plus a candidate
envelope. Ratification requires the exact two role-hash sets, complete
environment fingerprint, canonical cell hash, reviewed proposal maxima, and
validation no greater than proposal in every scalar residual dimension.

Workflow run `32628749740` supplied that independent pair with distinct boot
identities. Both roles produced the same authenticated native, paths, and
no-hint artifact hashes; every validation residual was no greater than its
proposal value. The reviewed envelope is keyed by canonical cell SHA-256
`af16295838647da894e71a009aa27b03df56d74478124c39383744ece42d21e5`
and environment fingerprint SHA-256
`4158b334a1223adb6885bcd880e62d86f087cd2129cdce9389d13e8619bc8045`.
The strict aggregate returns `ratified-rasterization-only`. No global percentage
or scalar threshold changed.

## Source boundary

Pinned Chromium `7d859f271c` applies `math-auto` to single-code-unit `<mi>`
tokens before shaping (`core/css/mathml.css`, `computed_style.cc`, and
`math_transform.cc`). HarfBuzz `4de187dd0` then shapes the transformed scalar;
it does not own the CSS transform. Chromium-pinned Skia `62efacd3` owns the
FreeType native mask and hinting dispatch, while Domotion owns only the
authenticated source-outline SVG arm. Consequently only a logical-exact,
independently collected terminal mask residual can enter this supplement's
envelope.
