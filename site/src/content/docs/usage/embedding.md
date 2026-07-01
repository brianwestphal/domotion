---
title: Embedding & reach
description: How to embed a Domotion SVG in Markdown, MDX, docs sites, and HTML — and where the animation plays vs. shows a static frame, with the right export per surface.
---

A Domotion output is one self-contained SVG file, so embedding it is the same as
embedding any image. The one thing worth knowing up front: the file embeds
**everywhere**, but whether its CSS animation *plays* depends on the host — and
for the surfaces that don't animate SVG, you export a still or a video from the
same file.

## Embed it like any image

Markdown:

```markdown
![An analytics dashboard assembling itself](./demo.svg)
```

HTML — give it an `alt` for accessibility:

```html
<img src="demo.svg" alt="An analytics dashboard assembling itself, then a search that types itself" />
```

MDX / Astro / Docusaurus — reference a file in your `public/` (or import it):

```mdx
<img src="/demos/demo.svg" alt="Product demo" style={{ width: "100%", height: "auto" }} />
```

Want the underlying text in the DOM, or need the animation to run in a context
that only animates *inline* SVG? Paste the file's contents inline as `<svg>…</svg>`
(and name it with [`--title`/`--desc`](/domotion/usage/accessibility/) at capture
time, since an inline `<svg>` has no `alt`).

## Where the animation plays

| Surface                                              | Embeds | Animation                          |
| ---------------------------------------------------- | :----: | ---------------------------------- |
| Your own web page / docs site (`<img>` or inline)    |   ✓    | **plays**                          |
| Landing page, GitLab Pages, self-hosted HTML         |   ✓    | **plays**                          |
| GitHub README / npm package page                     |   ✓    | static first frame (SVG sanitized) |
| Email                                                |   ~    | usually stripped entirely          |
| Slide decks / PDF                                     |   ✓    | usually static                     |

It's the same one-file, dependency-free SVG in every case — the only question is
motion.

## Export for surfaces that don't animate SVG

For a GitHub README, email, social, or anywhere the animation won't play, export
a raster from the same SVG — no re-capture needed.

A crisp static frame (pick the beat you want to show):

```bash
svg-to-image demo.svg -o demo.png --at 1200   # the frame at 1200 ms
```

An animated GIF or MP4:

```bash
svg-to-video demo.svg -o demo.gif --format gif
svg-to-video demo.svg -o demo.mp4              # H.264, good for social
```

Rule of thumb: **animated SVG for pages you control; an exported still or GIF/MP4
for GitHub READMEs, email, and social.** See
[Export to video / image](/domotion/usage/export/) for every format and flag.
