---
id: "requirements/studio-unified-review-annotations"
title: "Domotion Studio unified human and AI review annotations"
kind: "contract"
status: "current"
owners: ["studio","review","ai"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2690"]
code: ["src/studio/annotations.ts","src/studio/annotations.test.ts","src/studio/project-schema.ts","src/studio/client.tsx","src/studio/server.ts","src/studio/server.e2e.test.ts","src/studio/video-review.ts","src/utils/regions-parser.ts"]
aliases: ["docs/248-studio-unified-review-annotations.md","doc-248"]
---

# Domotion Studio unified human and AI review annotations

Status: **Shipped.** Human comments and AI findings enter the same durable
annotation queue through `applyStudioAnnotationCommand`. The command boundary
validates one bounded create, edit, or lifecycle mutation, appends a
parent-linked review revision, revalidates the complete project, and returns a
new value without mutating the caller's project.

## Grounding model

An annotation may be textual only (no `target`) or carry any useful combination
of structured grounding:

- explicit whole-project or stable scene scope;
- an observation point, a time range, or both independently;
- one or more rectangles with declared scene, canvas, SVG-user-space, CSS-pixel,
  or artifact-pixel coordinates;
- stable semantic track/action and composition-layer IDs;
- an accessibility-first `domTarget` using the same role/name/label/text/test-ID/
  DOM-ID/selector contract as semantic replay; and
- evidence artifact IDs, including an artifact bound to an artifact-space
  rectangle.

New commands always emit normalized `scope` and `time`. Existing version-1
`sceneId` and `atMs`/`endMs` fields remain readable and are normalized when an
old annotation is next written. Missing `revision.kind` on a legacy project
means content; new annotation and media-review revisions declare `review`, while
project creation/import and AI healing edits declare `content`.

Scene-local track, action, layer, scene-coordinate region, and DOM references
must agree on one scene. Cross-scene targets fail validation. DOM grounding is
durable semantic identity, not an observation-run counter. Capture and healing
workflows obtain the accompanying geometry and CSS evidence from the actual
Chromium DOM; annotations do not attempt to reconstruct browser layout from
authored markup.

## History and lifecycle

Every standalone mutation advances the optimistic-concurrency head. Create
records the new annotation snapshot; edit records before/after snapshots and
rejects semantic no-ops; status transitions record both states. Resolution may
be reopened, while superseded annotations are terminal. Annotation fields link
directly to their creation, latest content edit, latest status change, and (when
resolved) resolution revisions.

AI video review attaches all findings through the same API to its existing
aggregate report revision, preserving the one-report/one-revision contract.
Trusted in-process callers can identify human, AI, or system authors. The local
browser endpoint always forces a human author, regardless of untrusted payload,
and generic project save cannot mutate review history. Both annotation changes
and ordinary saves carry the expected review head; stale tabs receive HTTP 409
instead of overwriting newer review work.

The Studio UI creates project- or scene-scoped text/time/region notes, edits
their body without dropping grounding, resolves and reopens them, and persists
each operation immediately. Resolving an edited draft first records that edit,
so the status action cannot silently discard typed text. General narrative
edits must be saved before review history changes.

## SVG review migration

`importSvgScrubberReviewAnnotation` maps the structured `.ticket` JSON produced
by `svg-scrubber --review`. It retains the exact frame point and independent
selected range, prefers modern multi-region data over the legacy single region,
and labels coordinates as SVG user units. Source-SVG and frame-snapshot
artifacts can be staged by the caller and supplied as evidence IDs. Absolute
machine paths are never copied into the project: adapters retain an import
digest and timestamp plus caller-provided project-relative references (or safe
basenames).

`parseSvgReviewRegions` reuses the dependency-neutral canonical `REGIONS:`
parser. `importSvgReviewRegionsAnnotation` converts each rectangle, image token,
and caption to structured Studio fields at the boundary; the textual clipboard
or Hot Sheet notation never becomes Studio's product format. Malformed or
partially skipped entries fail the import instead of silently losing review
intent.

## Verification

Unit coverage round-trips sparse legacy annotations and fully grounded
multi-region human/AI values; exercises create/edit/resolve/reopen/supersede,
reversible history, no-op and stale-head rejection; and migrates modern/legacy
Scrubber JSON plus canonical `REGIONS:` blocks. Real Chromium coverage creates,
edits, resolves, reopens, reloads, and re-reads a grounded time/region note;
server cases also prove actor-spoof protection, HTTP 409 conflict behavior, and
generic-save review isolation. The production AI video test verifies that real
rendered media is reviewed before its findings enter the same queue.
