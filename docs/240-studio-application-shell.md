---
id: "requirements/studio-application-shell"
title: "Standalone Domotion Studio application shell"
kind: "contract"
status: "current"
owners: ["studio", "ui"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-2687", "DM-S31XF3", "DM-1X1GQ8", "DM-5YECNS"]
code:
  [
    "src/cli/studio.ts",
    "src/studio/app-projects.ts",
    "src/studio/project-json-schema.ts",
    "src/studio/server.ts",
    "src/studio/client.tsx",
    "scripts/build-studio-client.mjs",
    "src/studio/app-projects.test.ts",
    "src/studio/server.e2e.test.ts",
    "tests/studio-responsive-metrics.e2e.test.ts",
    "src/utils/local-server.ts",
    "src/utils/local-server.e2e.test.ts",
  ]
aliases: ["docs/240-studio-application-shell.md", "doc-240"]
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

Every workspace-bounded path — project files, generated preview SVGs, recording
evidence, agent-tool artifacts and `logo-reveal` assets (bounded by the asset
directory) — goes through one resolver, `resolveInsideWorkspace`
(`src/studio/workspace-path.ts`). Besides the lexical check it follows symlinks:
a `.json` inside the workspace that links elsewhere, or a new file under a linked
directory, is rejected because its real location is outside the real workspace.

HTTP status mapping is typed rather than inferred from message text. A stale
review head is any Studio error carrying `code: "stale-head"` (raised by
`assertHeadRevision`, `src/studio/stale-head.ts`) and answers 409; an oversize
body is `HttpError(413)`; a malformed body or unknown project error is 400; and an
operating-system failure such as `EACCES` or `ENOSPC` is 500. The request helpers
(`HttpError`, `readJsonBody`, `sendJson`) are shared with the scrubber server in
`src/utils/local-server.ts`.

Create refuses to overwrite an existing project. Save validates the complete
project before writing, emits canonical two-space JSON, writes a unique sibling
temporary file with exclusive creation, and renames it into place. A validation
or interrupted temporary write therefore cannot truncate the last valid
project. The temporary file is removed on either success or failure.

## Local server contract

The server reuses `startLocalServer`, including its ephemeral-port and prompt
idle-connection shutdown behavior. It serves the bundled Kerf client at `GET /`
(`GET /index.html` is an alias) and `GET /client.js`, plus the embedded Scrubber
at `GET /scrubber` and `GET /scrubber/client.js`. Its JSON operations are
workspace-bounded:

The published `domotion-studio` / `domotion studio` binary starts the server
without AI adapters. Its bootstrap reports `generationAvailable: false` and
`recordingImportAvailable: false`, disabling Generate and Import controls.
Embedding hosts can supply `generate` and `recordingAi` to `startStudioServer`;
the corresponding `/api/generate` and `/api/recording/import` routes return HTTP
501 when their adapter is absent. Generation always receives
`aiPolicy: { healing: "required", review: "required" }`.

- `POST /api/create` with `{ path, title, width?, height? }` creates a valid
  version-1 project containing one narrative beat and one title-card scene.
- `POST /api/open` with `{ path }` validates and returns a project.
- `POST /api/save` with `{ path, expectedHeadRevisionId, project }` validates and
  atomically replaces an existing project without permitting review-history
  changes; a stale review head returns HTTP 409.
- `POST /api/annotation` applies one create/edit/status command through the
  revision-provenanced annotation model and persists it atomically. This
  browser-facing route always records a human author.
- `POST /api/recording/import` validates a redacted browser recording, checks
  the expected project revision, requires AI healing and AI review (or returns
  their clarification without mutation), writes workspace-bounded evidence,
  and appends the accepted ordinary semantic scene.
- `POST /api/timeline` applies exact timing overrides through the shared UI/AI
  command model, appends revision provenance, atomically validates/saves, and
  returns the inverse command for undo/redo.
- `POST /api/preview` with `{ path, selection }` returns the current generated
  scene or story SVG and its provenance. Selection is `{ kind: "story" }` or
  `{ kind: "scene", sceneId }`; see doc 250 for artifact selection and path safety.
- `POST /api/generate` with `{ path, expectedHeadRevisionId, selection }`
  invokes the host generation adapter, requires AI healing and review, validates
  the returned artifact and provenance, and saves the updated project. The
  selection has the same shape as preview; an AI clarification returns without
  changing the project.

Every JSON body is capped at 4 MiB (HTTP 413 above the limit) and strictly
validated. Create returns HTTP 201; other successful operations return HTTP 200. Missing project files, scenes, or current preview artifacts return HTTP 404. Stale review heads return HTTP 409; preview also returns 409 when the SVG
digest differs from saved provenance. Generate and recording import return HTTP
501 when their required adapters are absent. Preview SVG reads have a separate
64 MiB limit (HTTP 413). Studio model failures return HTTP 400 with the exact
structured `{ path, message, code }` issues produced by
`StudioProjectValidationError`; a future format version therefore appears as an
actionable `$.version` error in the app rather than a generic load failure.

The HTML bootstrap escapes script-closing markup before embedding project data.
The server exposes no arbitrary read/write endpoint and never accepts a client
supplied workspace root.

### Cross-site request guard

Binding to `127.0.0.1` keeps other machines out, but any web page open in the
user's browser can still reach a loopback port. Every request therefore passes
`checkLocalRequest` (`src/utils/local-server.ts`) before routing, so Studio, the
standalone and embedded Scrubber, and `svg-review` share one guard:

- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; anything
  else answers 403, for GET too. This defeats DNS rebinding, where a hostile
  domain re-resolves to 127.0.0.1 and would otherwise read responses.
- A request other than GET/HEAD that carries an `Origin` must carry the
  server's own origin (403 otherwise; `Origin: null` is refused). Browsers send
  `Origin` on every cross-origin POST, including `no-cors` ones.
- A request other than GET/HEAD must declare `content-type: application/json`
  (415 otherwise). A cross-origin page can send `text/plain` or form bodies
  without a CORS preflight, but not JSON, and the server never approves a
  preflight.

Requests without an `Origin` (curl, Node `fetch`, scripted tests) are accepted
when they send the right `Host` and a JSON body, so local automation keeps
working. `src/utils/local-server.e2e.test.ts` drives Chromium from a second
loopback origin and proves a cross-site save, scrubber ticket write and
rebinding read are refused with no side effect. The guard does not
authenticate other local processes or users; any program on the machine that
can open the port can still call the API. That boundary is deliberate. A
per-launch token embedded in the page would not close it, because any local
program can request the page and read the token, since only browsers are
restricted by the Host and Origin checks. A process running as the same user
can already read the project files and the AI adapter's credentials directly.
Another OS user on a shared machine is the only remaining gap, and covering it
would take a launch-URL token with a cookie checked on every route. That is out
of scope for a developer tool you launch yourself.

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
client edits by reloading the validated file. High-level narrative beats, scene
structure/source/timing/transition/treatment, undo, and required-AI generation
controls are specified in `docs/251-studio-high-level-authoring.md`.
Real browser recording, redaction, AI semantic import, and editable action
timing are specified in `docs/252-studio-real-interaction-import.md`.
The zoomable, keyboard-accessible multitrack timing editor is specified in
`docs/253-studio-detailed-multitrack-timeline.md`.

The Generation & Review counters wrap within their own panel when their full
labels and padding cannot share a row. The cards grow equally within each row;
counts, labels and source order remain visible. This adapts to the panel's
available width, including the intermediate viewport range where the outer
layout still has two columns. No clipping or viewport-specific counter breakpoint
is used.

The responsive two-column layout collapses to one column at or below 800 CSS pixels,
all controls retain visible keyboard focus, status/errors use live regions, and
the complete workflow has a real Chromium E2E assertion. The client is authored
in `src/studio/client.tsx`, bundled to a checked-in generated TypeScript string,
and served without a separate frontend toolchain at runtime. Its delegated
button entry point routes through cohesive timeline, authoring, preview,
project, and annotation handlers; each handler owns one workflow while the
shared busy/error wrapper remains the single async boundary.

The chrome comes from `@kerfjs/ui` ([doc 273](273-ui-conventions.md)):

- status, success and error messages render as a `StateBanner` (errors use an
  alert live region; validation issues are listed under the banner);
- an unselected Scrubber Preview shows an `EmptyState`;
- the preview selector ("Whole Story", "Scene N") is a controlled
  `SegmentedControl`: one exclusive group labeled "Preview", each segment
  keeping its "Whole Story" / "Scene N" accessible name and reporting
  `aria-pressed`. Before the first choice no segment is pressed. All segments
  share one `preview-select` action whose `data-segment-value` is `story` or
  `scene:<scene id>`. A segment is disabled while a preview loads or when its
  artifact is missing, and the group wraps at narrow widths;
- the busy preview refresh shows a `LoadingSpinner`;
- the project actions carry decorative lucide icons through `LucideIcon`, with
  their text labels unchanged.

Two pieces stay bespoke. The timeline toolbar (Earlier, Later, Shorter,
Longer, Undo Timeline, Redo Timeline, next to the zoom and snap fields) stays
plain text buttons: `ToolbarControlGroup` styles its child buttons as 2rem
icon pills with no padding, so adopting it would mean icon-only verbs, and
there is no standard icon that reads as "Shorter" or "Longer". The "Create or
open a Studio project" hero keeps its own markup because kerf-ui's
`EmptyState` renders its title as `<strong>`, while the page outline needs that
title to be an `h2` heading.

The kerf-ui CSS is folded into `/client.js` at build time. The page stylesheet
is installed in `<head>`, outside the `mount()` tree: a `<style>` child in JSX
is text-escaped, which used to drop quoted font names, so the page fell back to
the browser's serif font.

## Verification

`src/studio/app-projects.test.ts` covers POSIX/Windows path boundaries, valid
default creation, no-overwrite behavior, atomic save/reopen, and structured
server validation errors. `src/studio/server.e2e.test.ts` drives the rendered
Kerf UI through create → edit narrative/scene → save → make an unsaved edit →
reopen, then checks the persisted file and page-error stream.

`tests/studio-responsive-metrics.e2e.test.ts` loads the committed treatment
showcase project in the real Studio server and checks 1440 → 900 → 390 → 1440
CSS-pixel viewport transitions. Each counter and label must stay inside its
owning panel, cards must not overlap, values/order and disabled generation
behavior remain intact, returning wide restores the initial geometry, and adding
a scene then undoing updates the displayed count without saving the fixture.
Page-level horizontal overflow alone is insufficient to detect panel overflow.

No font, glyph, layout-capture, or SVG-paint logic changes in this shell. Future
preview/capture features must continue using the existing Chromium, HarfBuzz,
Skia, and platform-native authority routes documented by their domain handbooks.
