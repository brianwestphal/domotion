---
id: "requirements/strict-animated-image-static-frame"
title: "Strict animated-image static-frame capture"
kind: "contract"
status: "current"
owners: ["images-media", "animation"]
platforms: []
tickets: ["DM-2579", "DM-2580", "DM-2581"]
code:
  [
    "src/capture/animated-image-static-frame.ts",
    "tests/animated-image-static-frame.e2e.test.ts",
    "tests/animated-image-static-frame.test.ts",
  ]
aliases: ["docs/233-strict-animated-image-static-frame.md", "doc-233"]
---

# Strict animated-image static-frame capture

Status: production base-owner transaction (DM-2579)

When `CaptureOptions.animatedImageFrames` is absent, animated images retain the
legacy capture path exactly. When present, doc 232 first authenticates the
selected encoded bytes for each ratified `<img>/<picture>` or image-input
owner. This transaction then uses only those immutable bytes.

In a secure Chromium realm it constructs `ImageDecoder` with
`preferAnimation: true`, waits for track readiness, requires one selected
animated track with a finite bounded frame count and an in-range requested
index, and decodes with `completeFramesOnly: true`. A fresh validation decoder
first walks frames in reverse order and then repeats the requested index. The
requested observation must agree exactly across decoders in track metadata,
VideoFrame geometry/timing/format/color-space facts, raw RGBA SHA-256, and PNG
SHA-256. The owner, selected source and authenticated byte record are
reverified before replacement.

Only after agreement does the transaction replace the requested live owner
with the authenticated PNG. For `<picture>`, source candidates and the image's
`srcset` are removed before setting `src`; image inputs receive the same PNG
through `src`. The later captured tree therefore cannot retain the animated
source or decoder continuation. Errors are stable fail-closed codes and never
contain source bytes, digests, URLs, or decoder exception text.

The failure scope is the **whole capture**, not the failing request. In
`captureUrl` (`src/capture/index.ts`), the doc 232 collector
(`AuthenticatedAnimatedImageByteCollector.collect`,
`src/capture/authenticated-animated-image-bytes.ts`) authenticates every
request before any freeze starts. It throws `AnimatedImageByteCollectorError`
on the first failing request: a missing owner (`strict-owner-not-found`), an
ambiguous or unsupported owner, or any other stable code. No request is frozen
in that case. `freezeAuthenticatedAnimatedImageFrames`
(`src/capture/animated-image-static-frame.ts`) then processes the requests in
order and throws `AnimatedImageStaticFrameError` on the first failing one. The
owners it already replaced stay replaced in the live page, but `captureUrl`
rejects, so no captured tree is produced. There is no partial result in which
the failing request alone is skipped.

SVG `<image href>` and ordinary computed CSS image slots shipped later under
DM-2581 ([doc 236](236-strict-static-frames-for-svg-css-images.md)); generated
pseudo and shadow image owners and `image-set()` still fail closed. Downstream
resizing and final serialization provenance shipped under DM-2580
([doc 234](234-frozen-animated-image-downstream-ownership.md)). Live playback
and visual tolerance changes are unsupported.
