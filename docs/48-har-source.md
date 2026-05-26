# Domotion: HAR files as a capture source

Requirements for accepting an HTTP-Archive (`.har`) file as a `domotion capture`
input, alongside the existing URL / local-HTML / stdin sources. Origin: DM-883.

> **Status: investigation concluded (DM-883) — implementation deferred (DM-889).**
> Feasibility is high and the design below stands. The maintainer confirmed no
> specific driving use case ("thought it might be useful"), so rather than ship
> public CLI surface speculatively, the **recommended default for each open
> decision is adopted as the plan** (none were overridden) and implementation is
> filed, ready to build, as **DM-889** — to land when a use case arises or it's
> explicitly green-lit. The "Open decisions" section below records the adopted
> defaults.

## Why

A HAR records the full set of network responses for a page load. Replaying one
lets `domotion capture` reproduce a page **deterministically and offline** —
the same bytes every time, no live server, no flakiness from ads/experiments/
auth. Use cases:

- **Deterministic demo/regression fixtures** — capture a real site once into a
  HAR, then re-render it identically forever (this is exactly what the
  `tests/real-world.tsx` suite already does internally).
- **Capturing pages you can't hit live from the capture host** — behind auth,
  ephemeral, intranet, or already torn down — as long as someone recorded a HAR.
- **Reproducible bug reports** — "capture this HAR" is fully self-contained.

## Feasibility — high

The machinery already exists in the repo. `tests/real-world.tsx` records and
replays HARs via Playwright's context-level API:

```ts
await context.routeFromHAR(harPath, { url: "**/*", update: false, notFound: "abort" });
const page = await context.newPage();
await page.goto(recordedUrl, { waitUntil: "domcontentloaded" });
```

The CLI capture path already creates a `BrowserContext` (`src/cli/capture.ts`),
so attaching `routeFromHAR` before `loadInputIntoPage` is a small, localized
change. No new dependency.

## Proposed design

1. **Source detection.** Treat a `<input>` ending in `.har` as a HAR source
   (mirrors the `.svgz`-by-extension output detection). So
   `domotion capture page.har -o out.svg` "just works".
2. **Page URL resolution.** A HAR can contain many entries; we need the main
   document's URL to `goto`. Resolve in order:
   - explicit `--url <url>` flag (required for multi-page HARs / disambiguation);
   - else the HAR's `log.pages[0]` → the entry whose `pageref` matches with an
     HTML `response.content.mimeType` (the top-level document);
   - else the first `text/html` 200 entry.
   Error clearly if none can be found (tell the user to pass `--url`).
3. **Replay.** On the context:
   `routeFromHAR(harPath, { url: "**/*", notFound: "abort" })` — strict offline
   replay so the capture is fully deterministic (every asset must be in the
   HAR). A `--har-fallback` flag flips `notFound` to `"fallback"` to let missing
   assets hit the live network (hybrid mode).
4. **Everything downstream is unchanged** — `--selector`, `--width/--height`,
   `--scroll`, `--wait*`, color-scheme, optimize, etc. operate on the replayed
   page exactly as they do for a live URL.

### CLI shape (recommended)

```bash
domotion capture page.har -o out.svg                 # infer the main page URL
domotion capture page.har --url https://x.com/ -o …  # disambiguate multi-page HAR
domotion capture page.har --har-fallback -o …        # let missing assets hit network
```

## Decisions (adopted defaults)

No driving use case surfaced (DM-883), so the recommended default for each was
adopted as the implementation plan (DM-889); none were overridden. A later
green-light could still revisit any of these before/at implementation.

1. **CLI surface** — **auto-detect** a `.har` input (consistent with `.svgz`
   output detection). Considered + not chosen: a separate `--har <path>` flag
   paired with a URL (more explicit, supports "this URL replayed from this HAR"
   without inference) — can be added later if needed.
2. **URL inference** — **infer** the main page from the HAR (`log.pages[0]` /
   first HTML entry), with `--url` to override/disambiguate. Considered: always
   require `--url` (simpler, no heuristics, less ergonomic).
3. **Unmatched-request policy** — default **`notFound: "abort"`** (strict
   deterministic offline — every asset must be in the HAR), with a
   `--har-fallback` opt-in to the network.
4. **Scope** — **single-page `capture` only** for v1. Driving the `animate`
   config's per-frame `input` from a HAR is a follow-up.

## Out of scope (v1)

- Recording HARs from the CLI (`domotion record`?) — this ticket is about
  *consuming* an existing HAR. Recording is a possible follow-up.
- HARs that depend on live JS calling non-recorded XHR/fetch endpoints — those
  need `--har-fallback` (network) or will abort.
