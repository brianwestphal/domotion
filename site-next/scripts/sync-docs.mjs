// DM-1308: placeholder for the docs-sync step (mirrors kerf/site's sync-docs).
// Phase 1 authors the site's pages directly under src/content/docs. A later
// phase will pull canonical reference material out of the repo's docs/*.md
// (e.g. the animate-config grammar, the API surface) into _synced/ pages so the
// site can never drift from the source of truth. No-op for now so `prebuild`
// (build-demos → sync-docs) succeeds.
console.log("[sync-docs] nothing to sync yet (Phase 1 authors pages directly) — see DM-1308 plan");
