---
id: "requirements/studio-application-shell"
title: "Standalone Domotion Studio application shell"
kind: "contract"
status: "current"
owners: ["studio","ui"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2687"]
code: ["src/cli/studio.ts","src/studio/app-projects.ts","src/studio/server.ts","src/studio/client.tsx","scripts/build-studio-client.mjs","src/studio/app-projects.test.ts","src/studio/server.e2e.test.ts"]
aliases: ["docs/240-studio-application-shell.md","doc-240"]
---

# Standalone Domotion Studio application shell

Status: **Shipped foundation.** Domotion Studio is a dedicated local
application. SVG Scrubber remains an independently usable playback/review tool;
Studio does not grow by placing unrelated authoring controls into Scrubber.
Studio can, however, embed Scrubber as a bounded preview surface so both apps
share one playback engine; see `docs/250-studio-embedded-scrubber-preview.md`.

## Entry points

Both entry points launch the same app:

```sh
domotion-studio [project.json] [--workspace <dir>] [--port <n>] [--no-open]
domotion studio [project.json] [--workspace <dir>] [--port <n>] [--no-open]
```

When a project path is supplied, its directory becomes the default workspace.
Without a project, Studio uses the current directory and suggests
`demo.studio.json`. The server binds only to `127.0.0.1`; port 0 selects an
ephemeral local port.

## Workspace and file safety

The UI may create, open, and save only `.json` files beneath its configured
workspace root. Resolution uses the host platform's path semantics, rejects
absolute and `..` escapes, and returns workspace-relative paths to the client.
The pure resolver is tested against both `path.posix` and `path.win32` so drive,
separator, absolute-path, and traversal behavior cannot accidentally become
macOS-only.

Create refuses to overwrite an existing project. Save validates the complete
project before writing, emits canonical two-space JSON, writes a unique sibling
temporary file with exclusive creation, and renames it into place. A validation
or interrupted temporary write therefore cannot truncate the last valid
project. The temporary file is removed on either success or failure.

## Local server contract

The server reuses `startLocalServer`, including its ephemeral-port and prompt
idle-connection shutdown behavior. It serves one bundled Kerf client and three
JSON operations:

- `POST /api/create` with `{ path, title, width?, height? }` creates a valid
  version-1 project containing one narrative beat and one title-card scene.
- `POST /api/open` with `{ path }` validates and returns a project.
- `POST /api/save` with `{ path, expectedHeadRevisionId, project }` validates and
  atomically replaces an existing project without permitting review-history
  changes; a stale review head returns HTTP 409.
- `POST /api/annotation` applies one create/edit/status command through the
  revision-provenanced annotation model and persists it atomically. This
  browser-facing route always records a human author.

Every body is size-bounded and strictly validated. Studio model failures return
HTTP 400 with the exact structured `{ path, message, code }` issues produced by
`StudioProjectValidationError`; a future format version therefore appears as an
actionable `$.version` error in the app rather than a generic load failure.

The HTML bootstrap escapes script-closing markup before embedding project data.
The server exposes no arbitrary read/write endpoint and never accepts a client
supplied workspace root.

## First visual workflow

The shell deliberately starts at the high level. It shows:

- project identity, format version, save/dirty state, and workspace-relative
  file path;
- editable narrative title, summary, objective, audience, and tone;
- ordered scene cards with stable IDs, editable titles, source/timing summaries,
  and per-scene generated/needs-generation status; and
- aggregate scene, artifact, and open-annotation counts; and
- project/scene review notes with optional point/range and region grounding,
  editable bodies, and resolve/reopen controls.

Create, open, save, and reopen are working controls. Reopen discards unsaved
client edits by reloading the validated file. There are no placeholder timeline,
generation, or scene-structure controls: those arrive in their dedicated Studio
tickets on the same project source of truth.

The responsive two-column layout collapses to one column below 800 CSS pixels,
all controls retain visible keyboard focus, status/errors use live regions, and
the complete workflow has a real Chromium E2E assertion. The client is authored
in `src/studio/client.tsx`, bundled to a checked-in generated TypeScript string,
and served without a separate frontend toolchain at runtime.

## Verification

`src/studio/app-projects.test.ts` covers POSIX/Windows path boundaries, valid
default creation, no-overwrite behavior, atomic save/reopen, and structured
server validation errors. `src/studio/server.e2e.test.ts` drives the rendered
Kerf UI through create → edit narrative/scene → save → make an unsaved edit →
reopen, then checks the persisted file and page-error stream.

No font, glyph, layout-capture, or SVG-paint logic changes in this shell. Future
preview/capture features must continue using the existing Chromium, HarfBuzz,
Skia, and platform-native authority routes documented by their domain handbooks.
