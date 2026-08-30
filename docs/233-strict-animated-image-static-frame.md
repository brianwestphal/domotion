---
id: "requirements/strict-animated-image-static-frame"
title: "Strict animated-image static-frame capture"
kind: "contract"
status: "current"
owners: ["images-media","animation"]
platforms: []
tickets: ["DM-2579","DM-2580","DM-2581"]
code: []
aliases: ["docs/233-strict-animated-image-static-frame.md","doc-233"]
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

CSS, SVG, pseudo and shadow image owners remain DM-2581. Downstream resizing
and final serialization provenance remain DM-2580. Live playback and visual
tolerance changes are unsupported.
