# Glassbox Studio benchmark

This directory contains the durable Studio source for Domotion's north-star
integration benchmark. It captures the sibling `../glassbox` checkout's real
demo UI, wraps the live workflow in a concise product story, and proves required
AI healing and review.

Run the full acceptance path from the Domotion repository:

```sh
npm run benchmark:glassbox
```

The command builds Glassbox's client, uses an isolated temporary Glassbox config,
renders and AI-reviews the baseline video, simulates an accessible-name UI
change, heals and recaptures it from live DOM/CSS evidence, and publishes the
accepted baseline to `../glassbox/assets/demo.svg` plus `.svgz`.

For faster non-publishing iteration:

```sh
npm run benchmark:glassbox:quick
```

Generated scene artifacts, project revisions, video, reports, and candidate
SVGs are written under `generated/` and ignored by git. The tracked
`glassbox.project.json` remains the source of truth and can be opened in the
separate Studio app.
