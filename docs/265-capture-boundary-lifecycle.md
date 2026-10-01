---
id: "requirements/capture-boundary-lifecycle"
title: "Capture boundary lifetime"
kind: "contract"
status: "current"
owners: ["capture"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-WS5R8D", "DM-ERHTRB"]
code:
  [
    "src/capture/page-registry.ts",
    "src/capture/evaluate-in-frame.ts",
    "src/capture/cdp-lifecycle.ts",
    "src/capture/index.ts",
  ]
aliases: ["docs/265-capture-boundary-lifecycle.md", "doc-265"]
---

# Capture boundary lifetime

Capture runs prepasses in the inspected browser before the synchronous tree walk. Some retain live DOM nodes or fetched `Document` objects, and some open a Chromium CDP session. These resources belong to one capture and must be removed when it finishes or fails.

`src/capture/page-registry.ts` creates a collision-resistant private key for a browser-side value. `tag` initializes the value in a frame without serializing live DOM objects to Node; `read` returns a caller-owned Playwright handle; `dispose` deletes the private value from every tagged frame. The external SVG `<use>` prepass uses this registry to retain fetched documents through the walk.

Scrollbar discovery holds its live node list and temporary paint-marker rollback state in separate registries. The marker rollback is published before any DOM mutation, and its exact style and attribute restoration runs before the registry is deleted. Projective surface isolation likewise owns a per-target visibility rollback registry, restoring each declaration before disposal. These scopes allow repeated captures on one page without reusing or leaving private page state.

`src/capture/evaluate-in-frame.ts` serializes trusted browser callbacks with a lexical `__name` binding for source runs transformed by esbuild. The binding is scoped to the evaluation and does not alter `globalThis` on the inspected page. `browserCallbackExpression` supplies the same scope for context init scripts and CDP `Runtime.evaluate`. Generated CSS image probes share its three-second decoder deadline.

`runPrepasses` in `src/capture/cdp-lifecycle.ts` prepares independent resources concurrently. It waits for every preparation result and disposes successful resources if any preparation fails, preserving both preparation and cleanup errors. `disposeAll` visits every disposer even after one rejects. The capture pipeline uses these helpers before and after its tree walk.

`withCdpSession` owns a short-lived CDP session through a callback and detaches it after success or failure. Its optional same-process-frame fallback is used only when Playwright reports that a child frame has no separate session. Long-lived sessions that retain remote objects through the tree walk remain owned by their returned prepass disposer.
