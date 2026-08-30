---
id: "requirements/frozen-animated-image-downstream-ownership"
title: "Frozen animated-image downstream ownership"
kind: "contract"
status: "current"
owners: ["images-media","animation"]
platforms: []
tickets: ["DM-2580","DM-2581"]
code: []
aliases: ["docs/234-frozen-animated-image-downstream-ownership.md","doc-234"]
---

# Frozen animated-image downstream ownership

Status: implemented base-owner resize/serialization contract (DM-2580)

After doc 233 selects a strict frame, every downstream image path receives
only its authenticated PNG data URI. The original GIF/APNG/WebP bytes and URL
are not inputs to embedding, Sharp/libvips, resize caches, deduplication, or SVG
serialization.

When resize-on-embed is enabled, the pre-pass verifies the frozen PNG digest
before Sharp opens it. It records the authenticated source epoch, encoded
source SHA-256, requested frame index, frozen PNG SHA-256, target dimensions,
and exact output dimensions/length/SHA-256. A same-size or larger-result
fallback records the unchanged frozen PNG. Any digest or resize failure on the
strict route fails capture; it cannot silently reopen the animated source or
fall back to page zero. Legacy images keep their historical best-effort
fallback.

The renderer continues to consume the same URL/size caches, but the strict
cache key is the frozen PNG URI. Repeated owners therefore deduplicate only the
already-authenticated still. CSS/SVG slot extension remains DM-2581.
