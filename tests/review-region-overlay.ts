// Re-export shim — `tests/review-client.tsx` imports the region-overlay
// helpers from this sibling path so esbuild's bundler sees a local
// `.ts` file and routes through it cleanly. The actual implementation
// moved to `src/review/region-overlay.ts` when the `svg-review`
// published CLI was added (commit c4048bb); the in-repo demo review
// kept the same import surface via this thin re-export so changes to
// the moved file don't require updating `tests/review-client.tsx`
// each time. esbuild's default extension resolution treats `.js`
// literally on relative imports, which is why the previous
// `from "../../src/review/region-overlay.js"` import failed at build
// time despite the matching `.ts` source existing.
export * from "../src/review/region-overlay.js";
