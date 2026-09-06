---
id: "requirements/studio-embedded-scrubber-preview"
title: "Embedded SVG Scrubber preview in Domotion Studio"
kind: "contract"
status: "current"
owners: ["studio","scrubber","ui"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2689"]
code: ["src/scrubber/embed.ts","src/scrubber/client.tsx","src/studio/app-projects.ts","src/studio/server.ts","src/studio/client.tsx","src/scrubber/embed.test.ts","src/studio/app-projects.test.ts","src/studio/server.e2e.test.ts"]
aliases: ["docs/250-studio-embedded-scrubber-preview.md","doc-250"]
---

# Embedded SVG Scrubber preview in Domotion Studio

Status: implemented in DM-2689.

## Requirement

Studio previews generated scene segments and a composed story through the
existing SVG Scrubber playback engine. Studio remains a separate application;
it embeds Scrubber's transport, seeking, frame stepping, zoom/pan, loop, and
in/out-range controls without copying their state or animation logic.

Scene preview artifacts are SVG artifacts whose `sceneIds` contain exactly the
selected scene ID. A whole-story preview is an SVG artifact with no `sceneIds`.
When several matching artifacts exist, Studio uses the newest `generatedAt`
value. The preview duration prefers positive artifact duration metadata, then
the period detected from the SVG, and finally the authored scene/story duration.

## Integration boundary

`src/scrubber/embed.ts` defines a small, versioned, same-origin `postMessage`
protocol. Studio sends a `load` command with SVG, duration, source identity, and
the last remembered view state. Scrubber reports `ready`, `loaded`, `state`, and
`error` events. View state includes playhead, range, zoom, pan, speed, and loop;
normalization clamps it to the newly generated duration. Playback is
intentionally not restored after regeneration.

The embedded document is served from Studio's own loopback origin. Standalone
Scrubber retains its file picker, crop/export tools, and existing URL contract;
embedded mode only changes which controls are visible and how SVG is supplied.

## Artifact safety and timing authority

`POST /api/preview` accepts only a validated project path plus a scene/story
selection. The server chooses the artifact from project provenance rather than
accepting an arbitrary client file path. It requires `.svg`, applies both
lexical workspace containment and real-path containment to reject symlink
escapes, bounds reads to 64 MiB, and verifies the declared SHA-256 digest before
returning bytes.

Scrubber uses its existing unified seek path: Web Animations receive
`Animation.currentTime`, while SVG/SMIL receives `SVGSVGElement.setCurrentTime`.
That mirrors Chromium's timing authorities in
`external/chromium/third_party/blink/renderer/core/animation/animation.cc` and
`external/chromium/third_party/blink/renderer/core/svg/svg_svg_element.cc`.
Preview does not introduce an independent timeline.

## Verification

`src/scrubber/embed.test.ts` covers state normalization and protocol rejection.
`src/studio/app-projects.test.ts` covers SVG path containment, traversal, type,
and symlink escape rejection. `src/studio/server.e2e.test.ts` drives scene
switching, scrubbing, range selection, frame stepping, regeneration with
context retention/clamping, and whole-story playback in Chromium. It also
compares the embedded frame with the production exporter at the same time:
geometry must agree and raster differences are limited to a small number of
edge antialiasing channels.
