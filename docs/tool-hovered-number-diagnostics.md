# Hovered number decoration failure evidence

DM-WRFW22 investigates an empty native number-input spinner stamp. The retained
unchanged-production `1abdf3d6` run failed the strict populated-PNG assertion,
while its matched D8 arm passed. Those two runs establish neither a failure
frequency nor a D8 regression. The later failure screenshot contains a spinner,
but it was taken after capture restored the page and cannot establish paint
during isolation. No common cause with WebGL or worker failures is established.

The actual installed Chromium 147 revision
[`6b5a1b80` UA stylesheet](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/html/resources/html.css)
defaults the inner spin button to opacity zero and disables pointer events.
Its enabled, read-write focused-or-hovered host rule enables both. This is a
source boundary to measure, not proof that hover caused the observed failure.

Production `native-control-decoration-raster.ts` validates the retained part's
identity, geometry and interaction immediately after isolation, then takes one
transparent screenshot. It keeps the host visible, neutralizes structural
paint and makes the retained part visible. An all-transparent mapped RGBA crop
sets `empty:true` without a warning. This differs from a missing screenshot,
invalid crop or ownership failure, which adds a named warning. A populated crop
is encoded and the destination rectangle is snapped; an empty result retains
its earlier rectangle, so compare the production clip plan rather than merely
comparing the final rectangles from empty and populated records.

There is also an earlier empty path: the walker admits only connected parts
with visible display/visibility, positive opacity and nonzero geometry. No
admitted parts sets `empty:true` before materialization; such an owner is then
excluded from the native isolation atlas. A transparent crop of its coordinates
in another owner's atlas cannot distinguish this path without owner identity.

`tests/native-decoration-frame-probe.ts` wraps only the existing page methods
during the hovered capture in `native-control-decoration.e2e.test.ts`. It keeps
the original isolation screenshot buffer/options and the existing isolation
facts. Only after that screenshot resolves, before restore, it reads the host
and retained part's hover/focus/active state, used rect, visibility, opacity,
appearance and pointer events. It adds no screenshot, style mutation, input
event, retry or frame wait. The added state read can affect later restoration
timing; an observed successful run is not equivalence proof for a historical
unobserved failure. A post-screenshot query is not an earlier paint witness.

The output under `native-control-decoration-e2e` contains the original PNG,
its SHA-256 and size, a crop derived using production coordinate/alpha helpers,
the capture result and bounded state facts. Full commit identity is optional
(`GITHUB_SHA` or `DOMOTION_NATIVE_PROBE_COMMIT`); exact LF-normalized test/probe
source hashes accompany each record. The writer runs before the unchanged
strict assertion; diagnostic I/O failure cannot suppress that assertion.
Page methods are restored even if capture throws. At most two existing frames,
each at most 2 MiB, are retained per observed capture; the state read has a
2000ms diagnostic deadline. The fixture is static and contains no user data.

DM-2XR701 adds `native-decoration-rule-probe.ts`: a passive copy of replies to
the existing `DOM.getDocument` and `CSS.getMatchedStylesForNode` calls. It sends
no command. Correlation requires the fixture's actual number-input host and its
pierced UA-shadow spin part; IDs are scoped to that CDP session. Only relevant
UA spin selectors and bounded opacity/visibility/display/appearance/pointer
declarations are retained. Raw matched declarations are neither computed nor
winning values and are not a painted-frame witness. The observer retains at
most eight records/16 KiB across the first four matching-page sessions; later
sessions set `truncated:true`. Original results, parameter objects and error
identity are preserved; all session/factory wrappers are restored at disposal.

The passive observation also passed the four existing cases. In its baseline
row the existing prepass returned both base opacity-zero and enabled/focus-or-
hover opacity-one UA declarations for the same correlated part. The retained
isolation crop still contained 210 opaque pixels. The target fact was recorded
in session two; later sessions hit the observer cap, so the row explicitly
reports truncation rather than claiming a complete capture-wide protocol trace.

The initial bounded 6d4-based observation passed all four existing native cases.
Its DPR1/light/horizontal/LTR/zoom1 crop contained 210 opaque pixels. The host
reported hover false after the screenshot while the retained spin part reported
opacity one. The other three rows were also populated. Consequently that later
host query alone cannot explain an empty stamp. These results verify the
evidence path and do not attribute the earlier failure. Preserve a future actual
failed isolation frame, its mapped alpha and owned part facts before proposing
a production repair; keep the strict assertion and original failure intact.

The Linux and Windows snapshot profiles now include all four unchanged native
decoration cases, requiring 78 passing assertions with no skips. Both retain
`native-control-decoration-e2e/` alongside the snapshot reports even on failure.
The macOS browser lane retains its existing selection and artifact path.
Linux sets `DOMOTION_OUTPUT_DIR=tests/output-linux` for this profile so its
observations cannot be mistaken for host macOS output.

The existing post-frame query also correlates the actual number Element with
the original isolation rows and live source-node registry. It reports true or
false only when justified; missing registry entries or omitted rows produce
unknown membership. An empty pixel crop alone does not establish whether that
owner was admitted to the atlas. The first integrated failed witness retained
a transparent number crop and hidden post-shot host/part, but lacked this row
correlation; it cannot retroactively establish where hover or paint was lost.

The subsequent owner-aware run passed three cases and failed the unchanged
interaction assertion on its DPR2/dark/zoom1.25 row. Both recorded atlas owners
were known, neither was the actual number Element, and the row list was not
truncated. The number was therefore excluded before native atlas capture.
Its post-shot part had opacity zero; this later state does not prove which
earlier used-style predicate rejected it. In the same run, DPR1/light/zoom1
admitted the number and retained 210 opaque crop pixels. These are actual
failed/healthy observations, not a production repair or a failure-rate estimate.

DM-33FSP5 separately tracks a source-proven candidate mismatch: Chromium147
does not generate `option::checkmark` for legacy selects, but the current pseudo
prepass accepts their nonempty UA computed content and reaches terminal
isolation. Its contribution to the spinner's earlier admission loss remains
unproved. Do not treat a later restored screenshot or matched declarations as
the missing pre-walk state witness.
