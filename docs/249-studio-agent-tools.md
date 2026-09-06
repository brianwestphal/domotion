---
id: "requirements/studio-agent-tools"
title: "Domotion Studio agent authoring and generation tools"
kind: "contract"
status: "current"
owners: ["studio","ai","product-tooling"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2693"]
code: ["src/studio/agent-tools.ts","src/studio/agent-tools.test.ts","src/studio/index.ts"]
aliases: ["docs/249-studio-agent-tools.md","doc-249"]
---

# Domotion Studio agent authoring and generation tools

Status: implemented in DM-2693.

## Requirement

AI agents need to author a product demo without inventing a second project
model or scraping the Studio UI. The automation boundary must expose the same
versioned JSON project facts that the standalone Studio uses, cover the whole
create → capture → preview/video → review → revise loop, and make uncertainty,
authority, destructive intent, and generated evidence visible to an MCP or CLI
host.

The storyboard remains mostly static JSON. Individual capture segments may use
explicit TypeScript hooks already represented by Studio's `scriptHooks`, but a
tool payload cannot inject arbitrary code or choose a trusted actor. AI healing
and AI review are always part of generation policy; when evidence does not
support a unique repair or review decision, the tool returns a clarification
instead of guessing. There is intentionally no token, dollar, or other budget
management in this protocol.

## Source of truth and transport

`src/studio/agent-tools.ts` defines `STUDIO_AGENT_TOOL_VERSION = 1` and the
strict Zod request, response, and artifact schemas. The request schema embeds
the existing `studioSceneSchema`, `studioSceneRenderSchema`,
`studioSemanticTrackSchema`, `studioAnnotationTargetSchema`, and
`studioTreatmentsSchema`; therefore MCP JSON Schema can be projected from the
runtime schema and cannot silently drift into a parallel authoring format.

`runStudioAgentTool(project, request, options)` is the transport-neutral core.
An MCP server can register one tool using `studioAgentToolRequestSchema`; a CLI
automation host can parse one JSON request at a time and call the same function;
a TypeScript application can call it directly. Project persistence and session
selection stay with the host so an untrusted request cannot choose an arbitrary
file. Capture, preview, and video work are injected adapters, allowing a host to
connect the existing Studio compiler, browser session, healing loop, and video
review pipeline without putting browser handles or code in JSON.

| Tool | Project operation | Important result |
| --- | --- | --- |
| `project.inspect` | Read a compact project outline | Stable scene/track/action IDs, review head, annotations, and artifacts |
| `project.create` | Create the smallest useful Studio document | Valid project and digest; author comes from the trusted host |
| `project.edit` | Patch narrative or scenes/tracks; add/remove scenes | New content revision, removed stable IDs, and new digest |
| `capture.compile` | Invoke the host capture adapter | Exact artifact paths and structured DOM/CSS evidence |
| `render.preview` | Invoke the host preview adapter | Exact SVG/image artifact paths and provenance |
| `render.video` | Invoke the host video plus required-AI-review adapter | Reviewed media, or a clarification with supporting evidence |
| `annotation.apply` | Create/edit/lifecycle-update the shared annotation queue | Annotation and review revision IDs |

Every response is compact and has one of four explicit states:

- `ok`: the operation completed and any updated project is returned.
- `clarification`: user intent or required AI review is ambiguous; the response
  carries a question, reason, and optional bounded choices.
- `permission-required`: the host did not grant the exact named capability.
- `conflict`: the request's project digest is stale.

Generated artifacts report both a canonical absolute `path` and normalized
`workspacePath`. The core verifies that they agree and remain within the
host-supplied workspace root. Adapters return structured evidence separately
from the prose summary, so an MCP client need not parse logs to locate a file or
understand what was inspected.

## Authority and safety

Authority is supplied only through `RunStudioAgentToolOptions`:

- `actor` is trusted host state and is written into AI/human/system revision and
  annotation provenance. It cannot be impersonated through a request.
- `editProject`, `capture`, `artifactWrites`, `overwriteArtifacts`, and
  `renderVideo` are independent capabilities.
- Removing a stable scene, track, action, or composition-layer identity needs
  both a request-side destructive confirmation (reason plus exact digest) and
  the host's `destructiveProjectEdits` capability.
- Mutations require the SHA-256 project digest returned by the preceding tool
  call. A stale agent cannot overwrite concurrent authoring or review work.
- Artifact paths cannot escape the workspace. Existing destinations require an
  explicit `overwrite` request and the separate overwrite capability.
- Generation callbacks, filesystem persistence, browser ownership, arbitrary
  TypeScript hook loading, credentials, and network policy remain host concerns;
  they are never granted by JSON fields.

## Proactive inspection and required AI stages

Capture adapters are expected to use the interactive Studio pipeline, which
inspects the actual live DOM, accessibility identity, geometry, computed CSS,
pseudo-state, and post-action mutations rather than assuming what a page did.
They should return that evidence in the response and persist important evidence
as revision-provenanced Studio artifacts.

Video requests literally require `review: "required"`; there is no opt-out
variant. The host video adapter must run the required AI review pipeline and may
return a clarification when the evidence supports multiple meaningful fixes.
Capture/replay failures similarly belong behind the required AI healing adapter
described in doc 245. This tool layer carries results and checkpoints; it does
not weaken those policies.

## Verification

`src/studio/agent-tools.test.ts` exercises the complete automation story with
real temporary artifacts: an AI creates a project, authors a capture scene and
semantic action, receives proactive DOM/computed-CSS evidence, renders a
preview, creates a region/time/DOM/action-grounded AI annotation, revises the
narrative, and inspects the compact result. Companion tests prove ambiguous
selection, stale digests, destructive confirmation, path traversal, and
required video-review clarification behavior.

## Related sources

- `docs/239-studio-project-model.md` — durable project and artifact model
- `docs/240-studio-application-shell.md` — separate local Studio authority
- `docs/241-studio-semantic-interactions.md` — semantic tracks and explicit hooks
- `docs/243-studio-interaction-observation.md` — proactive DOM/CSS evidence
- `docs/245-studio-ai-healing-loop.md` — mandatory AI healing and clarification
- `docs/246-studio-ai-video-review.md` — mandatory visual-quality review
- `docs/248-studio-unified-review-annotations.md` — shared human/AI annotation API
