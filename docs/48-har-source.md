---
id: "requirements/har-source"
title: "Domotion: HAR files as a capture source"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: []
tickets: ["DM-883", "DM-889", "DM-Z0VPN1", "DM-9K75QG"]
code: ["src/cli/capture.ts", "src/cli/common.ts", "src/capture/har-fetcher.ts", "tests/real-world.tsx"]
aliases: ["docs/48-har-source.md", "doc-48"]
---

# Domotion: HAR files as a capture source

Requirements for accepting an HTTP-Archive (`.har`) file as a `domotion capture`
input, alongside the existing URL / local-HTML / stdin sources. Origin: DM-883.

> **Status: implemented (DM-889).** `domotion capture page.har` replays a HAR
> offline. Every adopted default below shipped as written: auto-detect by `.har`
> extension, infer the main-document URL (override with `--url`), default to
> strict `notFound: "abort"` (opt into the live network with `--har-fallback`),
> single-page `capture` only. The one refinement made during implementation:
> URL inference uses `log.pages[0].title` when it's a URL, else the first 2xx
> `text/html` entry, else the first entry — Playwright-recorded HARs leave
> `log.pages` empty, so the simpler entry scan is the reliable path.

## JSON format and ZIP archives

The supported input is JSON `.har`, either with embedded response bodies or
ordinary `_file` sidecars alongside it. Keep sidecars with their archive;
replay and Node-side font discovery read the same recorded bytes. Existing JSON
caches are read without rewriting them.

ZIP bytes are rejected before browser bring-up, including ZIP data renamed to
`.har`. A `.har.zip` input receives the same explicit diagnostic. Renaming a ZIP
or a recorder's `.har.tmp` file does not finalize or convert it.

For an existing ZIP, preserve the original and extract into a separate directory
with a ZIP implementation independent of Playwright's reader. For example, with
Python installed:

```sh
python3 -m zipfile -e capture.har.zip extracted-har
# On Windows with the Python launcher: py -m zipfile -e capture.har.zip extracted-har
domotion capture extracted-har/har.har --url https://example.com/ -o capture.svg
```

Playwright normally stores its JSON member as `har.har`; use the actual `.har`
member if yours differs. Keep every extracted response sidecar in that directory.
A completed ZIP must be distinguished from an unfinished recording: extraction
cannot establish that the recording context finalized successfully.

On 2026-11-09, installed Playwright 1.59.1's `ZipFile.read` stalled on retained
Resend/Stripe compressed bodies under macOS arm64 Node 26.13.0; the same reader
and archives completed under Node 22.15.0. A synthetic deflated ZIP containing
16,384 then 65,536 pseudorandom bytes passed the first read and stalled on the
second under Node 26, while Node 22 read all four members (through 524,288 bytes).
This identifies the affected installed-reader/runtime combination, not a proven
Node or zlib root cause. Direct ZIP replay through public Playwright remains
outside Domotion's JSON input contract; extraction, or a verified Node 22
Playwright process used to finalize an attached recording, avoids that path.

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
   document's URL to `goto`. Resolve in order (`inferHarPageUrl`,
   `src/cli/common.ts`):
   - explicit `--url <url>` flag (required for multi-page HARs / disambiguation);
   - else `log.pages[0].title` when it's an `http(s)` URL (some recorders set it);
   - else the first 2xx `text/html` entry's `request.url`;
   - else the first entry's `request.url`.
     Error clearly if none can be found (tell the user to pass `--url`).
3. **Replay.** On the context:
   `routeFromHAR(harPath, { url: "**/*", notFound: "abort" })` — strict offline
   replay so the capture is fully deterministic (every asset must be in the
   HAR). A `--har-fallback` flag flips `notFound` to `"fallback"` to let missing
   assets hit the live network (hybrid mode).
4. **Webfont discovery reads the same archive.** `discoverAndRegisterWebfonts`
   fetches font bytes and cross-origin stylesheet text Node-side, and its
   default getter (Playwright's `APIRequestContext`) is not intercepted by
   `routeFromHAR`: routes apply only to requests the page makes. Without help,
   a strict replay would download every font from the live network (failing
   once a deployment URL is gone, or returning bytes Chrome never painted). The
   capture path therefore passes `createHarHttpGetter`
   (`src/capture/har-fetcher.ts`), which serves those fetches from the archive
   with Playwright's own HAR lookup (`HarBackend._harFindResponse` /
   `_loadContent` in `playwright-core`): exact URL + method (fragment
   removed), first candidate on a tie, recorded 3xx `Location` redirects
   followed, bodies from the `_file` sidecar beside the `.har` or from
   `content.text` (base64 when `encoding: "base64"`). An unmatched URL fails
   the candidate under the default `notFound: "abort"` and goes to the network
   under `--har-fallback`. `tests/real-world.tsx` uses the same getter (with
   fallback) whenever it replays an existing HAR.
5. **Everything downstream is unchanged** — `--selector`, `--width/--height`,
   `--scroll`, `--wait*`, color-scheme, optimize, etc. operate on the replayed
   page exactly as they do for a live URL.

### CLI shape (recommended)

```bash
domotion capture page.har -o out.svg                 # infer the main page URL
domotion capture page.har --url https://x.com/ -o …  # disambiguate multi-page HAR
domotion capture page.har --har-fallback -o …        # let missing assets hit network
```

## Decisions (as implemented)

No driving use case surfaced (DM-883), so the recommended default for each was
adopted as the implementation (DM-889); none were overridden.

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
  _consuming_ an existing HAR. Recording is a possible follow-up.
- HARs that depend on live JS calling non-recorded XHR/fetch endpoints — those
  need `--har-fallback` (network) or will abort.
