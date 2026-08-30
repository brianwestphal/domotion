---
id: "requirements/public-svg-css-animated-image-owner-joins"
title: "Public SVG and CSS animated-image owner joins"
kind: "contract"
status: "current"
owners: ["images-media","animation"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2590","DM-2591"]
code: ["tools/animated-image-stock-cdp-support.ts"]
aliases: ["docs/235-public-svg-css-animated-image-owner-joins.md","doc-235"]
---

# Public SVG and CSS animated-image owner joins

Status: evidence-only macOS/Linux subset (DM-2591)

DM-2591 extends the stock-CDP support adjudication without changing production
capture. The retained independent macOS and Linux proposal/validation reports
remain the private owner/resource authority. This document states the smaller
owner identity that public DOM/CSSOM plus the pre-navigation Network ledger can
reconstruct without consuming Blink's private `Resource` pointer.

An SVG `<image>` is eligible only when a unique selector/backend node remains
connected in the same document and its `href.baseVal`, resolved URL, frame,
loader, and document nonce remain exact before and after acquisition. Exactly
one completed, non-cache, non-service-worker ledger entry may match that URL,
frame, and loader.

An ordinary CSS image is eligible only when the caller names one of
`background-image`, `border-image-source`, `mask-image`, or `list-style-image`
and a zero-based top-level computed-value index. That indexed value must be one
plain `url(...)`; the entire serialized computed property, selected resolved
URL, backend node, DPR, viewport, frame, loader, and document nonce must remain
exact before and after acquisition. The same unique ledger rule then applies.

This does not authorize `image-set()`, generated content, pseudos, closed
shadow identities, repeated URL candidates, cache/revalidation, service
workers, cross-origin bodies, or URL-only fallback. Public CSSOM cannot expose
the selected Blink `StyleImage` identity for those cases, so they remain
body-free denials. Windows/global ratification remains owned by DM-2590.

The machine-readable authority is
`ANIMATED_IMAGE_STOCK_CDP_SUPPORTED_SUBSET.publicOwnerJoin` and its exact
38-case matrix in `tools/animated-image-stock-cdp-support.ts`.
