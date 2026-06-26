---
name: check-requirements-against-code
description: Check requirements docs against implementation and report discrepancies
allowed-tools: Read, Grep, Glob, Bash, Agent
---

Comprehensively compare the requirements documents in `docs/` against the actual implementation. Generate a report with recommendations and questions about any discrepancies. Also synchronize the AI summary documents and verify CLAUDE.md references.

## Steps

1. **Read all requirements documents** in `docs/` (all numbered files, not just 1-13). Note every stated requirement, behavior, and constraint.

2. **For each requirement**, verify it against the implementation:
   - Search the codebase for the relevant code
   - Check if the behavior matches what's documented
   - Note any differences, missing features, or extra features not in the docs

3. **Check for undocumented features**: Scan the codebase for significant functionality that isn't covered by any requirements document. These are features that should either be documented or questioned.

4. **Check for stale documentation**: Requirements that describe behavior that no longer exists or has changed.

5. **Synchronize AI summary documents**:
   - Read `docs/ai/code-summary.md` and verify it reflects the current codebase structure (directories, routes, schema, commands, tools). Update any sections that are stale.
   - Read `docs/ai/requirements-summary.md` and verify the status markers (Shipped/Partially built/Design only) are correct. Update any that have changed.
   - Check that both summaries reference all current docs.

6. **Verify CLAUDE.md references**:
   - Check that all requirements docs in `docs/` are referenced or covered by the guidance in CLAUDE.md.
   - Check that the AI summary docs (`docs/ai/code-summary.md`, `docs/ai/requirements-summary.md`) are referenced with their maintenance rules.

## Report Format

### Discrepancies Found

For each discrepancy:
- **Requirement**: Which doc, section number, and the stated requirement
- **Implementation**: What the code actually does (file path, line numbers)
- **Type**: `missing` (doc says X, code doesn't do X) | `different` (doc says X, code does Y) | `undocumented` (code does X, no doc mentions it) | `stale` (doc says X, feature was removed/changed)
- **Recommendation**: Should the doc be updated, or should the code be fixed?

### AI Summary Sync

List any updates made to `docs/ai/code-summary.md` or `docs/ai/requirements-summary.md` to bring them in sync.

### CLAUDE.md Coverage

List any requirements docs not referenced or covered by CLAUDE.md guidance.

### Questions

List any ambiguous requirements where the implementation had to make a judgment call, and ask whether the current behavior is correct.

### Summary

- Total requirements checked
- Requirements fully implemented
- Discrepancies found (by type)
- Documentation gaps
- AI summaries synced (yes/no, changes made)
