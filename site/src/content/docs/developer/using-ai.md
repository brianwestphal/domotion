---
title: Using AI to drive Domotion
description: Domotion is built for AI agents — a declarative surface plus a design playbook to author, render, look, and iterate.
---

Domotion faithfully renders whatever HTML/CSS and timing you give it. Whether the
result is *good* is a design problem — and Domotion is built so an AI agent can
own that loop end to end.

## Point your agent at `llms.txt`

The package ships an [`llms.txt`](https://github.com/brianwestphal/domotion/blob/main/llms.txt)
at the repo root — a concise, self-contained guide for an agent **using Domotion
as a tool**: the CLIs, the config schema, the template library, the API, the
gotchas, and a full **design playbook**. It's distinct from contributor docs.
Point Claude / Cursor / your agent at it.

## You don't have to hand-write the markup

Because Domotion renders whatever markup it's given and an agent can *look at the
result and iterate*, you can describe the demo you want — "a pricing page with
three tiers, the middle one highlighted, that assembles top-down" — and let the
agent write the HTML/CSS, render it, check the pixels, and refine. Designers and
non-coders get a polished, on-brand demo without touching the markup themselves.

## Work the loop: build → render → *look* → critique → iterate

The output is an ordinary, standards-compliant SVG, so an agent can look at it
cheaply and judge it:

1. **Render**, then **rasterize and actually view the pixels** — for a still,
   `svg-to-image out.svg -o out.png`; for an animation, pull key beats with
   `svg-to-image out.svg -o beat.png --at <ms>`, or watch it with
   `svg-to-video` / `svg-scrubber`.
2. **Critique** against the checklist (hierarchy, contrast, easing, pacing,
   restraint). Name the single weakest thing.
3. **Fix that one thing and re-render.** Iterate.

## The playbook in one breath

The `llms.txt` design section distills established practice (Disney's principles,
Material/HIG motion specs, WCAG contrast, Tufte) into Domotion's actual levers:
override `linear` easing on every animation; hold frames long enough to read;
one focal motion at a time; one accent color, 60-30-10, real contrast; pick the
transition for what the cut *means*; and default to restraint.

This site's own [showcase](/domotion/showcase/) and the built-in chart defaults
follow that playbook — e.g. single-series charts emphasize one bar in the accent
rather than rainbow-coloring every bar.
