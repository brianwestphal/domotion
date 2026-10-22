# Changelog

All notable changes to **Domotion** are documented in this file.

## Unreleased

## [0.31.0] - 2026-10-23

**Changed**

- `package.json` now declares an `exports` map. The supported entry points are `domotion-svg`, its documented alias `domotion-svg/dist/index.js`, the new `domotion-svg/post-processing` subpath (the optimize, gzip, WOFF2, image-hoist and clip-safety passes only), `domotion-svg/schemas/*`, and `domotion-svg/package.json`. Deep `domotion-svg/dist/<module>` imports were never part of the public API and now fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`; import the same symbols from the package root instead.
- Added the `domotion-svg/render`, `domotion-svg/animation` and `domotion-svg/tree-ops` subpaths. Each exposes exactly its documented section of the root API (render also carries the capture-tree envelope helpers the renderer accepts) and resolves to the same module the root re-exports, so root and subpath imports share one set of module state. Capture, scroll, templates, terminal and Studio symbols remain root-only.
- Added the `domotion-svg/templates` and `domotion-svg/studio` subpaths, now that every template and Studio export is documented in the API reference. Both are exactly the root's template and Studio exports, resolving to the same modules; terminal symbols remain root-only.
- Added the `domotion-svg/capture` and `domotion-svg/scroll` subpaths. Each resolves to a new curated `public` module holding exactly the documented capture or scroll exports (the subsystems' internal barrels also carry helpers that stay private), and the root now re-exports those same modules, so the root surface is unchanged and root and subpath imports share one module instance.

**Removed**

- Removed the authenticated paged-capture API and CLI mode, including its separately built Chromium helper and release workflow. Ordinary viewport and animated-scroll SVG capture are unchanged.

**Bug Fixes**

- launch Glassbox benchmark tools portably (DM-A7FAJM) (`0634aa7`)
- **fonts:** recover native resolver state (DM-W99VGJ) (`77471ae`)

**Refactoring**

- **text:** add explicit engine sessions (DM-4CN6YM) (`50e4ee3`)

**Documentation**

- precision fixes for Studio docs 241/242/245/246/247/250/253; drop dead vertical-text import (DM-S85DRM) (`aec4b79`)
- fix low-severity drift in docs 210-239 and enforce the capture-script rebuild rule (DM-DERQ97) (`02f8f4e`)
- fix low-severity drift in docs 180-209 (DM-07GVK3) (`e184082`)
- fix low-severity drift in docs 150-179 (DM-SAMJWB) (`aad91bc`)
- fix low-severity drift in docs 121-145 (DM-BJ7X8M) (`530ac43`)
- fix low-severity drift in docs 90-119 and clarify the cluster-fallback flag comments (DM-45TTCQ) (`9e83147`)
- fix low-severity drift in docs 61/63/67/70/78/80/82/238 (DM-K53XR0) (`26d1be6`)
- doc 03 fallback terminal is Blink standard font (times), not SF Pro (DM-H0A42W) (`30108d1`)
- mark deleted native-control renderers as history in docs 04/05/29, extend doc 172 code list (DM-YPE582) (`a851b04`)
- retire stale deferred/unbuilt claims in glyph-helper docs 16/41/45/49/50/52 (DM-TFFMHE) (`52f57d2`)
- correct template and transition docs 43/85/86/88/89/114/116/117 to the shipped schemas (DM-K4VTJP) (`e6acd10`)
- doc 66 shard caps, A/B override inputs, dispatcher flags and helper scripts (DM-4T25W0) (`0aa073c`)
- fix rich-text editing docs 100-104 (auto-end tracks, autoCompress default, guard ratios, code pointers) (DM-10ASM2) (`8fd3015`)
- close stale open items and shaping claim in doc 106 (DM-2H9083) (`c5427db`)
- document harness default flags and replace-not-merge env semantics; fix stale doc 42 acceptance (DM-ZCVD64) (`3c2baa5`)
- correct family-match CI and baseline claims in docs 109/110/111 (DM-504JKP) (`434ef61`)
- align doc 120 verdict vocabulary with what the gates emit (DM-D7QPTY) (`3a67074`)
- drop ambiguous bare doc-N aliases for reused numbers and reject duplicate aliases (DM-RA2F2K) (`e4e7553`)
- fix lifecycle status of 130/134/223/64/142/221/186 and require a successor link on superseded records (DM-PPPFAJ) (`2f49823`)
- correct front-matter platforms on platform-neutral docs (DM-84AWB6) (`eed5039`)
- correct native scrollbar gate status (DM-71RA4F) (`58aad5c`)
- update ideograph cache audit (DM-RB97X1) (`5762e96`)
- correct text engine and real-text maps (DM-VDHX51) (`67bcd33`)
- align Studio shell contract and CLI usage (DM-C1Q31G) (`22a2d01`)
- clarify Studio agent digest scope (DM-CEKMTX) (`53426a7`)

**Other Changes**

- DM-BQ71EW guard canonical AGENTS guidance refresh (`9ea0aaf`)
- DM-70NPGX make AGENTS.md the shared AI guidance source (`afe9f38`)
- DM-5TMTNV integrate AI guidance refresh and remove stray font fragment (`c2e3472`)
- DM-RT5TYX document bounded lower-third backdrop raster variation (`b4d4e55`)
- DM-9CXBDM refresh major-release public surfaces and showcase (`20b6765`)
- DM-AXV4GN Record reviewed macOS ideograph cache conformance baseline (`081a2e1`)
- DM-FWVMMP Compare FontInstance identity with Object.is so the cache-reset test stops timing out (`5bb8033`)
- DM-QP9R7N Document GC eviction of macOS ideograph fallback-cache entries as known, unmodeled nondeterminism (`aeca990`)
- DM-GNJ47P Record that capture keeps recording live generic families after a host-wide reset (`cc1d8b4`)
- DM-JWP8TE Bound each one-shot glyph helper call so a stalled helper fails instead of hanging the process (`962dfcb`)
- DM-GNJ47P Identify the host-wide event that resets generic families on hosted macOS runners (`89ffdbe`)
- DM-K7AA7T Keep each renderer session's CoreText helper history while sessions interleave (`2151c78`)
- DM-QQJ8JM Name a generic-family Settings reset between per-region rounds, and pin capture's behavior around it (`e1c2c26`)
- DM-Z0D8GT Tie the macOS glyph helper's CoreText fallback history to the renderer session (`0e67461`)
- DM-65628N Compare region-timing trees without the Page-owned generic-family record (`5dc2df5`)
- DM-AXV4GN DM-CDZ531 Re-record the macOS byte-00 synthetic font baseline under per-stack renderer and helper isolation (`2986c30`)
- DM-CDZ531 Restart the glyph helper with each stack's Chrome renderer in the macOS font conformance oracle (`7181f6b`)
- DM-FBT7V8 Redraw the pseudo-overlay test canvas on context restore and capture it only while live (`020462e`)
- DM-AXV4GN Keep cached ideograph faces live in the macOS font conformance oracle (`96c6d3c`)
- DM-4MP50V Re-record the macOS byte-00 synthetic font baseline under per-locale isolation (`85bbdf5`)
- DM-8KQ7M8 Re-record the exhaustive macOS synthetic font baseline at 0af2703e (`f74dbf0`)
- DM-4MP50V Re-record the Windows byte-00 synthetic font baseline under per-locale isolation (`0af2703`)
- DM-1WXKBZ Use CPU-backed canvases in the pseudo-overlay snapshot test (`7256805`)
- DM-8KQ7M8 Re-record the exhaustive Windows synthetic font baseline at 5589ef78 (`04f830c`)
- DM-1WXKBZ Re-query unlaid generic-probe rows and name the oracle probe failure (`632f23f`)
- DM-43VG5Q Give Windows private-use scalars Blink's Arial last-resort face (`5589ef7`)
- DM-1WXKBZ Record canvas context loss in the pseudo-overlay snapshot test (`dc518de`)
- DM-1WXKBZ Name the conflicting entries in the generic-family session error (`d4e916e`)
- DM-Q9BAAJ Export FontRendererSession type from the text-engine testing entry (`23eb8af`)
- DM-BZ5EZA Polyfill __name in shaping-conformance browser contexts (`cfa8486`)
- DM-Q9BAAJ Give each locale its own Chromium renderer in the macOS font oracle (`0871f00`)
- DM-1WXKBZ Force layout before the generic-family probe's CDP font queries (`fc49032`)
- DM-YT7SZ1 Keep DirectWrite fallback faces exact when a declared family shares the key (`a26f545`)
- DM-NX68YR DM-1EFA3S Pin Windows box drawing and supplementary CJK compatibility routes (`6dde0ba`)
- DM-WRKJAC Let system-ui take the Windows standard-style retry (`e6c2f7c`)
- DM-ANS8X4 Remove Windows fallback-stage CJK compatibility normalization (`17ea78f`)
- DM-RV1BQS Keep Windows normalization scalars in current face (`36d9594`)
- DM-Y4A64P Select TTC face for oracle coverage checks (`8528b31`)
- DM-6463JS Resolve Linux emoji Kelvin alias through declared chain (`7f7c8ce`)
- DM-WRKJAC Preserve Tahoma fallback for italic Arabic generic stacks (`096ab35`)
- DM-2NPYHD await painted font before Windows CDP query (`03badaf`)
- DM-B0PKD0 add text-engine workspace lint command (`c224d42`)
- DM-S2N2A2 normalize Windows CJK compatibility fallback (`9402032`)
- DM-S7XA3C gate fixture tables on installed corpus checkout (`02276eb`)
- DM-T37VD9 DM-F8G6N2 Repair Linux synthetic font routes (`01c2de1`)
- DM-T0T41W Record reviewed exhaustive synthetic font baselines (`eff8e54`)
- DM-KPXRNG Stabilize delayed Studio replay fixture on hosted macOS (`431180a`)
- DM-KPXRNG accept both timer states in Studio healing inspection (`155988c`)
- DM-DXBV8Z align Windows workflow assertion with browser transition step (`7d35e76`)
- DM-MPN88S Probe same-document Windows locale transition (`13f5ce5`)
- DM-B9PT1N Isolate Windows font oracle locales (`053bdd2`)
- DM-YYMK7S Record full stack key in mismatch examples (`7c40b7a`)
- DM-P05GVG DM-MF0C65 align conformance filter and source test (`9757f97`)
- DM-GVSBZQ use installed donors in oracle drift test (`48bac12`)
- DM-JKJZG6 preserve Linux feature baseline verdict (`57b7293`)
- DM-CT9TXF make Darwin cache-warming test portable (`2b43611`)
- DM-XHS572 keep Linux review fixture available after earlier failures (`114fc8e`)
- DM-DXBV8Z generalize font-size-adjust geometry and fallback (`b3617a8`)
- DM-GMZYRW match macOS SFNS font-size-adjust geometry (`6c314e0`)
- DM-WTFX33 seed hosted Arm64 family-match baseline (`86dc79c`)
- DM-5R5HG0 key macOS system-ui aliases by observed font options (`483ae57`)
- DM-KWKBQ5 mirror primary-only mixed shape reuse (`afd2aab`)
- DM-WTFX33 gate hosted Windows Arm64 family match (`0c5928c`)
- DM-WTFX33 Add hosted Windows Arm64 family-match candidate lane (`2f1263f`)
- DM-T0T41W Guard exhaustive synthetic baseline updates (`d2de1a9`)
- DM-6ZBGHV assert withheld exact-shaping evidence in report envelope (`5520cfb`)
- DM-ZHPRD0 reconcile dependency and text-engine convention boundaries (`a285888`)
- DM-NZ0JP2 refresh root source-contract assertions (`a2bc48d`)
- DM-M257TN refresh documentation discovery views (`691e005`)
- DM-X85EC0 document native helper freshness for Mac parity checks (`f6e7469`)
- DM-0X0YGS pin descriptor-scoped quoted system-ui transitions (`62c0c1a`)
- DM-0H2HSA Model canonical multi-scalar shape reuse (`dec9241`)
- DM-1SFJSS run Windows CJK transition in E2E lane (`f91c167`)
- DM-T8N4R9 key Darwin system-ui aliases by font description (`6808dff`)
- DM-EBRC7F: consolidate environment fingerprints and ratify native baselines (`0b0f2d5`)
- DM-FDBWVJ model Darwin FontData LRU across document GC (`2aebfda`)
- DM-FM49KF DM-1VDA2K Pin Chromium 147 shape cache behavior (`b447fc7`)
- DM-FM49KF Audit mixed-locale shape transitions (`51e44b2`)
- DM-WNS4J8 Model Windows system-ui primary notdef reuse (`14071df`)
- DM-VP9BZ6 Pin quoted system-ui document-GC route evidence (`26eb550`)
- DM-9DC90C Preserve small MathML radical bar rows (`805315d`)
- DM-6F4YJT Model macOS primary notdef shape reuse and isolate synthetic stacks (`71e56d8`)
- DM-24GQD3 Record native Windows radical validation (`25a37c8`)
- DM-B4ANRH Record native Windows singleton verdict (`46f4369`)
- DM-EZJKXN Clone varied macOS system UI fallback base (`468cb51`)
- DM-B4ANRH Enable CJK singleton oracle on Linux (`113f665`)
- DM-FJA838 Document macOS system-ui fallback clone investigation (`4120e73`)
- DM-PR2CFR Format conformance evidence and singleton test (`95c431b`)
- DM-QQJDH1 Document macOS mixed-language compatibility fallback evidence (`bf35a74`)
- DM-45XDW1 Resolve helper contract binary from text-engine build (`0b39880`)
- DM-036DG5 Add a fontconfig selection-reject control and ratify ten Linux Unicode rows (`9284592`)
- DM-SXZDJ7 Name the system-ui variation clone Blink builds for font-variation-settings (`bd365ce`)
- DM-JKFCWG Answer CJK compatibility ideographs with the renderer's shaped family (`bb50dfb`)
- DM-PP1V67 Probe the Common generic preference under a Common-script locale (`3a06416`)
- DM-9FGPXC Keep each CoreText cascade route's handle state for its fallback face (`4d2dc44`)
- DM-MFJY6V Run the fallback-guard fake helper as explicit CommonJS (`93fdc25`)
- DM-GPT363 Keep the standalone SF Pro OTF shortcut off the system-ui cascade (`68cc044`)
- DM-KVYBHD Record oracle donor signature in conformance artifacts (`7ff22df`)
- DM-V75PWJ stabilize macOS conformance oracle sessions (`7ca11a4`)
- DM-R91M61 Preserve warmed macOS UI cascade for case variant (`778190e`)
- DM-WPQYNX Restore build tools during Windows git prepare (`f124b02`)
- DM-X8V6RN Keep CoreText fallback face exact after declared family reuse (`174663b`)
- DM-JGBR0Y Match Arabic shaping test to native Chromium face (`a968471`)
- DM-MKJ5Q9 Detect macOS supplementary PUA oracle face flips (`89347db`)
- DM-5DDEED Materialize Chromium MathML dictionary inputs (`af2a132`)
- DM-GVHM8N Discover SwiftPM glyph extractor output paths (`5de26f6`)
- DM-5XAQND detect generic oracle donor drift during conformance (`387f8cb`)
- DM-N78DX3 Probe locale generic primaries through notdef (`a96bdc3`)
- DM-DKDHMF Ignore native CMake build output in ESLint (`dacb808`)
- DM-XJTBWV Batch ICU classification in synthetic font sweeps (`0278446`)
- DM-R1PYRR Repair documentation formatting and index (`b4bc85c`)
- DM-WRSAHZ Use complete captured styles in calibration fixture (`282af92`)
- DM-F0Y4QA Align macOS system-ui conformance with renderer font identity (`e495966`)
- DM-QD903D Authenticate same-image Windows font shard cohorts (`d0cccee`)
- DM-5YN25A guard font oracle baseline ratification (`2bb8355`)
- DM-R8PY8X Verify Linux baseline calibration with seeded ascent (`4438b26`)
- DM-EEAGXE Keep browser identity within audit scope (`1c4bfae`)
- DM-14DXG9 Pair native raster evidence across matching runner images (`f9d08bc`)
- DM-2V9AGG Exercise feature runner failure return across platform floors (`d806938`)
- DM-ZAJE6X Constrain Linux Unicode raster evidence to validated face mutations (`8c9f60c`)
- DM-JCXYD4 Version native raster report source fingerprints (`95e8e93`)
- DM-CFSHAD disable native helper in Linux mutation arm (`72b11a6`)
- DM-Q3AG3T index Windows font-route report docs (`63bc173`)
- DM-VEEPZZ: restore font-conformance CI setup (`82b13c5`)
- DM-Q3AG3T version Windows Unicode font-route reports (`f96b471`)
- DM-CFSHAD version Linux Unicode mutation reports (`2a61bdd`)
- DM-S85VEB version source drift evidence and preserve roll comparison (`2b670b8`)
- DM-DEV8XJ version PingFang descriptor evidence (`0c56b02`)
- DM-89A1RY: preserve empty visual shard completion (`04255cd`)
- DM-47DB3T version helper availability contract reports (`68e92c0`)
- DM-P1ASMP DM-BMKZN4 version pseudo-fragment report and refresh docs index (`78b0d44`)
- DM-BMKZN4: envelope transient family-match reports (`0973a25`)
- DM-NZRF7G version SFNS mask evidence reports and reratify identities (`7513996`)
- DM-K0GPP7 DM-X7MAQ8 DM-589ZF6 match radical text raster and refresh docs index (`1b14095`)
- DM-V5423X version animated image truth reports and reratify evidence (`a48b28d`)
- DM-X7MAQ8: capture HanKerning line-edge requests (`938f663`)
- DM-24GQD3 record Linux MathML radical evidence (`18b8064`)
- DM-589ZF6 inline nested cross-file SVG uses (`c7d4451`)
- DM-DT53N8: envelope specialized audit reports (`75fed9e`)
- DM-31KJ0F DM-VSQGBE DM-49WRZZ DM-XCR4NJ finalize report envelope docs index (`ecc75f8`)
- DM-49WRZZ: version native scrollbar audit reports (`d63cf8c`)
- DM-XCR4NJ migrate projective owner reports to envelopes (`b22150a`)
- DM-VSQGBE inline styled external SVG sprites as vectors (`49ae17d`)
- DM-WED9K9: port Blink HanKerning trim decisions (`f31c741`)
- DM-N6XJRS adopt versioned oracle and gate report envelopes (`0d6145f`)
- DM-XZZ0MS capture inherited MathML math style for radicals (`0d27e55`)
- DM-HM2BAY keep MathML dictionary check in sync with formatting (`6b7e4f1`)
- DM-M9KT76 migrate tool CLI boundaries and import guards (`eaab0eb`)
- DM-Z082AE migrate legacy browser probes to owned lifecycle (`0ef2e93`)
- DM-ERHTRB own capture rollback page state (`bceca82`)
- DM-WS5R8D DM-SCDE9X consolidate capture boundaries and restore mask priming (`2b400b9`)
- DM-7TNFX9: strictly type capture script modules (`cd280ec`)
- DM-WGF8AE: render OpenType MATH radicals from font geometry (`aea5765`)
- DM-H4BC1X: share browser ownership across tools and harnesses (`50a2bdb`)
- DM-254GVR split font resolution into focused modules (`53a00b0`)
- DM-5HXACA sync generated AI documentation packets (`ad4e2af`)
- DM-B9X6T7 separate oracle collection comparison and reporting (`0aa7632`)
- DM-JRB2H5 match Blink overflow marker eligibility (`f31006c`)
- DM-VY5DHJ exercise default text overflow marker capture (`b7ad49a`)
- DM-J875TW Extract text paint phases and consolidate form colors (`540d8bb`)
- DM-Y5HZ4Z Share render position clip and traversal helpers (`07fdc51`)
- DM-XEBRYE Split mask builders and share SVG tag editing (`1f15d67`)
- DM-KK5BP2 Extract font conformance sweep phases (`17dd558`)
- DM-EX6D5N Share decoration declarations and split style emitters (`6fcacc4`)
- DM-3H10QJ Render truncation marker through text engine (`9fc3bed`)
- DM-156VR5 Extract render mask and text readability seams (`798f599`)
- DM-WEAT59 Separate script analysis and formatting seams (`9a20160`)
- DM-QYTRKQ Scope Studio scene text artifacts to sessions (`20241b5`)
- DM-NT0X66 Extract font conformance tally and reporting seams (`fb168e9`)
- DM-BJ4Y3P Unify template parameter names with legacy aliases (`be99eea`)
- DM-XFNYKQ return feature suite failures to callers (`63459ee`)
- DM-7WRCDX align animate text-mode test with parse order (`0fb0674`)
- DM-652J8C unify border and outline stroke geometry (`3cc1dae`)
- DM-AP6BPA add shared tools command and report helpers (`ae55ebc`)
- DM-ESZXCM share Studio page selector helpers (`0ef81f5`)
- DM-GA3VC1 sample source-owned CSS conic animations (`1f6351f`)
- DM-323F8K split Studio UI and unify client requests (`0bb76b7`)
- DM-9JP366 split and harden visual test harness (`93b88bc`)
- DM-PQN8QN unify nine-piece border and mask paint (`25b250e`)
- DM-VESM0M: split CLI parsing from execution (`956f365`)
- DM-4E12K1: type browser comparison and glyph thresholds (`b1d3cfa`)
- DM-XNXA95: ratify Windows stock CDP support scope (`412c7eb`)
- DM-6VCX1C: unify modern gradient SVG emission (`b0d0f34`)
- DM-3RHW1N: format inline SVG requirement front matter (`70f9517`)
- DM-T239R3: build Git source installs before packaging (`e00d137`)
- shared shutdown handlers, friendly input-file errors, stray-positional rejection, one output writer, canvas-size inheritance, and a root-barrel import rule (DM-GJRDDF) (`ada6b23`)
- route tables over a shared createRouter, a pure generation verifier, and one error response shape (DM-YANNCS) (`1051cb1`)
- shared size/ms schemas, a chart body table, and a stat roll end read back from the odometer (DM-RG9A00) (`b4e1560`)
- paint the base-select picker icon as Blink's disclosure symbol marker instead of a hand-drawn triangle (DM-7TS81T) (`b99cebe`)
- record Blink's line-height: normal per element and use it instead of a 1.2em stand-in (DM-K5ZA1N) (`bf27a92`)
- inline external-file <use href="sprite.svg#icon"> references, and hand what cannot be inlined to Chromium's raster (DM-553Y54) (`6f4c090`)
- size the text-overflow marker from the shaped ellipsis instead of fitted ratios, and mark the other fitted geometry constants (DM-ZH9SXE) (`dd0aca5`)
- text-engine: paint the MathML radical from Blink's geometry instead of fitted fractions, and settle the other "no upstream rule" heuristics (DM-AQQ0DS) (`84eabb6`)
- text-engine: share the SVG-path parser, one variation-instancing helper, validate ICU helper rows, and collapse the face-record builders (DM-TH4VJN) (`8f29ba8`)
- transition tests for the rAF clock and the two probe promise caches, and count blocked Worker constructions (DM-00APHM) (`904221f`)
- forbid page-evaluated callbacks that reference module imports (DM-W71VF2) (`43ce576`)
- enforce import group order repo-wide, and fix a page-side import the reorder surfaced (DM-P1A3ZZ) (`6e21087`)
- text-engine, capture: one spelling for test seams, and plain names for production calls dressed as seams (DM-BJZHAG) (`9ec968a`)
- preview each region's caption on the image while the reviewer types it (DM-Q6WQNA) (`d246224`)
- paint a distinct touch pointer for cursor overlays with pointer: "touch" (DM-G999GK) (`cbb1a53`)
- replaced-element snapshots also hide overlays that force visibility with a class-level !important rule (DM-FTB9WG) (`f59591f`)
- resolve the conic tile's background-position through the shared <position> parser (DM-8Z4GDP) (`1e6401c`)
- chain the cursor between consecutive live scenes in interactive compile (DM-BM0JGT) (`374cba1`)
- untrack 303 throwaway probe scripts, keeping the 25 that a doc, test, workflow or package script cites (DM-EF2QY3) (`dfa9d08`)
- require data-key/id on .map() rows that hold a form field in the kerf browser clients (DM-DTT0HQ) (`0193f1c`)
- format font-conformance-iterate after the process.execPath change (DM-8EB2X8) (`4aae075`)
- crop-regions reads current slug-addressed Hot Sheet v2 tickets headlessly from the store (DM-A3QT31) (`36eb375`)
- one playwrightVersion() reader for every evidence producer; no npx spawn in the iterate script (DM-8EB2X8) (`2217acf`)
- pin the two perceptual-digest implementations together, validate source-drift payloads, share stableDigest (DM-Q9PQVG) (`1885643`)
- report silent degradations, name the fitted fallbacks and cite the verified Blink constants (DM-0RCVY3) (`c68c18d`)
- shared builtin helpers, a validated CSS-param surface, and three lifecycle fixes (DM-W1XWNZ) (`0ef03aa`)
- studio, scrubber: typed stale-head conflicts, one symlink-aware workspace resolver, shared HTTP helpers (DM-1PZQE2) (`bdcb2fd`)
- one exit-code contract (2 usage, 1 runtime) across every domotion verb, shared config-issue formatting and small boilerplate consolidation (DM-7C5PGY) (`54c4f2c`)
- capture, cli: replace non-null assertions and casts on captured/config data with narrowing (DM-PNKBP7) (`18b478a`)
- shared cleanup helpers so a failing disposer stops masking errors and skipping its siblings (DM-ZHB900) (`7363323`)
- stop transient failures pinning process-global emoji, embed and warning state (DM-YRTHCY) (`9d8dd56`)
- scope the nested-SVG flatten flag and pin the untested state transitions (DM-A0NZ6F) (`fd8cc3b`)
- route every transparent-color test through the canonical predicate (DM-S424WE) (`3e27bfe`)
- enable noUnusedLocals and remove the dead code it reported (DM-NH244Y) (`74f9993`)
- text-engine: share the fontkit open, sync retry and helper-response validation (DM-ZHRQBS) (`0c78e3f`)
- type withRealTextLayerVisualSemantics with the synchronous-callback contract its text-engine guard now enforces (DM-MR8EX5) (`1e30caa`)
- text-engine: enforce the synchronous-scope contract on the remaining guards and drop the legacy embedded-font map (DM-MR8EX5) (`2c87677`)
- own the raster tile caches in one module and reset them per capture generation (DM-Q3SG1D) (`abd5885`)
- text-engine: close four state hazards in invalidation, memo keys and document scope (DM-AF29Q0) (`9f430a0`)
- animation/cli: roll back rollback-state on every exit path; stop reading page errors as 'no target' (DM-KM1BY6) (`3bf441e`)
- fix region numbering, cancelled gestures and repeated setup; share the lightbox helpers (DM-4NVHMC) (`0bba11d`)
- guarantee pty teardown, add timeout/abort, share the cast-session setup (DM-966265) (`58a5cff`)
- capture-script: strictly type projective-state, counter-scopes, image-elements and fidelity-warnings (DM-KK6SVJ, slice 13) (`d2a47f3`)
- type the capture-script argument bag with full names and validate the returned tree (DM-KK6SVJ, slice 12) (`7864676`)
- capture-script: fold reference discovery and projective state into single calls; captureInner now under 300 lines (DM-KK6SVJ, slice 11) (`9cf6fe7`)
- capture-script: extract <img>/<input type=image> facts and the transform-subtree raster (DM-KK6SVJ, slice 10) (`09e7929`)
- capture-script: extract the text-bearing phase into walker/text-phase.ts (DM-KK6SVJ, slice 9) (`fb25983`)
- capture-script: move the fidelity warnings into walker/fidelity-warnings.ts (DM-KK6SVJ, slice 8) (`aff355a`)
- capture-script: name the record's raster/scrollbar/font-metric sub-records in walker/element-rasters.ts (DM-KK6SVJ, slice 7) (`a8b466f`)
- capture-script: extract native-control appearance, decoration and file-input capture into walker/native-controls.ts (DM-KK6SVJ, slice 6) (`8ad43bd`)
- capture-script: extract the per-element styles record into walker/style-record.ts (DM-KK6SVJ, slice 5) (`c930a6b`)
- capture-script: lift iframe recursion into walker/iframe-recursion.ts (DM-KK6SVJ, slice 4) (`f790ef0`)
- capture-script: lift scroll-marker-group and scroll-button capture into walker/scroll-markers.ts (DM-KK6SVJ, slice 3) (`90e43e1`)
- capture-script: extract the CSS counter scope pre-walk into walker/counter-scopes.ts (DM-KK6SVJ, slice 2) (`aa6d5d9`)
- capture-script: extract projective frame state and homography math from captureInner (DM-KK6SVJ, slice 1) (`342a52a`)
- report Node-side CDP probe failures as warnings instead of swallowing them (DM-SZ0FXX) (`ce47371`)
- key the client's dynamic list rows so focus and typing stay with their scene (DM-JN4KA3) (`48f1af2`)
- observe ffmpeg exit, drain stderr and kill on failure in svg-to-video and the scrubber export (DM-KY34N4) (`e5a27da`)
- text-engine: correct the helper-path regression test description (DM-TFFMHE) (`0b5cd41`)
- text-engine: correct fcLangProperty comment now that ui/gfx is readable (DM-2H9083) (`3aa104d`)
- DM-S4BSX9 correct docs 30 through 59 drift (`365c3ac`)
- DM-HAWK2M correct early documentation drift (`73fed4a`)
- DM-YD693C add manual test plan (`3c87739`)
- DM-T3A9W9 align conic gradient tile cache keys (`1a0ed71`)
- DM-MTK1WZ Reject empty conformance shards and malformed flags (`b5a12fc`)
- DM-BHQ7EE Document Studio AI adapter boundary (`011f6a7`)
- DM-73VDEA Correct helper-absent USE routing documentation (`1ac84b5`)
- DM-XWNYVN Update raster fallback index for pseudo surfaces (`a635f11`)
- DM-FCT8FM Document nested SVG flattening option (`581913e`)
- DM-J1GKJM resync the font-resolution diagram, AI summaries, and CLAUDE.md pointers after the requirements audit (`be31484`)
- DM-BGF2J1 keep the text-engine ./testing entry exported if the workspace is published (`6eed9e3`)
- DM-66KD4M hold the text-engine stable entry points to exactly what production imports (`918e23c`)
- DM-QXW2H7 curated public entry files and subpaths for capture and scroll (`d9d555a`)
- DM-SSJK9Y add domotion-svg/templates and domotion-svg/studio subpaths (`b248f29`)
- DM-6NS46P make the vertical-rtl-fractional-zoom-scroll projective-owner profile actually scroll (`eaae9e1`)
- DM-7GC0MM move engine-only root tests into the text-engine workspace and narrow its entry points (`b1b5168`)
- DM-3J7BNQ point CLAUDE.md at the text-engine glyph-helper modules (`a6ccd64`)
- DM-084XNQ resolve native helpers under packages/text-engine/tools (`c81b9c8`)
- DM-HKY512 make the text-engine workspace suite pass on Linux (`afa91a8`)
- DM-YBSGMF document every root export in docs/api.md and enforce it with a test (`b6a4658`)
- DM-THB1ZE add render, animation and tree-ops package subpaths (`b887f5c`)
- DM-9TGDYG keep vertical/RTL projective-owner fixture on canvas and fail closed on off-canvas owners (`8928820`)
- DM-6D3Q5R make a release consume the changelog's Unreleased section (`9f4862d`)
- DM-49QAPR run the text-engine workspace test lane in CI (`f4e9618`)
- DM-TR6K86 build dist/ before CI e2e and fail dist-spawning e2e on missing prerequisites (`32f8354`)
- DM-DS8AGC route root text adapters through the text-engine public entry points (`69fe40f`)
- DM-60M21G DM-BZHPYX Prettier-format check-package-dist.mjs (`2f2f0d2`)
- DM-YRM5W4 prove the helper no-serve switch by counting spawns, not timing (`e8ca61c`)
- DM-QSQ43B test the CLI --optimize to WOFF2 chain end to end (`efad37c`)
- DM-TF7QX8 resolve Windows backslash artifact paths in the projective-owner release adjudicator (`3b7a06d`)
- DM-JJXP25 pack-install-import smoke test for the bundled tarball (`356e5fa`)
- DM-G36795 keep acquired ICU companion out of the npm tarball (`8a04e59`)
- DM-Z36CPR register woff2-fonts.test.ts under render.optimize (`8d0a316`)
- DM-9JDYSM make changelog insertion idempotent per version (`e7bd4c4`)
- DM-ZBCK6T add a package exports map with a post-processing subpath (`d092d65`)
- DM-GBKZY0 build text workspace in fresh CI installs (`41d5e21`)
- DM-A1KCSY extract text engine workspace (`a001653`)

## [0.30.1] - 2026-09-21

**Other Changes**

- DM-VB8TFK parse formatted documentation metadata (`ecdb27f`)
- DM-663W8E keep release output Prettier-clean (`5dd361a`)
- DM-5P2R1V tolerate fixed-point font axis boundaries (`89dd19e`)

## [0.30.0] - 2026-09-21

**Features**

- **render:** vertical writing-mode support in system-font text mode (DM-ZDDJAG) (`b55feac`)
- **render:** opt-in flatten of captured DOM inline <svg> (DM-7AN9AH) (`4bf1019`)
- **render:** opt-in flatten of inlined <img src=*.svg> nested <svg> (DM-K0S6ZS) (`2fb7943`)
- **render:** viewport→viewBox affine matrix helper for nested-SVG flattening (DM-DQXZ6K) (`88fe341`)
- extend the real-text layer to multi-frame compositions (DM-6SQXGF) (`0a600e9`)
- **cli:** expose --text-mode on the animate CLI (DM-FJZQ34) (`62ad8aa`)

**Bug Fixes**

- **package:** reject stale publish artifacts (DM-2CV587) (`dc2df92`)
- isolate capture warning snapshots (DM-MYC908) (`412a7d5`)
- exempt spelling checker fixtures (DM-EWNGBZ) (`db4b57b`)
- **scroll:** honor --text-mode in --scroll composition (DM-N8QM80) (`466b23d`)
- **render:** anchor rtl runs correctly in system-font text mode (DM-CAGCSM) (`bde6b5c`)

**Refactoring**

- **animation:** decompose compose coordinators (DM-BQ56Q5) (`33c9b11`)
- **animate:** extract compressed run stages (DM-JGFVKQ) (`910b823`)
- **animate:** extract captured frame stage (DM-84TS9P) (`9e8de7e`)
- **render:** extract SVG orchestration phases (DM-M0VQRV) (`0a7c201`)
- **DM-6V14D0:** extract SVG border paint owner (`cb2578d`)
- **DM-4GNE29:** extract SVG text paint owner (`9628b3a`)
- **DM-WKDRTJ:** extract background fragment paint (`a43e9d1`)
- **DM-HXSBE7:** decompose inline SVG decisions (`562bbba`)
- **DM-CJ1B9J:** decompose mask clip decisions (`ddb74b4`)

**Documentation**

- map current records to code owners (DM-4XG98E) (`e01a0a0`)
- synchronize AI summaries (DM-5RTP88) (`3d5f586`)
- prep major release surfaces (DM-SJJCPG) (`2f386d8`)
- **svg-flatten:** design-tool import test corpus (DM-X6GGXV) (`3acd981`)
- **examples:** add system-font text-mode examples + local visual check (`6422bf5`)

**Tests**

- **DM-VQ7K9E:** refresh embedded-frame animation goldens (`a2d6f5c`)
- **cli:** lock Studio help routing (DM-6G21VG) (`abf88d1`)
- **studio:** cover interaction observer boundaries (DM-H613C1) (`c500d3c`)
- stabilize browser E2E resources (DM-0MAZSK) (`aa09353`)

**Build System**

- **DM-6KS6V6:** upgrade Vitest to 5.0.1 (`fe42cac`)

**Chores**

- migrate Hot Sheet AI configuration (`f9b4321`)
- **site:** remediate non-breaking audit findings (DM-BP9M7D) (`1a04438`)
- enforce American-English prose (DM-98PJFX) (`1de4c53`)

**Other Changes**

- DM-CZ20DD upgrade site security dependencies (`0e23471`)
- DM-831XJY apply repository Prettier formatting (`a9a1660`)
- DM-FM5DRJ document required Chromium preflight (`ca2056e`)
- DM-7M521J document merged coverage pipeline (`8b3a67c`)
- DM-FDMFB7 collect browser client coverage (`9ee562d`)
- DM-KW8DEY patch root dependency vulnerabilities (`b65f18f`)
- DM-EC0FSE preserve embedded scene at crossfade boundary (`0aca0c7`)
- DM-HXN6Q1 require Chromium for browser E2E (`ecb556d`)
- DM-E5Q6R2 refresh animate goldens (`ce238c7`)
- DM-MBF285 merge Vitest coverage maps (`95eb770`)
- DM-NBA2W8 fail merged coverage on suite failures (`186470d`)
- DM-P2P7MH migrate Astro Markdown integration (`c677240`)
- DM-03JJVJ refresh major release visuals (`5292a2b`)
- DM-FZ5734 scope HiDPI render factor (`291d7e9`)
- DM-S9HCAT extract animation stage helpers (`e29e6b7`)
- DM-CMKF35 extract SVG outline paint owner (`d80f6fc`)
- DM-K6YQBK decompose capture walker handlers (`d4ed1a6`)
- DM-S31XF3 decompose Studio dispatchers (`e6cc075`)
- DM-8GHWH8 calibrate macOS font inventory drift (`756566e`)
- DM-48MFKS remove authenticated paged capture (`6f55099`)
- DM-MNS4AJ add real text to terminal and JS-reveal frames (`e947563`)

## [0.29.0] - 2026-09-17

**🚀 Features**

- **Authenticated paged capture** (`domotion capture --paged`): render a multi-page, login-gated document to one self-contained SVG per page, written as an atomic `.domotion-pages.json` bundle (manifest last). The print step runs through a pinned, cryptographically authenticated Chromium helper (helper manifest + SHA-256), and each page SVG passes through only after a live logical-consistency audit.
- **Opt-in real-text layer** (`domotion capture --real-text`, or `elementTreeToSvg(tree, w, h, { realTextLayer: true })`): append a paintless authored `<text>` layer so an inline `<svg>` has searchable, selectable, copyable text and a real accessibility flow — the visible glyph geometry is unchanged. Has no effect through `<img>` embedding.
- **Selectable text-emit mode** (`--text-mode <embedded-font|paths|system-font>`, or `elementTreeToSvg(…, { renderTextMode })`): the new `system-font` mode emits ordinary `<text>` carrying the authored `font-family` stack and lets the viewer's own installed fonts paint it — much smaller output where the fonts are known to be present (not pixel-faithful, positions reflow with the viewer's font). The flag also newly exposes the two existing fidelity modes — `paths` and the default `embedded-font` — on the CLI.

**⚡ Performance**

- Linux font fallback now memoizes fontconfig matches, cutting repeated per-codepoint match cost on Linux captures.
- Text-geometry probing during capture is batched, reducing round-trips into the page.

## [0.28.2] - 2026-09-07

**🐛 Fixes**

- Element-owned scroll captures now keep positioned, higher-`z-index` siblings pinned above the moving content. Previously all static page context was drawn beneath the scrolling element, reversing CSS stacking wherever a foreground card overlapped it; static siblings that paint after the scroller are now emitted as separate foreground layers, each clipped only by the overflow clips it actually shares with the scroller (never by the scroller's own scrollport).

## [0.28.1] - 2026-09-07

**🐛 Fixes**

- Long scroll animations owned by an inner scrollable element (via `selector`) are now captured in steps sized to that element's own client box instead of the outer capture viewport, so the stacked composite no longer shows blank, uncaptured bands between slices when the element is shorter than the surrounding capture.
- Page state snapshots now report the live scroll owner's client width and height; custom `PageQuery` implementations that omit them keep the previous viewport-sized stepping.

## [0.28.0] - 2026-09-07

**🚀 Features**

- Element-owned scroll captures (`scroll.selector` / `--selector` with a page-level capture) now keep the surrounding page static and animate only the scroller's contents in place, instead of translating the whole captured page. Selecting the scroller itself as the capture root still produces the list-only strip.
- `domotion animate` re-anchors a `scroll` frame's nested timeline to that frame's offset on the master loop, the same way `cast` and animated `template` frames already work. The scroll holds its first state before its window and its last state after it, and the CLI logs a sizing note when the frame `duration` is shorter than the scroll's play time.
- Pauses in a scroll pattern now always contribute to the output period. An unchanged DOM during a pause becomes a non-painting hold at the same offset (new optional `timelineOnly` marker on scroll segments), so leading, middle, and trailing pauses are honored without duplicating identical content in the SVG.
- New `inner-element-scroll` animate example: a dashboard whose activity feed scrolls in place while the shell, metrics, and guide stay fixed.

**🐛 Fixes**

- Inner scrollers nested inside an `overflow: hidden` ancestor with rounded corners no longer square off those corners while scrolling. The composer now nests every clipping ancestor's padding-box clip, including per-corner radii and `overflow-clip-margin`, around the moving stack.
- Pause durations in scroll patterns are no longer lost or stretched into the preceding motion when the DOM does not change during the pause.
- The strict no-motion parity check (`passesStrict` in the PNG comparison module) no longer fails on sparse glyph-edge components that host rasterization moves across the default gate's severity threshold. It now bounds the severity-inclusive region aggregates only, with the total-area cap raised to 3072 px while the 256 px single-component cap still rejects genuine paint-order or position changes. Passing `null` caps still falls back to the default gate.

## [0.27.2] - 2026-09-07

**🚀 Features**

(Domotion Studio is a very early preview concept and isn't really ready for normal use yet)

- **Domotion Studio**: a new `domotion-studio` CLI (also `domotion studio [project.json]`) opens a local visual workspace for authoring animated demos. `--workspace <dir>` scopes the directory its file browser may access.
- **Versioned Studio project format**: projects are durable `domotion-studio-project` JSON files with a published JSON Schema (`schemas/domotion-studio-project.schema.json`). Existing storyboard configs can be imported, and static scenes and nested layer compositions compile through the current storyboard and composite pipelines.
- **Semantic interaction tracks**: describe clicks, hovers, typing, scrolling, and drags by target role and accessible name instead of selectors; Studio compiles them to capture actions, plans natural cursor choreography for the cursor overlay, and observes hover/mutation evidence for each step.
- **Interactive scene compilation with AI healing**: interactive segments capture the live page while replaying semantic tracks, and a healing loop re-inspects the page and repairs broken targets across revisions.
- **Structured AI video review and unified annotations**: render a project to video, collect per-dimension review findings, and store human and AI annotations (including imported `svg-review` regions and `svg-scrubber` review notes) in one annotation model with revision history.
- **Cinematic treatment library**: reusable presets (device chrome, masks, overlays, transitions, brand-aware layers) applied to scenes at compile time.
- **Embedded SVG Scrubber preview and multitrack timeline**: Studio embeds the scrubber via a postMessage protocol that preserves playhead, range, zoom, pan, and speed across regenerations, and adds a detailed timeline for moving and resizing scene, action, cursor, overlay, transition, treatment, annotation, and animation items.
- **Real interaction recording import**: record a real browser session and import it as semantic Studio tracks, with typed secret values redacted before persistence.
- **Agent tool protocol**: a versioned, schema-described request/response interface for AI agents to author scenes, tracks, and annotations and trigger generation.
- **Storyboard scene trimming**: scenes accept `trimStart` / `trimEnd` (ms) so an embedded animated SVG starts at a source-local offset while keeping the browser's native interpolation.
- **New public exports**: the Studio API (project, compile, interactions, healing, review, treatments, timeline, agent tools) and the scrubber embed protocol are exported from the package index; `compositeLayerAnimationSchema` and `storyboardCaptureSourceSchema` are now exported for reuse.

**🐛 Fixes**

- **Scroll frames following a capture frame no longer corrupt earlier text**: the nested scroll document keeps the outer animation's glyph and font generation, is namespaced as a whole, and its glyph definitions are emitted once at the document root, so the leading capture frame stays pixel-identical.
- **Re-nesting an already-composed animated SVG** now prefixes the existing embedded-font family name as one identifier (for example `sb0_dmf0` → `outer_sb0_dmf0`) instead of splitting it, preventing text in other frames from reshaping with the wrong font.
- **Scroll composer emits each shared glyph definition once** across multiple segments rather than duplicating it per segment.

## [0.27.1] - 2026-09-05

No user-facing changes in this range. Everything between v0.27.0 and HEAD is test-lane configuration, CI workflow tooling, fixture fonts for the Windows conformance gate, and documentation; the published package's capture, render, animation, and CLI behavior is unchanged.

## [0.27.0] - 2026-09-04

**🚀 Features**

- Emoji and other color/bitmap glyphs (sbix, CBDT, COLR, OpenType SVG) inside `::before` / `::after` / checkmark content now render through an isolated Chromium-painted surface that replaces only that text, instead of a monochrome outline; pseudo text also honors the computed `font-variant-emoji` preference.

**🐛 Fixes**

- `text-shadow` on text with `-webkit-text-stroke` or underline/line-through decorations now paints the stroke and decorations in the shadow color, and shadow and foreground decorations no longer share a clip id.
- Mixed-script text that spans multiple fallback fonts (for example CJK plus Latin in vertical or transformed text) now maps correctly through the text-fragment geometry pipeline instead of failing the split.
- Generic font families (`serif`, `sans-serif`, etc.) resolved from a live session are now replayed by family name on Linux and Windows and by PostScript name on macOS, matching what fontconfig, DirectWrite, and CoreText each accept.
- macOS Unicode fallback routing now records which faces are optional installs (such as Noto Sans and Noto Sans KR) rather than assuming they are present on every machine.
- `svg-scrubber` no longer accepts play/scrub actions while an SVG is still loading, so controls are not reset by the pending load on slower hosts.
- The `animate` command's outside-region mismatch error now shows where the captured content first diverges, instead of only reporting that it differs.

## [0.26.3] - 2026-09-03

<!-- No user-facing changes in this release. -->

There are no user-facing changes in `v0.26.2..HEAD` — the single commit only adjusts an internal font-path integrity test and adds a non-behavioral `optionalInstall` marker to font-table entries to support it. Nothing in the diff alters capture, rendering, animation, CLI flags, or output, so every template section is omitted.

## [0.26.2] - 2026-09-03

<!-- No user-facing changes in this range: both commits are CI/test/tooling only (a GitHub Actions workflow context linter and an internal color-space oracle test tweak), which the template excludes. -->

## [0.26.1] - 2026-09-03

<!-- No user-facing capture, render, animation, CLI, or fidelity changes in this range; all changes are release/CI infrastructure, tests, and docs, which the directives exclude. -->

## [0.26.0] - 2026-09-03

**🐛 Fixes**

- **Dashed and dotted outlines** now start a fresh dash at each corner and run between the outer corners, matching Chrome's outline painter — this corrects both the dash phasing and the gap widths on square (non-rounded) outlines.
- **Border-collapse:** a `<td>`/`<th>` restyled to `display: block` is no longer pulled into the collapsed table grid, fixing a stroke that was shifted onto the table grid line (~5px off).
- **Windows — real small caps:** faces that carry `smcp`/`c2sc` (e.g. Georgia) now render with the font's actual small-cap glyphs instead of a synthetic 0.7-scaled fallback.
- **Windows — bitmap strikes:** embedded-bitmap/GDI-classic text (e.g. SimSun at small sizes) is retained as a raster so it matches Chrome's native terminal mask rather than being replaced by a vector subset.
- **Windows — `.notdef` glyphs:** an explicitly selected `.notdef` glyph is now painted as an outline the way Chrome paints it after fallback is exhausted, while an ordinary coverage miss still continues to fall back correctly.
- **Windows — unavailable authored families:** an author-named family that isn't installed (e.g. Hiragino Mincho) is now skipped instead of being mis-mapped to SimSun, so CJK text falls back the way Chrome does.
- **Linux — sharper embedded text:** expanded the exact hinted target-strike coverage (Liberation Sans/Serif across more sizes and weights) for pixel-faithful body and heading text; mixed full/small-cap runs are now split into per-size strikes so synthesized small caps match Chrome's independently measured ink heights.

## [0.25.0] - 2026-09-02

**🚀 Features**

- Debug reproduction bundles now work for animated SVGs: `animate --debug` writes a HAR, expected frames, the captured tree, and the output SVG — the same way `capture --debug` does — and there's a programmatic API for producing these bundles from code.
- CSS `corner-shape` (superellipse / squircle corners) now renders as crisp vector contours.
- `-webkit-box-reflect` reflections are emitted as native vector paint instead of being dropped.
- Static CSS 3D transforms are projected onto vector planes rather than falling back to raster.
- `-webkit-line-clamp` truncation, including the trailing ellipsis, is now captured and rendered.
- Broader native form-control coverage: native scrollbars, the file-upload selector button, and closed `<select>` picker indicators are captured and drawn.
- `font-palette` and COLR palette color fonts are supported.
- Embedded font subsets keep their TrueType hinting by default, sharpening rasterized text on Linux and Windows.

**🐛 Fixes**

- Radial gradients: percentage-based radial ellipses render correctly again, and repeating-radial period, focal, and color-hint geometry now match Chromium.
- Gradient interpolation, legacy `-webkit-gradient` endpoints, and conic-gradient tiling now follow Chromium — and conic gradients paint inside generated (pseudo-element) content.
- Border fidelity: collapsed and fragmented table borders, thin dotted borders, mixed dashed/dotted joints, rounded side clipping, and effective-zoom border geometry all match Chromium more closely.
- Text and shaping: cursive (Arabic) shaping and shaped cluster origins are preserved, dotted-circle insertion follows the font's coverage, MathML fence and italic-token placement is corrected, and font optical sizing is honored.
- Linux text rendering picks the correct fontconfig TTC face index and matches Chromium's glyph strikes for Latin Extended and WenQuanYi headers.
- Text inside affine/projective transforms stays legible and correctly positioned.
- Form fields use Chromium's input text geometry, and closed `<select>` display text is aligned correctly.
- Images and backgrounds: local SVG background tiling and local bitmap natural sizing are restored, and generated (`content:`) image intrinsic paint is preserved.
- Resize handles keep their shadow ink and integer-zoom borders, list markers align to the full marker advance, and flex-item paint order is preserved.
- Looping animations close cleanly at their starting frame, removing a visible seam at the loop point.

## [0.24.0] - 2026-08-16

**🚀 Features**

- **`background-blend-mode` now supported** — each background image layer blends against the layers below it, including the element's own background color, inside an isolated group.
- **True `backdrop-filter` rendering** — elements with a `backdrop-filter` now preserve Chromium's actual composited backdrop pixels via an isolated snapshot placed at the element's paint position, instead of the frosted-glass color approximation (which remains as a graceful fallback when a snapshot can't be captured).
- **Multi-select listbox options render with real styling** — `<select multiple>` / `size > 1` options now paint from their captured layout and author styles (including `:checked` row backgrounds) rather than native defaults.

**🐛 Fixes**

- **Emoji that previously vanished now render** — default-emoji characters outside the main emoji planes (Watch, Hourglass, the media-control buttons, and the Mahjong Tiles / Playing Cards blocks) now route to the color-emoji path instead of disappearing on faces with no vector glyph.
- **Dotted circles for orphaned combining marks** — standalone Indic/Vedic marks now get the same U+25CC dotted circle Chromium paints, using the resolved fallback face and script, fixing missing or duplicated circles in complex-script text.
- **Gradient stop lengths resolve correctly** — font-relative and viewport-relative gradient lengths (`em`, `rem`, viewport units) and `calc()` sums now resolve in the element's real style context, fixing mispositioned gradient stops.
- **Vertical text baselines** — vertical columns and text-combine (tate-chu-yoko) runs now place glyphs on each run's measured baseline, correcting upright and rotated glyph positioning.
- **`::before` / `::after` box sizing** — generated-content pseudo-elements are now measured through a real Blink layout, so `calc()`, intrinsic sizing, logical properties, and writing mode produce accurate boxes.
- **List markers match Chromium geometry** — disc, circle, square, and disclosure-triangle markers use Blink's exact size, offset, and edge-snapping rules.
- **Multi-column rules respect spanners** — a `column-span: all` element no longer causes the column rule to draw through the spanning content; rules are captured as physical per-row segments.
- **Native form controls keep their outline overflow** — control snapshots now include author outlines (e.g. `:valid` / `:invalid` rings) that extend beyond the themed border box.
- **File-input button labels render as glyph paths**, matching the rest of the text pipeline for consistent typography.

## [0.24.0] - 2026-08-16

**🚀 Features**

- **`background-blend-mode`** — each background image layer now blends against the layers below it, including the element's own background color, inside an isolated group.
- **Real `backdrop-filter` rendering** — elements with a `backdrop-filter` now embed a Chromium-composited raster snapshot that preserves the actual blurred/filtered backdrop pixels, clipped to the element's border contour, instead of the approximate frosted-glass solid fill (which remains as a fallback).
- **Multi-line `<select>` listboxes** — options in a `size`/`multiple` listbox now render with their real per-row layout, author background/text colors, and selected-row paint.

**🐛 Fixes**

- **Gradient length units** — font-relative (`em`, `rem`, viewport) and absolute (`in`, `pt`, `q`) length stops and radial positions now resolve to the correct pixel offsets, including the percentage term inside `calc()`.
- **Default-emoji glyphs no longer vanish** — WATCH, HOURGLASS, the media-control buttons (U+231A–U+23F3), and the Mahjong Tiles / Playing Cards characters now route to the color emoji font instead of dropping out as empty cells.
- **Dotted circles for orphaned combining marks** — standalone/uncovered marks (including lone Vedic marks) now correctly show the dotted-circle placeholder that Chromium paints, and no longer over-insert circles for marks Chromium leaves bare.
- **Multi-column `column-rule`** — column rules are now drawn as per-row segments, so a `column-span: all` element no longer causes a rule to be painted straight through the spanning content.
- **`::before` / `::after` sizing** — generated-content boxes are now measured through a real Blink layout, so `calc()`, CSS variables, intrinsic sizing, logical properties, and writing mode resolve to the correct box and text rects.
- **List markers** — disc, circle, square, and disclosure markers now use Blink's exact ascent-based size/offset geometry and edge snapping, fixing subtle marker size and position drift.
- **Vertical text baselines** — upright, rotated, and text-combine runs in vertical writing modes are placed using each run's captured font ascent, correcting baseline placement for mixed CJK/Latin columns.
- **Native form-control overflow** — control snapshots now include author outlines (e.g. `:valid`/`:invalid` focus outlines) that paint outside the themed border box.
- **File input button label** — the file-picker button label is now emitted as glyph paths for consistent text fidelity.

## [0.24.0] - 2026-08-15

**🚀 Features**

- **`backdrop-filter` now renders faithfully.** Elements with a `backdrop-filter` preserve Chromium's true composited result — the page pixels sampled behind the element, the filter chain, translucent background, descendants, and border clipping — via an isolated raster snapshot, replacing the old solid frosted-glass fallback.

**🐛 Fixes**

- **More emoji render instead of vanishing.** Watch, hourglass, and media-control buttons (Misc Technical: U+231A–U+23F3) plus the Mahjong Tiles and Playing Cards blocks now paint from the color-emoji font on platforms where Chromium selects it, instead of dropping to an empty cell.
- **List markers match Chromium geometry.** Disc, circle, square, and disclosure-triangle markers use Blink's font-metric integer sizing/offset and physical pixel snapping, so marker size, position, and disclosure direction are correct across font sizes.
- **Vertical text sits on the right baseline.** Upright glyphs, rotated runs, and text-combine (tate-chu-yoko) cells now use each run's captured font ascent, fixing glyphs that dropped ~0.85em below their cell in mixed columns.
- **Gradient lengths resolve correctly.** Font-relative and viewport-relative gradient stop/position units (`em`, `rem`, `vw`, …) and `calc()` expressions with percentage terms now resolve against the right context, and exact CSS absolute units (`in`, `pt`, `Q`, `cm`, `mm`, `pc`) convert at spec 96dpi.
- **Listbox options paint with author styling.** Multi-row selects (`multiple` / `size > 1`) now use the browser-measured row geometry and resolved author styles — including selected-row background and text color — instead of reconstructing rows from native constants.
- **Native controls keep author outline overflow.** Themed control snapshots now include author `outline` visual overflow (e.g. `:valid` / `:invalid` outlines) rather than clipping to the border box.
- **File-input button labels render as glyph paths**, matching the rest of Domotion's text output.
- **Orphan combining marks get their dotted circle.** Lone marks that Chromium circles (e.g. standalone Vedic marks) now have the dotted circle inferred from shaping, even when it can't be observed at capture time.

## [0.23.0] - 2026-08-14

**⚠️ Breaking Changes**

- **Page navigation now waits for `load` instead of network-idle by default.** Real-world pages that keep analytics, long-polling, or streaming requests open no longer stall or time out before capture. If you relied on the old behavior for a controlled, finite request chain, pass `--network-idle` on the CLI (or `networkIdle: true` in a template config) to restore the stricter wait.

**🚀 Features**

- **Vertical writing modes now render as crisp, scalable glyphs.** `vertical-rl`, `vertical-lr`, and `sideways-*` text uses Blink-matched line-relative transforms instead of a rasterized element snapshot, so it stays selectable and sharp at any scale.
- **`font-variant-alternates` with `@font-feature-values` is now honored.** `stylistic`, `styleset`, `character-variant`, `swash`, `ornaments`, `annotation`, and `historical-forms` resolve to their OpenType features, scoped to the declaring font family.
- **CSS `url(#filter)` references to inline SVG filter graphs are preserved** and evaluated in the element's local coordinate space, so coordinate-sensitive `feTurbulence` / `feDisplacementMap` chains render as Chromium paints them.
- **New `--network-idle` capture flag** to opt into waiting for 500 ms of network quiescence during navigation.

**🐛 Fixes**

- **Windows font selection** now tries the preferred standard face before the hardcoded/DirectWrite fallback, matching Chromium (e.g. U+2100 now paints Times New Roman rather than Lucida/Tahoma).
- **Vertical-mode text-emphasis marks** now take their metrics and position from the correct fallback face instead of an em-fraction approximation.
- **CSS counters** now follow document tree order across siblings and both `::before`/`::after` pseudo-elements.
- **Non-affine 3D subtrees** (`preserve-3d` / `matrix3d`) and **OS-native form controls** (`appearance` other than `none`) are now captured as Chromium bitmap snapshots where SVG can't reproduce their projective or platform-themed paint.
- **Dynamically discovered fonts** (e.g. runtime-installed Vedic faces) now shape correctly, keeping HarfBuzz's dotted-circle marks for leading combining characters.

## [0.22.2] - 2026-08-13

<!-- No user-facing changes in this range: both commits only stabilize test assertions across CI font inventories. Template requires omitting empty sections, leaving no output. -->

There are no user-facing changes in `v0.22.1..HEAD` — both commits only stabilize font-fallback test assertions across CI runner font inventories (test-only changes, which the template excludes). Every section would be empty, so the release notes are intentionally blank.

## [0.22.1] - 2026-08-13

_(No user-facing changes in this release — all changes are test-only environment fixes.)_

## [0.22.0] - 2026-08-13

**🚀 Features**

- **Frame-sequence compression for editing animations** — a run of consecutive editing states now composes into one self-contained animated SVG where shared content is emitted once and only per-keystroke deltas animate. Available declaratively via a `states` block (with auto-carets) and as `composeCompressedRun`. Automatic detection is now on by default; opt out with `"autoCompress": false` or `--no-auto-compress`, or opt in per-run with a `compress: true` marker. A size-regression guard guarantees compression never grows the output.
- **Caret & selection tracks** (`textTracks`) — declarative carets and selections anchored to Chromium's own captured glyph positions, with logical-order addressing across RTL/bidi runs, vertical writing modes, and mixed inline content. Adds a block-caret `invert` option (repaints the covered glyph) and behind-glyph (true editor z-order) selection.
- **Parameterized & custom transitions** — built-in transitions now take parameters, plus a normalized transition schema and support for safe custom transition recipes and angled linear wipes.
- **Per-region animation timing** — declare regions by selector (`regions`) and tag each state with what it `advances`, so independently-updating panes run on their own schedules.
- **Richer typing overlays** — `anchor.baseline: true` lands overlay text on an element's real text baseline, and `holdToFrameEnd: true` holds a typed line through the frame for a seamless handoff to captured page text. Overlays gain an explicit `endAt` window and support per-state overlays inside a compressed run.
- **WOFF2 font compression** — the CLI `--optimize` pass now recompresses embedded fonts to WOFF2 (new `compressEmbeddedFontsToWoff2` export), cutting font bytes ~40% in text-heavy output.
- **Hinting-preserving embedded font subsets, on by default** — embedded subsets now retain the source font's TrueType hinting (variable fonts fully instanced at the resolved axis), sharply improving text fidelity on Linux and Windows. Set `DOMOTION_HINTED_SUBSET=0` to fall back.
- **CSS font property support** — `font-variant-emoji`, `font-feature-settings` disables/values, `font-synthesis` (weight/style/small-caps vetoes), and `font-stretch` (width-axis instancing and cut selection) are now honored, shaped through HarfBuzz where needed.

**🐛 Fixes**

- **Text decoration** — decorations now propagate to in-flow descendants and accumulate down the ancestor chain (a bold or sub/sup child no longer drops the line); dashed/dotted dash geometry, skip-ink gaps, `text-underline-position: under`, and overall decoration geometry are transcribed from Chromium instead of fitted approximations.
- **Complex-script shaping** — Arabic, Hebrew, Devanagari, Telugu, Hangul, Thai/Lao, Myanmar, Khmer and Bengali now shape through HarfBuzz for correct joining, clustering, reordering and dotted-circle behavior; bidi handling is fixed for `unicode-bidi: bidi-override` and for SMP right-to-left scripts.
- **Cross-platform font selection** — large parity improvements to which face and cut Chrome actually paints on macOS, Linux and Windows (declared-family cut ladders, system-ui, generics per content script, weight/optical-size axes), plus synthetic bold and oblique now baked into embedded glyphs where the resolved face lacks the requested style.
- **Color emoji** — sbix emoji overlays self-calibrate to Chrome's painted pixels, and emoji are no longer double-painted under their raster overlays; several emoji-presentation and variation-selector routing cases are corrected.
- **Embedded fonts fill correctly** — subsets now emit `glyf` (not CFF) so overlapping contours union under nonzero fill, and legitimately-inkless codepoints no longer paint tofu boxes.
- **Layout & paint** — stacking contexts paint floats between block boxes and inline content per CSS 2.1; text-bearing blocks no longer repaint their floats over the text; non-floated `initial-letter` raised caps are sized and positioned correctly; `<textarea>` line tops snap to whole pixels; counter-style fallbacks keep the original style's affixes.
- **Animations** — intra-frame `opacity` animations can now brighten a partially-transparent element (and `opacity: 0` targets keep their markup to fade in); viewBox culling models translate+scale so scaled-in content isn't hidden; per-frame cull class names no longer collide across frames; the auto-cursor hit-tests glyphs in true paint order and click actions can aim off-center.
- **`animate` self-containment** — remote `<img src>` bytes are now inlined (no dead hrefs in the output), and repeated raster payloads are serialized once instead of per frame.
- **Robustness** — per-element fontkit exceptions and null glyph lookups are isolated so one bad glyph can no longer abort a whole render.

## [0.22.0] - 2026-08-13

**🚀 Features**

- **Frame-sequence compression for editing animations** — a run of consecutive editing states now composes into one self-contained animated SVG where shared content is emitted once and only per-keystroke deltas animate. Available declaratively via a `states` block (with auto-carets) and as `composeCompressedRun`. Automatic detection is now on by default; opt out with `"autoCompress": false` or `--no-auto-compress`, or opt in per-run with a `compress: true` marker. A size-regression guard guarantees compression never grows the output.
- **Caret & selection tracks** (`textTracks`) — declarative carets and selections anchored to Chromium's own captured glyph positions, with logical-order addressing across RTL/bidi runs, vertical writing modes, and mixed inline content. Adds a block-caret `invert` option (repaints the covered glyph) and behind-glyph (true editor z-order) selection.
- **Parameterized & custom transitions** — built-in transitions now take parameters, plus a normalized transition schema and support for safe custom transition recipes and angled linear wipes.
- **Per-region animation timing** — declare regions by selector (`regions`) and tag each state with what it `advances`, so independently-updating panes run on their own schedules.
- **Richer typing overlays** — `anchor.baseline: true` lands overlay text on an element's real text baseline, and `holdToFrameEnd: true` holds a typed line through the frame for a seamless handoff to captured page text. Overlays gain an explicit `endAt` window and support per-state overlays inside a compressed run.
- **WOFF2 font compression** — the CLI `--optimize` pass now recompresses embedded fonts to WOFF2 (new `compressEmbeddedFontsToWoff2` export), cutting font bytes ~40% in text-heavy output.
- **Hinting-preserving embedded font subsets, on by default** — embedded subsets now retain the source font's TrueType hinting (variable fonts fully instanced at the resolved axis), sharply improving text fidelity on Linux and Windows. Set `DOMOTION_HINTED_SUBSET=0` to fall back.
- **CSS font property support** — `font-variant-emoji`, `font-feature-settings` disables/values, `font-synthesis` (weight/style/small-caps vetoes), and `font-stretch` (width-axis instancing and cut selection) are now honored, shaped through HarfBuzz where needed.

**🐛 Fixes**

- **Text decoration** — decorations now propagate to in-flow descendants and accumulate down the ancestor chain (a bold or sub/sup child no longer drops the line); dashed/dotted dash geometry, skip-ink gaps, `text-underline-position: under`, and overall decoration geometry are transcribed from Chromium instead of fitted approximations.
- **Complex-script shaping** — Arabic, Hebrew, Devanagari, Telugu, Hangul, Thai/Lao, Myanmar, Khmer and Bengali now shape through HarfBuzz for correct joining, clustering, reordering and dotted-circle behavior; bidi handling is fixed for `unicode-bidi: bidi-override` and for SMP right-to-left scripts.
- **Cross-platform font selection** — large parity improvements to which face and cut Chrome actually paints on macOS, Linux and Windows (declared-family cut ladders, system-ui, generics per content script, weight/optical-size axes), plus synthetic bold and oblique now baked into embedded glyphs where the resolved face lacks the requested style.
- **Color emoji** — sbix emoji overlays self-calibrate to Chrome's painted pixels, and emoji are no longer double-painted under their raster overlays; several emoji-presentation and variation-selector routing cases are corrected.
- **Embedded fonts fill correctly** — subsets now emit `glyf` (not CFF) so overlapping contours union under nonzero fill, and legitimately-inkless codepoints no longer paint tofu boxes.
- **Layout & paint** — stacking contexts paint floats between block boxes and inline content per CSS 2.1; text-bearing blocks no longer repaint their floats over the text; non-floated `initial-letter` raised caps are sized and positioned correctly; `<textarea>` line tops snap to whole pixels; counter-style fallbacks keep the original style's affixes.
- **Animations** — intra-frame `opacity` animations can now brighten a partially-transparent element (and `opacity: 0` targets keep their markup to fade in); viewBox culling models translate+scale so scaled-in content isn't hidden; per-frame cull class names no longer collide across frames; the auto-cursor hit-tests glyphs in true paint order and click actions can aim off-center.
- **`animate` self-containment** — remote `<img src>` bytes are now inlined (no dead hrefs in the output), and repeated raster payloads are serialized once instead of per frame.
- **Robustness** — per-element fontkit exceptions and null glyph lookups are isolated so one bad glyph can no longer abort a whole render.

## [0.22.0] - 2026-08-13

**🚀 Features**

- **Frame-sequence compression for editing animations** — a run of consecutive editing states now composes into one self-contained animated SVG where shared content is emitted once and only per-keystroke deltas animate. Available declaratively via a `states` block (with auto-carets) and as `composeCompressedRun`. Automatic detection is now on by default; opt out with `"autoCompress": false` or `--no-auto-compress`, or opt in per-run with a `compress: true` marker. A size-regression guard guarantees compression never grows the output.
- **Caret & selection tracks** (`textTracks`) — declarative carets and selections anchored to Chromium's own captured glyph positions, with logical-order addressing across RTL/bidi runs, vertical writing modes, and mixed inline content. Adds a block-caret `invert` option (repaints the covered glyph) and behind-glyph (true editor z-order) selection.
- **Parameterized & custom transitions** — built-in transitions now take parameters, plus a normalized transition schema and support for safe custom transition recipes and angled linear wipes.
- **Per-region animation timing** — declare regions by selector (`regions`) and tag each state with what it `advances`, so independently-updating panes run on their own schedules.
- **Richer typing overlays** — `anchor.baseline: true` lands overlay text on an element's real text baseline, and `holdToFrameEnd: true` holds a typed line through the frame for a seamless handoff to captured page text. Overlays gain an explicit `endAt` window and support per-state overlays inside a compressed run.
- **WOFF2 font compression** — the CLI `--optimize` pass now recompresses embedded fonts to WOFF2 (new `compressEmbeddedFontsToWoff2` export), cutting font bytes ~40% in text-heavy output.
- **Hinting-preserving embedded font subsets, on by default** — embedded subsets now retain the source font's TrueType hinting (variable fonts fully instanced at the resolved axis), sharply improving text fidelity on Linux and Windows. Set `DOMOTION_HINTED_SUBSET=0` to fall back.
- **CSS font property support** — `font-variant-emoji`, `font-feature-settings` disables/values, `font-synthesis` (weight/style/small-caps vetoes), and `font-stretch` (width-axis instancing and cut selection) are now honored, shaped through HarfBuzz where needed.

**🐛 Fixes**

- **Text decoration** — decorations now propagate to in-flow descendants and accumulate down the ancestor chain (a bold or sub/sup child no longer drops the line); dashed/dotted dash geometry, skip-ink gaps, `text-underline-position: under`, and overall decoration geometry are transcribed from Chromium instead of fitted approximations.
- **Complex-script shaping** — Arabic, Hebrew, Devanagari, Telugu, Hangul, Thai/Lao, Myanmar, Khmer and Bengali now shape through HarfBuzz for correct joining, clustering, reordering and dotted-circle behavior; bidi handling is fixed for `unicode-bidi: bidi-override` and for SMP right-to-left scripts.
- **Cross-platform font selection** — large parity improvements to which face and cut Chrome actually paints on macOS, Linux and Windows (declared-family cut ladders, system-ui, generics per content script, weight/optical-size axes), plus synthetic bold and oblique now baked into embedded glyphs where the resolved face lacks the requested style.
- **Color emoji** — sbix emoji overlays self-calibrate to Chrome's painted pixels, and emoji are no longer double-painted under their raster overlays; several emoji-presentation and variation-selector routing cases are corrected.
- **Embedded fonts fill correctly** — subsets now emit `glyf` (not CFF) so overlapping contours union under nonzero fill, and legitimately-inkless codepoints no longer paint tofu boxes.
- **Layout & paint** — stacking contexts paint floats between block boxes and inline content per CSS 2.1; text-bearing blocks no longer repaint their floats over the text; non-floated `initial-letter` raised caps are sized and positioned correctly; `<textarea>` line tops snap to whole pixels; counter-style fallbacks keep the original style's affixes.
- **Animations** — intra-frame `opacity` animations can now brighten a partially-transparent element (and `opacity: 0` targets keep their markup to fade in); viewBox culling models translate+scale so scaled-in content isn't hidden; per-frame cull class names no longer collide across frames; the auto-cursor hit-tests glyphs in true paint order and click actions can aim off-center.
- **`animate` self-containment** — remote `<img src>` bytes are now inlined (no dead hrefs in the output), and repeated raster payloads are serialized once instead of per frame.
- **Robustness** — per-element fontkit exceptions and null glyph lookups are isolated so one bad glyph can no longer abort a whole render.

## [0.21.1] - 2026-07-04

All three commits in this range are test-only (`test(animator)`) or doc-only (`docs(CLAUDE)`) changes, which the template's frontmatter explicitly excludes ("test-only changes, doc-only changes"). None of them add features, alter behavior a consumer would see, add CLI flags, or break anything.

So there are no user-facing release notes to generate for this range — every section would be empty and is therefore omitted, leaving no output.

## [0.21.0] - 2026-07-04

** Features**

- **New transition set:** directional pushes (right/up/down), `wipe`, `iris`, `zoom-in`/`zoom-out`, plus new radial and clock-hand wipes (`wipe-radial`, `wipe-clock` — with configurable start angle, direction, and cubic-bezier easing). All cross-engine-safe (transform/clip-path/opacity only).
- **Motion preset library:** named enter/exit and easing presets — including a true multi-oscillation spring — so you no longer hand-tune cubic-beziers. Mixed-family transition chains now composite correctly (an entrance effect from a different family than the exit is no longer dropped).
- **Shine overlay:** a swept-glint effect with optional corner radius, anchor auto-sizing, and named easing.
- **Realistic typing overlays:** character-by-character reveal with the caret locked to the true text edge, glyph-path rendering (proportional fonts with pixel-accurate wrapping), optional GPOS kerning, selectable caret shapes (bar/block/underscore), humanized typos (type-wrong → backspace → correct, deterministic), and a `fontFamily` override that can auto-adopt the anchored field's font.
- **`typeResample`:** high-fidelity per-keystroke re-capture of a live field — shows the page's own masking, auto-formatting, and font — with an opt-in `regionOnly` mode to shrink output size.
- **Interaction capture:** force real CSS `:hover`/`:active`/`:focus` states via CDP (`forceState`), `hoverReveal` sugar with auto-detection, a `jsReveal` MutationObserver harness that captures JS-driven feedback (class flips, injected tooltips/menus) and tweens motion deltas in place, and a synthetic hover/focus/press interaction overlay.
- **Creative template pack:** `title-card`, `quote`, `caption`, `cta`, `counter`/`stat` (odometer digit reels), and before/after `compare`.
- **`--brand <file>` brand kit:** one file drives palette, font, radius, logo, and background across every template, and injects CSS variables into captured pages (`capture`/`animate`) so brand-authored pages theme automatically.
- **`--format <preset>` social canvases:** reel/story/square/portrait/landscape (or raw `WxH`), with safe-area insets and per-ratio adaptive type scaling; device mockups scale their bezel and browser chrome with the screen for large/reel captures.
- **`domotion storyboard`:** sequence distinct scenes (title → demo → CTA) into one self-contained animated SVG with inter-scene transitions.
- **Native SVG inlining:** `<img src=*.svg>` now embeds as native vector SVG instead of a rasterized data-URI image — crisp at any zoom, ~33% smaller, and it also handles `object-fit: none`. Inlined SVGs get their ids and CSS class names namespaced so multiple embedded SVGs can't collide.

** Fixes**

- Single-line `<input>` value text is now vertically centered for all input types, matching Chrome.
- Corrected typing and `typeResample` caret geometry — height from the font's real ascent+descent, centered on the line box, and accounting for letter/word-spacing.
- Hover cursor now lands on the element exactly as the hover state appears, instead of arriving mid-glide.
- Multiple overlays of the same kind in one frame now get unique ids — previously only one revealed.
- Composite clip-scale resize no longer clips too narrow in Firefox.
- Local-font alias family-key normalization now matches the lookup side, fixing some font resolutions.
- Compare-template labels track their region and stay centered in the pill.

## [0.20.0] - 2026-07-02

** Features**

- Paired-motion animations (a move + a fade on the same element, as used by the kinetic-text and lower-third templates) now emit as a **single** CSS animation instead of two, keeping the transform and opacity in perfect lockstep.
- Fused tracks can now carry their own duration, delay, and easing — e.g. a fast fade layered over a slower slide, or different curves per property — while still rendering as one timeline.

** Fixes**

- Firefox no longer flashes the transparent page-through background for a moment at every frame cut in multi-frame SVGs (cut, magic-move, crossfade, push, and scroll transitions). Chromium and Safari were already unaffected.
- Single-frame looping animations (kinetic-text, lower-third) no longer flash or appear to run "as two separate steps" at the loop edge in Firefox.

## [0.19.1] - 2026-07-01

** Fixes**

- Cursor overlay click pulses now replay on every loop of an animated SVG instead of firing once and freezing after the first pass — the click rings reappear each time the pointer repeats its motion.

## [0.19.0] - 2026-07-01

** Features**

- Add an opt-in accessible name and long description to the root `<svg>`: pass a title/description (or the new `--title` / `--desc` CLI flags) to emit `role="img"` with `<title>`/`<desc>`, giving inline-embedded demos an accessible name for screen readers. Works across single-frame, animated, and scroll output.

** Fixes**

- `domotion capture <url>` now embeds remote `<img>` and background images by default, so its output is fully self-contained with no external asset references — matching the animate and template pipelines.
- Cursor overlays are now emitted as CSS animations instead of SMIL, fixing pointer drift in Safari when the animation goes offscreen (tab-switch or scrolled away) and returns.
- Scroll-composed SVGs now honor `prefers-reduced-motion: reduce`, pinning the demo to the top frame instead of animating regardless of the viewer's motion preference.

## [0.18.0] - 2026-07-01

** Features**

- Same-origin `<iframe>` content now recurses into native SVG — crisp, scalable, and selectable — instead of being flattened to a raster `<image>`. Inner content is clipped to the iframe's content box, with counters, transforms/zoom, and inner `mask`/`clip-path`/`filter` references all resolved correctly.
- Opt-in cross-origin `<iframe>` recursion via the new `--cross-origin-frames` flag, gated by a host allowlist (non-allowlisted frames stay raster snapshots).
- `svg-scrubber --review`: report issues straight from the animated-SVG scrubber. Type a title/category/note, drag one or more regions over the problem area, optionally attach the current frame as a PNG, and save a self-contained, importable `.ticket` capturing the frame time and in/out range — the animated-SVG counterpart to `svg-review`.

** Fixes**

- Hard-cut animation transitions no longer fade across the entire frame when `optimize: true` — SVGO was factoring out and resetting the cut's `step-end` timing-function, so cuts now stay crisp through optimization.
- Transparent canvas/root backgrounds stay transparent in animated, scrolled, and composited output. Previously backgrounds given as `none`, a zero-alpha hex (`#0000`), or `rgba(0,0,0,0)` were painted as an opaque backdrop.

## [0.17.0] - 2026-06-30

**🚀 Features**

- Per-codepoint live system-fallback font resolution now runs on Linux (fontconfig) and Windows (DirectWrite), calibrated against Chromium and on by default — codepoints missing from the static tables now resolve to the same face the browser paints instead of dropping to tofu. Previously macOS-only, so Linux/Windows captures of less-common scripts and symbols are markedly more faithful.
- Added a desktop-Linux Noto font profile, selected automatically at runtime, so output matches the Noto fonts most Ubuntu/Fedora users actually have rather than only the bare CI image's fallback faces.

**🐛 Fixes**

- `border-collapse: collapse` tables now paint each shared grid edge exactly once with the winning border, instead of double-painting adjacent cells' borders and drawing table/row/section box borders as concentric rings.
- Mixed per-side 3D border styles (e.g. `ridge` top/bottom with `groove` left/right) now render with proper light/dark beveling instead of flat, bevel-less sides.
- A `background-clip: text` gradient on an inline that wraps across lines is now painted per line fragment, fixing wrong colors on each line.
- `counter()` / `counters()` now honor built-in counter styles (`upper-roman`, `lower-alpha`, etc.) in `content`, instead of falling back to plain decimal.
- `<input>` fixes: the value is now vertically centered within a tall explicit `line-height`, and it's clipped to the content box so overflowing text no longer bleeds into the padding up to the border.
- `<fieldset>` with `overflow` set no longer clips the top half of its `<legend>`.
- List markers now align to the li's first text line (not its border-box top) and outside text markers use Blink's actual margin model, fixing markers that painted too high or shifted right.
- Color emoji in `::before`/`::after` content is no longer clipped — the raster rect now matches the emoji's square advance.
- Apple-style superscript footnotes now render small and raised (via `numr`→`sups` GSUB), and carousel `::scroll-marker-group` dots and dot scaling are positioned flush at the scroller edge.
- A flex `::after` under `justify-content: space-between` (and flex-/end) now anchors to the content-right edge instead of overshooting past it.

## [0.16.0] - 2026-06-26

**⚠️ Breaking Changes**

- The bare `npx domotion-svg capture …` one-liner no longer resolves now that the package ships multiple bins. Invoke a specific bin instead, e.g. `npx -p domotion-svg domotion capture …`.
- The animated-SVG scrubber bin was renamed from `animated-svg-scrubber` to `svg-scrubber`. Update any scripts or invocations to the new command name (flags and behavior are unchanged).

**🚀 Features**

- New `svg-to-image` bin rasterizes a still SVG to an image in one shot — PNG, JPEG, and PDF, plus WebP, AVIF, and TIFF output.
- New `domotion composite` verb and `composeAnimatedLayers` primitive let you nest one already-animated SVG (cast, scroll capture, template, animate result, or another composite) inside another, each layer independently placed and timed — and composites nest recursively. Ships with a published JSON Schema for the composite config and cross-layer embedded-font de-duplication.
- `svg-to-image` and `svg-review` now accept `--port 0` to bind an OS-assigned free port, and validate `--port` / `--theme-file` at the CLI boundary.
- Single-series column/bar charts now default to a neutral palette with the peak bar in the accent color, instead of per-bar rainbow coloring.

**🐛 Fixes**

- Fixed chained animation transitions: mixing different transition types (crossfade → push-left → scroll → magic-move) no longer leaves frames with missing slide-in/fade-in keyframes — push-left, scroll, and crossfade now animate correctly instead of cutting or revealing empty canvas.
- Nested cast/template animations are now re-anchored to start when their frame becomes visible, fixing desync and mid-loop playback when composited.
- Terminal captures no longer emit a full-viewport background rect that bled past the window edge when composited into window chrome.
- In paths render mode, the glyph registry now resets per generation, so back-to-back in-process renders no longer accumulate stale glyph defs.

## [Unreleased]

** Changed**

- **Renamed the `animated-svg-scrubber` bin to `svg-scrubber`.** The command for the local video-style timeline bench is now `svg-scrubber` (e.g. `npx svg-scrubber out.svg`). This is a breaking change for any script or shortcut that invoked the old name; update call sites to `svg-scrubber`. The flags, behavior, and `src/cli/scrubber.js` entry point are unchanged.

## [0.15.0] - 2026-06-24

** Features**

- **New template system.** Built-in parameterized generators that produce self-contained SVGs through the existing capture/compose pipeline — drive them with the new `domotion template` verb or the `renderTemplateToSvg` API. Ships seven built-ins: lower-third, device-mockup, chart, chat, subscribe, background-loop, and kinetic-text.
- **Charts, chat, and subscribe templates** with rich options — charts support column/bar/line styles, single or multi-series data (grouped or stacked) with legends and a nice auto-scaled axis.
- **Procedural animated backgrounds** (`background-loop`) with seamlessly-looping `aurora`, `orbs`, gradient-pan, grid, stars, and parallax-wave variants, all deterministic from a `seed`.
- **Animated text reveals** (`kinetic-text`) with rise / slide / fade / clip / pop variants.
- **Compose templates into animations.** A frame in an `animate` config can now set `"template": "<name>"` (plus optional `"params"`) instead of capturing a page or cast recording, and frames gain duration/fit control.
- **Third-party templates.** Publish reusable templates as `domotion-template-<name>` npm packages — backed by a new authoring guide, a runnable example package, and a documented discovery convention.
- **Center-origin transforms.** Intra-frame animations now support `transformOrigin`, so scale/rotate can pivot about an element's own box instead of the SVG origin.
- **New example:** a scrolling terminal deploy session embedded in a macOS-style window bezel.
- Added `llms.txt` — a concise, discoverable guide for AI agents that want to use Domotion as a tool.

** Fixes**

- Fixed intra-frame animations that only moved an element's own box and left its subtree static — animated containers (e.g. the lower-third banner) now move their children with them.
- Fixed `background-loop` blobs snapping in/out instead of fading continuously, and grid drift leaving a growing empty margin at the loop seam.
- Smoothed the gradient-pan/grid background variants to pan continuously instead of ping-ponging, and improved the star and wave visuals.
- Fixed template frames in `mode:"full"` cast configs colliding with sibling frames and hijacking the wrong timeline.
- Fixed `domotion term` live capture failing with `posix_spawnp failed.` by self-healing node-pty's non-executable spawn helper.

## [0.14.0] - 2026-06-23

** Features**

- New `domotion term` command turns a recorded terminal session into a self-contained animated SVG with real text and faithful color — import an asciinema v2 `.cast` file, or capture a command live with `domotion term -- <cmd ...>`. Sessions render incrementally as a scrolling line pool (far smaller output), include a blinking cursor on input lines, honor mid-session terminal resizes, and can be themed (light/dark) and composed into larger animations.
- Add `--chrome` device bezels to the capture CLI — wrap a capture in a `phone`, `browser`, or `window` frame, with `--chrome-label` to set the URL/title text.
- Render conic-gradient backgrounds on form-control pseudo-elements (range slider thumb/track, color swatch, and `<progress>`/`<meter>` parts), rasterized at the exact part size.
- Render CSS `scroll-marker-group` dot/pill navigation and `::scroll-button` paging arrows.
- Complete the CSS named-color table to all 148 CSS Color 4 names, so colors like `rebeccapurple` and `cornflowerblue` now resolve in gradient and conic-gradient stops instead of being dropped.
- Support `mask-size: contain | cover` positioning.

** Fixes**

- Big batch of text-shaping and emoji fidelity fixes: honor `text-spacing-trim` for CJK fullwidth punctuation, place the synthetic dotted circle for orphaned complex-script marks the way Chrome does (LTR/RTL, CJK/Hangul tone marks, Kirat Rai modifiers), size color emoji to Chrome's advance square instead of ~20% too small, hide orphaned variation selectors instead of painting tofu, and route several precomposed letters through HarfBuzz to match Chrome's mark placement.
- Resolve `font-family: 'Helvetica Neue'` to the real Helvetica Neue face (not plain Helvetica), and route `U+2215` DIVISION SLASH through the correct system fallback — fixing a range of glyphs that previously diverged from Chrome.
- Stop stamping a color-emoji bitmap over monochrome glyphs (🌐/🎤) when the font cascade routes them to a non-emoji font.
- Border fixes: collapsed-table cell borders now paint inside their own box rather than centered on the grid line, and a single bordered side with `border-radius` paints its full rounded corner arc instead of being cut off.
- Form-control fixes: native `<meter>` paints Chrome's grooved bar with the correct value inset, plus `<details>` marker centering and the `::details-content` divider.
- Static `::after` badge placement: collapse a wrapped badge's leading space so it left-aligns, and flow an in-flow badge to the end of a text-less block host instead of its top-right corner.
- Right-align custom `@counter-style` markers via the suffix gap, matching Chrome.
- Animator: a push-left or scroll frame that is last in the loop no longer fades out across its hold.

## [0.13.3] - 2026-06-17

Based on the single commit:

- Fix multi-line typing animations revealing all lines at once in Safari

## [0.13.2] - 2026-06-17

Based on the single commit:

- Fix typing-overlay caret sticking at x=0 at the start of each line in multi-line text

## [0.13.1] - 2026-06-17

- Fix typing-overlay caret lagging behind revealed text during type-on animation

## [0.13.0] - 2026-06-17

- New `svg-to-video` export with alpha/transparent output and frame-center sampling to fix boundary ghosting
- Animations now hold the last frame at 100% by default instead of fading it out on loop
- New declarative `animate` pipeline with cursor/action, frames-out/onFrame, and overlay-resolution primitives, exposed on the public API
- Fixed reused SVG content vanishing on seeked animation renders (element-id deduping across frames)
- New public helpers: `contentBox()` padding-inset box, `resolveOverlays()` anchor→coords, and `borderBox`/`resolveCursorTarget`
- Better complex-script text: Grantha/Indic matra reordering fixes, synthesized dotted circles for covered combining marks, and path-rendered SMP alchemical symbols
- "SF Pro Text" now resolves to its installed OTF for full glyph coverage
- Drop-cap initial letters now fill and center within their content box
- Synthesized small-caps now scale punctuation and symbols in all-small-caps and unicase
- `<summary>` markers honor `::marker` color/font-size/inside position; pseudo-element gradient glows honor background-position/-size and opacity

## [0.12.0] - 2026-06-07

- Fixed list marker rendering for `<ul>`/`<ol>` items
- Corrected East-Asian font feature shaping
- Fixed vertical punctuation positioning in vertical text
- Fixed disclosure triangle arrows on `<details>`/`<summary>`

## [0.11.0] - 2026-06-06

- Auto-detect and render the correct mouse cursor for each element, matching CSS cursor keywords
- Render color emoji in more Unicode blocks: Enclosed Ideographic Supplement, Dingbats, and Enclosed Alphanumerics
- Fix combining-mark and pre-base matra positioning to match Chrome, with expanded dotted-circle script coverage
- Render "SF Pro Text", "SF Pro" optical sizes, and "New York Medium" with their correct optical-size font cuts
- Fix `background-clip: text` on nested and multi-line elements, and mis-anchored `::before`/`::after` markers
- Keep hoisted flex children painting correctly under `flex-direction: *-reverse`
- Add a crop rectangle with aspect-ratio lock to the animated-SVG scrubber

## [0.10.1] - 2026-06-05

- Fix font-rendering crash on Linux when generating SVGs with mixed scripts

## [0.10.0] - 2026-06-05

- Render vertical writing-mode text, drop caps, and `<textarea>` content as native SVG instead of screenshot overlays
- Vertical writing-mode gains text-emphasis marks, decoration painting, tate-chu-yoko, and baseline/rotation fixes
- Broaden font fallback: Brahmic complex-script shaping, Unicode NFD decomposition, dotted circles, and bundled LastResort
- Calibrate per-Unicode-block font routing across macOS, Linux, and Windows DirectWrite
- New `animated-svg-scrubber` app: play/scrub, zoom/pan, range-to-MP4 export, and trim-to-SVG
- Fix BiDi paired-bracket mirroring to resolve across wrapped lines, not per line
- Scroll improvements: per-action easing, exact `until <position>` landing, and linear easing default
- Soften the host-content glow into a blurred behind-content layer
- Fix auto-cursor timing so the pointer clicks before the change it triggers
- Publish a formal JSON Schema for the animate config

## [0.9.0] - 2026-06-01

- Vertical writing-mode text now renders as native SVG, with underline/overline/line-through and correct sideways-lr orientation
- `::first-letter` drop caps now render as native SVG, including text-shadow and pixel-accurate cap-top positioning
- `<textarea>` content and text-flavored `<input>` now render as native SVG instead of a raster screenshot
- Fixed fade-overlay `::after` content so it paints on top of descendant text
- Added Linux per-Unicode-block font routing and recalibrated macOS symbol-row fallbacks
- Bundled a LastResort fallback font as the final glyph fallback on non-macOS platforms
- Routed CJK Extension B–H and Compatibility Supplement glyphs through PingFang
- Fixed SF Compact font routing on macOS
- Resolved the primary font to the first installed family in the stack and render its real `.notdef` glyph for unmapped codepoints, matching Chrome's placeholder and clearing tofu mismatches across dozens of Unicode blocks (CJK extensions, Egyptian Hieroglyphs, Sutton SignWriting, Kana Supplement, Arabic Mathematical, and more)

## [0.8.0] - 2026-05-30

Looking at the commits, here are the user-facing release notes:

```markdown
- Fix drop-cap position when rendered from a rasterized image
- Fix positioning of `::before`/`::after` pseudo-elements that carry a transform
- Stop clipping vertical writing-mode raster images to the narrower content rect
- Route additional symbol code points (U+25C8, ♀♂⚥, Misc Technical) to correct fallback fonts
- Broaden Unicode coverage across more script blocks
- Improve svg-review diff interactions

## [0.7.0] - 2026-05-30

- Render CSS `text-emphasis` marks
- Capture CSS Transforms 2 standalone `rotate`/`scale`/`translate` properties
- Capture inline SVG `<filter>` defs referenced by `filter: url(#id)`
- Accept the canonical `paint-order: stroke` shorthand
- Synthesize small-caps in embedded fonts that lack the OpenType feature
- Fix emoji, drop-cap, and vertical-writing-mode text rasterization glitches
- Fix `::after`/`::first-letter` pseudo-element placement in flex and wrapped layouts
- Fix cover-mode background image positioning and `<image>` pixel snapping
- Better RTL bracket mirroring and soft-hyphen line-wrap handling
- `svg-review`: figure-level click for lightbox; captions survive deletion

## [0.6.0] - 2026-05-29

- `elementTreeToSvg` now returns a complete `<svg>` document (the old renderer is `elementTreeToSvgInner`)
- New magic-move transition slides shared elements between frames, morphing size and cross-fading paint changes (honors reduced-motion)
- New CLIs: `svg-review` for consumer fidelity bug reports and `svg-to-video` for GIF/APNG/video export
- Linux and Windows rendering now calibrated to native fonts (FreeType / DirectWrite), with reproducible embedded fonts
- Added a HAR-file capture source
- Text fixes: wavy-underline truncation, transparent gradient stops, embedded text-width scaling, RTL glyph alignment, and emoji raster overlays
- Box fixes: border-radius wedges, dashed-border/outline corner phasing, text-stroke on transparent fill, background-clip:text inheritance, and zoom-scaled radius
- MathML: radical signs, stretchy fence operators, Math-Alphanumeric glyphs, and fraction-bar width
- Support external-file `clip-path` / `mask-image` fragment refs and `clipPathUnits="userSpaceOnUse"`

## [0.5.0] - 2026-05-25

- New declarative animate config — compose multi-frame animations from a config file
- Added overlay primitives: config-level cursor, selector-anchored overlays, and a standalone blink
- Typing overlay now renders a blinking insertion caret
- Blink and pulse intra-frame animations now support repeat / alternate
- Added richer readiness waits before capture, plus repeating-animation support
- Added a `maxWidth` option to the animate config
- Fixed crossfade z-order, push-left/scroll keyframes, and body-gradient capture
- Font-family values are now escaped, and all animator transitions composite correctly

## [0.4.2] - 2026-05-25

- Typing-overlay text now wraps to the box width like a real textarea

## [0.4.1] - 2026-05-25

- Fix an emoji glyph leaking into rendered text output

## [0.4.0] - 2026-05-25

- Text now renders with embedded fonts by default across all outputs.
- Embedded-font output positions glyphs via a single `<text>` x-list for smaller, cleaner SVG.
- Linux support: platform-aware font discovery with a calibrated Linux fallback chain.

## [0.3.3] - 2026-05-25

This commit is a CI/release-workflow fix (asset upload made repo-aware), which the rules exclude. There are no user-facing changes in the provided commits, so there are no release-note bullets to emit.

## [0.3.2] - 2026-05-25

- macOS glyph-extractor binary is now code-signed and notarized in releases

## [0.3.1] - 2026-05-25

Linux CI test fix

## [0.3.0] - 2026-05-25

- MathML now renders fraction bars, square-root/root radicals, and italic Latin/Greek identifiers
- Wavy underlines recalibrated to match Chrome and now break around descenders
- `::first-letter` drop caps no longer clipped or doubled; text under `zoom` and anisotropic scaling sized correctly
- Borders: mixed-width rounded corners and dashed/dotted dash alignment now match Chrome
- `border-image`/`mask-border` support gradient sources, full 9-slice, and `repeat: space`/`round` tiling
- `clip-path` honors `url(#id)` references, `inset(… round …)` radii, and geometry-box keywords
- Backgrounds: `background-blend-mode`, `background-attachment: local` sizing, and gradient text-clip inherited from ancestors
- New font coverage: Source Serif Pro, Hiragino Sans, sub/superscript glyphs, and ⭐/❤️ emoji
- Pseudo-element transforms and inline positioning fixed; box-shadows now paint on clipped popovers/dialogs
- Custom `@counter-style` list markers, `content-visibility: hidden` placeholders, and per-axis overflow clip + `overflow-clip-margin`

## [0.3.0] - 2026-05-24

- MathML now paints fraction bars, radical signs, and italic Latin/Greek identifiers
- Floated `::first-letter` drop caps no longer clip; wavy underlines break around descenders
- Custom `@counter-style` rules and `counter()`/`counters()` now resolve for markers and content
- `border-image`/`mask-border` gain gradient sources, 9-slice tiling, and repeat/round/space
- Dashed and dotted borders now align dashes at corners like Chrome
- `clip-path: url(#id)`, `inset(... round ...)`, and `background-blend-mode` now honored
- CSS `zoom` scales text correctly; `transform-style: preserve-3d` sorts children by depth
- New Source Serif Pro / Hiragino Sans routing; star, heart, and icon-font fallback glyphs paint
- Pseudo-element transforms (rotated badges, check-marks) and `vertical-align` positioning fixed
- `content-visibility: hidden`, `overflow-clip-margin`, and box-shadows escaping overflow clips handled

## [0.2.2] - 2026-05-18

- Fix framer chevron icons rendering via data:URI mask support
- Fix brand logos disappearing due to off-screen transformed ancestor culling
- Fix rotated/skewed element AABB calculation for correct bounding boxes
- Fix px-positioned gradient stops rendering at wrong offsets
- Fix outline clipping at element edges
- Fix paint order for floated elements

## [0.2.1] - 2026-05-18

- Fix rotated/skewed bounding boxes, px gradient stops, outline clipping, and float paint order
- Scale font metrics by ancestor transforms and capture descendants past transformed ancestors
- Emit `clip-path` for `overflow:hidden`/`clip` and resolve `closest-side`/`farthest-side` keywords
- Capture replaced elements at their live painted rect instead of the frozen rect
- Fix input baseline drift for flex-centered inputs and route input text through raster fallback
- Raster-fallback PUA pseudo glyphs when icon fonts are unavailable; emit CSS triangle pseudos as `<polygon>`
- Honor `font-variation-settings` and `font-feature-settings` during shaping
- Correct stacking contexts for `transform-style != flat` and `z-index:0`
- Add `svgz` output, drop off-viewBox and accessibility-hidden content, and support `mask-composite` subtract/intersect/exclude
- Scroll-redesign: pattern grammar, viewport-chunked long scrolls, CLI progress logging with `--quiet`, and reworked public API in `src/index.ts`

## [0.1.1] - 2026-05-11

- Renamed npm package from `domotion` to `domotion-svg`

## [0.1.0] - 2026-05-11

- Initial release

## [0.1.0] - 2026-05-11

- Initial release
```
