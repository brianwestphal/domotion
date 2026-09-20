---
title: Domotion Studio
description: A local visual workspace for authoring and reviewing durable, versioned Domotion projects.
---

Domotion Studio is the visual authoring and review surface for projects that are
larger than a single CLI recipe. It runs as a local browser app while keeping
the project itself in portable, validated JSON.

```bash
# Start with a workspace. Studio can create and open project JSON within it.
domotion-studio --workspace ./demo-project

# Or open an existing project directly.
domotion-studio ./demo-project/product-tour.json
```

The same app is available as `domotion studio`. The standalone
`domotion-studio --help` command is the authoritative option reference.

## What the workspace includes

- High-level story and scene authoring with immutable project revisions
- A detailed multitrack timeline on one shared project clock
- Embedded SVG playback and scrubbing
- Project-, scene-, time-, and region-scoped review annotations shared by human
  and AI reviewers
- Import of redacted real-browser interaction recordings into editable scenes
- Semantic interaction tracks, cursor choreography, cinematic treatments, and
  generation/review adapter hooks

Studio delegates rendering to Domotion's existing capture, animation,
storyboard, compositing, and video pipelines. The project JSON is the durable
source of truth; generated SVGs, evidence, and review reports remain replaceable
artifacts.

## Workspace and file safety

The local server can create, open, and save only `.json` files beneath the
configured workspace. Passing a project path scopes the workspace to that
project's directory unless `--workspace` is supplied explicitly.

Studio opens the system browser by default. In CI or agent automation, keep the
browser launch headless:

```bash
domotion-studio ./demo-project/product-tour.json --no-open
```

Drive the printed loopback URL, and stop the server with Ctrl-C when finished.
Use `--port <n>` only when a fixed local port is required; otherwise Studio asks
the operating system for a free port.
