---
id: "requirements/transitive-svg-fragment-resource-ownership"
title: "Transitive SVG fragment-resource ownership"
kind: "contract"
status: "current"
owners: ["layout"]
platforms: []
tickets: []
code: []
aliases: ["docs/222-transitive-svg-fragment-resource-ownership.md","doc-222"]
---

# Transitive SVG fragment-resource ownership

CSS `mask-image: url(#…)` and `clip-path: url(#…)` do not own only the first matching element. Chromium resolves a live dependency graph: `href` and `url()` edges may reach sibling gradients, patterns, filters, markers, symbols, masks, or clip paths, and each edge resolves in the referencing element's originating TreeScope.

Domotion captures that graph explicitly. Each node carries its TreeScope and serialization location; each occurrence carries a unique edge token, resolution result, and target. Computed SVG paint winners are baked into the copied markup, while geometry and transform attributes remain native SVG inputs so object-bounding-box units and consumer positioning are not physicalized twice. Out-of-subtree dependencies are hoisted into the generated `<defs>` and the whole graph receives one collision-free namespace.

The renderer validates node identity, scope, reachability, edge occurrence counts, containment, and the captured cycle set before emission. Missing, stale, external, cross-scope, or forged graphs fail closed. Cycles are retained rather than blanket-rejected because Chromium assigns resource-specific behavior to gradient, pattern, use, mask, clip, and filter cycles.

Exact evidence covers a same-origin iframe whose mask reaches a sibling gradient while the outer document owns duplicate IDs. DPR 1 and 2 source/render probes remain exact, and destructive unit controls reject wrong scope, stale edges, forged cycles, and unresolved token substitution.

Remaining boundary: remote/blob resource lifetimes and stylesheet rules that cannot be represented as computed SVG paint are not treated as frozen local graph ownership.
