---
id: "handbook/manual-test-plan"
title: "Manual test plan"
kind: "reference"
status: "current"
owners: ["platform-release"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-YD693C"]
code:
  [
    "docs/handbook/major-release-visual-capture.md",
    "docs/26-self-contained-svgs.md",
    "tests/kerf-client-uis.e2e.test.ts",
    ".github/workflows/generic-profile-target-parity.yml",
    ".github/workflows/windows-fidelity.yml",
  ]
aliases: ["docs/handbook/manual-test-plan.md"]
---

# Manual test plan

Use this plan only for judgments that the automated gates cannot reliably make.
Record the commit, platform, viewer or browser version, result, and any skipped
check in the relevant ticket or release handoff. A manual pass does not replace
the unit, browser E2E, visual comparison, or platform parity gates.

## Release artwork and site presentation

**When:** before approving public visuals for a major release, or when changing
the README, site hero, demo assets, or showcase animations.

Follow the [major-release visual capture checklist](major-release-visual-capture.md).
Inspect its named assets at native size and 2×, watch complete animation loops,
and review the homepage and showcase at desktop and narrow widths. Judge
legibility, clipping, motion pacing, visual hierarchy, and whether the public
copy accurately describes the rendered output. Record inspected frame times,
source commits, accepted assets, and any unavailable check in the release
handoff. The checklist owns the detailed asset inventory and approval criteria.

## Native SVG viewer portability

**When:** changing resource embedding, filters, masks, animation, or SVG
serialization used by distributed examples on macOS.

Open a representative self-contained SVG from `examples/output/` in macOS
Preview and Quick Look with network access unavailable. Check that embedded
images and fonts appear, no resource is blank or replaced by a broken-image
placeholder, and the static frame is readable. Record the SVG path, producing
commit, macOS version, viewer, and result. The portability contract and the
expected embedding route are in [doc 26](../26-self-contained-svgs.md). This
viewer check is specific to macOS; Linux and Windows parity remains governed
by their automated platform lanes and any native viewer review required by a
particular release.

## Automated Coverage Summary

| Area                                                     | Automated coverage                                                                                                                                                                   | Remaining human judgment                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Public demos and site                                    | Example generation, site build, visual regression suites, and release capture/decode evidence in the [release checklist](major-release-visual-capture.md).                           | Approve appearance, pacing, legibility, and public claims.                                             |
| Self-contained SVGs                                      | Embed and hoist unit tests plus browser E2E tests listed in [doc 26](../26-self-contained-svgs.md).                                                                                  | Check a native macOS viewer's handling of the distributed SVG.                                         |
| Studio and Scrubber interactions                         | `tests/kerf-client-uis.e2e.test.ts` drives both browser UIs; server E2E tests cover HTTP behavior.                                                                                   | No standing manual-only interaction check. Add one here if a new behavior cannot be asserted reliably. |
| Authenticated browser profiles and Windows font fidelity | `.github/workflows/generic-profile-target-parity.yml` and `.github/workflows/windows-fidelity.yml` run automated platform gates, including their headed or manually dispatched legs. | Dispatching a workflow is an execution choice, not a manual test.                                      |

When an item gains reliable automated coverage, remove its manual procedure and
update this summary with the test or workflow that now owns it.
