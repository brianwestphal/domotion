---
title: Building custom templates
description: Package reusable, parameterized SVG generators as domotion-template-<name> npm packages.
---

A template is a parameterized generator that produces a self-contained SVG
through Domotion's capture/compose pipeline. The built-ins (lower-third, chart,
kinetic-text, …) are just templates that ship in the box — you can author your
own and publish them.

## The discovery convention

Publish a template as an npm package named **`domotion-template-<name>`**. Once
installed, it's usable by `<name>`:

```bash
npm install domotion-template-acme-banner
domotion template acme-banner --title "Launch" -o banner.svg
```

## Why author one

The strongest way to keep many on-brand visuals consistent is to bake the brand
— palette, type scale, spacing, motion vocabulary — into a template and expose
only the content as parameters. Then every banner / card / chart is
`domotion template <name> --title …` and is consistent by construction.

## What a template provides

- A **parameter schema** (so the CLI gets `--flags`, help text, and validation).
- A **generator** that turns params into HTML/CSS (captured) or SVG, optionally
  animated.

:::note
The full authoring guide, the runnable example package, and the API contract
(`renderTemplateToSvg`, the template type) live in the repo's templates docs and
`examples/template-package/`. A later phase will sync the canonical guide here.
:::

See also the [design playbook](/domotion/developer/using-ai/) for making the
output genuinely compelling, not just correct.
