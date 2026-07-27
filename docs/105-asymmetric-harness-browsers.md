# 105 — Asymmetric capture-vs-raster browsers in the visual harnesses

Status: **shipped** (DM-1790). An opt-in mode that lets `tests/runner.tsx` and `tests/html-test-suite.tsx` launch **two** Chromiums — one for the expected paint, one for rasterizing the candidate SVG — so a launch flag can be applied to a single side. Default behavior is unchanged: no flags set ⇒ one browser, exactly as before.

---

## The problem

Both harnesses drive **one** Chromium. The same page screenshots the fixture (the expected paint) and then loads the candidate Domotion SVG and screenshots that (the actual). So any `chromium.launch({ args })` flag intended to change *capture* also changes how the candidate SVG rasterizes — the two sides move together, and a whole class of capture-side experiments becomes unmeasurable.

The case that forced this ([docs/66](66-ci-visual-tests.md), DM-1789): `--font-render-hinting=none` on the capture browser is a legitimate experiment in **paths** mode, where the SVG is vector `<path>` geometry and hinting can't apply to it — only the expected paint moves. It is **invalid** in **embedded** mode, where the SVG carries a hinting-preserving subset font ([docs/99](99-hinted-embedded-subset.md)): the same flagged browser rasterizes that font unhinted too, both sides go soft and agree, and the sweep's `diff%` *drops*. That number is a mirage — a real consumer opens the shipped SVG in an unflagged, hinted browser, so the very mismatch the flag would introduce is the thing the suite cannot see.

## The surface

Two environment variables, each a whitespace-separated list of Chromium args:

| Variable | Applies to |
|---|---|
| `DOMOTION_CAPTURE_FLAGS` | the browser that renders the **fixture** — the expected paint |
| `DOMOTION_RASTER_FLAGS` | the browser that rasterizes the **candidate SVG** — the consumer's condition |

Three configurations matter:

| Set | Result |
|---|---|
| neither | **one** browser for both — the default fast path, unchanged, no extra process |
| capture only | **asymmetric**: flagged capture, unflagged raster. The consumer's condition, and the only honest way to measure a capture-only flag |
| both, identical | symmetric-but-flagged — the coupled behavior the harness has always had, now reachable deliberately rather than by accident |

```sh
# the consumer's condition — capture unhinted, rasterize as a consumer would
DOMOTION_CAPTURE_FLAGS="--font-render-hinting=none" npm run demos:test
DOMOTION_CAPTURE_FLAGS="--font-render-hinting=none" npm run demos:test:html

# the historical coupled behavior, stated out loud
DOMOTION_CAPTURE_FLAGS="--disable-lcd-text" DOMOTION_RASTER_FLAGS="--disable-lcd-text" npm run demos:test
```

Flag-list equality is **order-sensitive**: two lists differing only in order still split the browser. Splitting is the conservative answer, and a false split costs one process, not a wrong number.

## Two things it must not get wrong

**1. The default path stays the default path.** With neither variable set, `launchHarnessBrowsers()` returns the *same* `Browser` object under both names, no second context is created per worker, and the raster page IS the capture page — so the emitted sequence is what it always was. Every committed baseline was measured under that condition and none of them move.

**2. The expected-PNG cache must know about the flags.** `tests/html-test-suite.tsx` caches the expected screenshot keyed on (source HTML, viewport, Playwright version, capture-script hash, capture-node hash). A capture-side Chromium flag changes that screenshot and **nothing else in the key** — so without a fix, a flagged run silently reuses the unflagged cached PNG and reports numbers for a condition it never ran. That was observed during this ticket's own build: three conditions produced coverage identical to four decimal places. `captureFlagsCacheToken()` folds the capture flags into the key, and returns the empty string when there are none so every existing cache entry stays valid.

Only the *capture* flags belong in that key. The raster flags affect `actual.png`, which is never cached.

## Recording the condition

The failure mode this mode exists to prevent is a number measured under a flag nobody remembers setting, so a non-default run says so:

- both harnesses print the configuration line at start-up (`browsers: ASYMMETRIC — capture … · raster …`);
- `tests/runner.tsx` records it in its per-suite manifest (`tests/output/<suite>-results.json`, new `browsers` field);
- `tests/html-test-suite.tsx` writes a `run-conditions.json` sidecar next to `results.json` **only** when the run was non-default. (Its `results.json` is a bare array — the CI shard merger concatenates them — so the condition can't go inside it without changing that shape.)

## Validation

The mode was validated by running the same 11 `02-text` html-test fixtures under all three configurations and confirming the numbers actually diverge.

On **macOS** all three are identical, and that is the truth rather than a bug: a probe screenshotting one fixture under `(none)` / `--font-render-hinting=none` / `--disable-lcd-text` returns **byte-identical** PNGs — CoreText ignores the FreeType hinting flag, and Playwright's headless Chromium already paints without LCD subpixel text. A flag that changes nothing can't produce three different numbers.

On **Linux** (the pinned Playwright container, `npm run test:linux-docker`), where `--disable-lcd-text` does change the paint:

| Condition | mean coverage | max | passing |
|---|---|---|---|
| default (no flags) | 0.0157% | 0.0524% | 5 / 11 |
| symmetric (`--disable-lcd-text` on both) | 0.0183% | 0.0590% | 3 / 11 |
| **asymmetric** (capture flagged, raster not) | 0.0164% | 0.0670% | **8 / 11** |

Three genuinely different results, and — the point of the whole exercise — the asymmetric number is **not** between the other two. Coupling the sides doesn't produce a conservative estimate of the consumer's condition; it produces a number that isn't about the consumer's condition at all.

> **Observation, not a recommendation.** On that fixture subset, capturing with `--disable-lcd-text` while the consumer rasterizes with LCD text on scored *better* than the fully-default run. One flag, 11 fixtures, one platform — far too narrow to act on. Also noted: `--font-render-hinting=none` produced a byte-identical screenshot in this container for this fixture, so DM-1789's paths-mode result came from the feature suite's fonts, not these.

## Where it lives

| Concern | Code |
|---|---|
| Flag parsing, the launch decision, the cache token, the log line | `tests/harness-browsers.ts` |
| Feature-suite plumbing (`rasterPage`, manifest field) | `tests/runner.tsx` |
| html-test plumbing (`rasterPage`, cache key, sidecar) | `tests/html-test-suite.tsx` |
| Unit tests for the pure decision logic | `tests/harness-browsers.test.ts` |

## Not covered

- **No CLI flag.** Env vars only — these harnesses already take their knobs (`HTML_TEST_SHARD`, `HTML_TEST_OUTPUT_DIR`, `DOMOTION_TEST_WORKERS`, `DEMO_TIMING`) that way, and the mode is for one-off experiments rather than routine runs.
- **Nothing runs in this mode by default, on CI or locally.** It is an instrument, not a gate; the committed baselines all describe the default single-browser condition.
- **`tests/real-world.tsx` and the animate-example harness are untouched.** They compare differently (HAR replay, committed golden SVGs) and had no capture-vs-raster coupling to break.
- **The expected-PNG cache is still not platform-keyed.** Pre-existing: running the html-test suite in the Linux container writes Linux-captured PNGs into the same cache the host reads. Redirect with `HTML_TEST_OUTPUT_DIR` when doing that (as this ticket's Linux validation did) — filed separately.
