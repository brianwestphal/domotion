# 37. Scroll-pattern grammar

The scroll-pattern language drives Domotion's scroll-animated SVG output. A pattern is one or more scroll segments executed in order; comma-separated for sequencing, parenthesized for nesting + per-group `until` conditions. There is **no global axis parameter** — direction is determined per action (via explicit prefix or anchor type).

> **Maintenance.** This doc is the canonical reference for the scroll-pattern grammar. If you change `src/scroll/pattern.ts` (tokenizer, parser, AST shape), `src/scroll/executor.ts` (action resolution, speed semantics, `until` evaluation), or any user-visible flag in `src/cli/capture.ts` / `src/cli/animate.ts` that affects scroll dispatch, update this doc in the same commit. `pattern.ts` and `executor.ts` carry a header pointer back to this file; keep it accurate.

## EBNF

```ebnf
pattern             = top-segment , { "," , top-segment } ;

top-segment         = bracketed-segment
                    | flat-segment ;

bracketed-segment   = "(" , pattern , ")" , [ until-clause ] ;

flat-segment        = action , { "," , action } , [ until-clause ] ;
                      (* the `until` clause, if present, terminates the
                         segment; a subsequent top-level comma starts a
                         new top-segment. Multi-group patterns without
                         `until` between groups MUST use parens to
                         disambiguate. *)

(* ── actions ─────────────────────────────────────── *)

action              = scroll-action | pause-action ;

scroll-action       = [ direction-prefix ] , scroll-target ,
                      [ duration-suffix | speed-suffix ] ,
                      [ easing-suffix ] ;
                      (* duration-suffix and speed-suffix are mutually
                         exclusive on a single action — pin the time OR
                         pin the speed, not both. *)

pause-action        = [ "pause:" ] , duration ;

direction-prefix    = ( "up" | "down" | "left" | "right" ) , ":" ;

scroll-target       = delta-target
                    | absolute-target ;

delta-target        = signed-length ;
                      (* "720px" → +720px, "-100px" → -100px;
                         direction = direction-prefix if present,
                         else `down:` (vertical positive) *)

absolute-target     = anchored-expr ;

anchored-expr       = anchor-or-selector , [ axis-suffix ] ,
                      { ( "+" | "-" ) , length } ;
                      (* e.g. "top + 200px",
                              "selector(\".cta\") - 50px",
                              "start.x + 1400px" *)

anchor-or-selector  = anchor | selector-ref ;

anchor              = "top"   | "bottom"             (* y-axis anchors *)
                    | "left"  | "right"              (* x-axis anchors *)
                    | "start" | "end" ;              (* y by default; .x to switch *)

selector-ref        = "selector(\"" , css-selector , "\")" ;

axis-suffix         = "." , ( "x" | "y" ) ;
                      (* `.y` is the default for any anchor when omitted.
                         `.x` switches the anchor to its x-coordinate. *)

duration-suffix     = "/" , duration ;
speed-suffix        = "@" , speed ;
                      (* per-action constant scroll speed in px/s; overrides
                         the inherited `defaultSpeed` for THIS action only.
                         Mutually exclusive with `duration-suffix`. *)
easing-suffix       = "[" , easing-name , "]" ;
easing-name         = "linear" | "ease" | "ease-in" | "ease-out"
                    | "ease-in-out" | "step-start" | "step-end"
                    | cubic-bezier | steps ;
cubic-bezier        = "cubic-bezier(" , signed-number , "," , signed-number ,
                      "," , signed-number , "," , signed-number , ")" ;
                      (* the y control-point values may be negative — an
                         overshoot/anticipation curve like
                         cubic-bezier(0.5, -0.5, 0.5, 1.5) is valid, matching
                         CSS. The parser accepts a leading sign on every
                         argument. *)
steps               = "steps(" , integer , [ "," , step-position ] , ")" ;
                      (* `integer` is unsigned: the count must be a positive
                         integer (a leading "-" is consumed but then rejected). *)
step-position       = "jump-start" | "jump-end" | "jump-none"
                    | "jump-both" | "start" | "end" ;

(* ── until clause ────────────────────────────────── *)

until-clause        = "until" , until-condition ;

until-condition     = anchored-expr
                    | count-condition ;

count-condition     = number , "times" ;

(* ── primitives ──────────────────────────────────── *)

signed-length       = [ "-" ] , length ;
length              = number , ( "px" | "%" ) ;
duration            = number , ( "s" | "ms" ) ;
speed               = number , "pxps" ;
                      (* px-per-second; positive non-zero. e.g. `800pxps`,
                         `1500.5pxps`. Only valid as the speed-suffix
                         argument (after the `@` marker). *)

number              = digit , { digit } , [ "." , digit , { digit } ] ;
signed-number       = [ "+" | "-" ] , number ;
                      (* only the `cubic-bezier(...)` arguments are signed;
                         lengths carry their sign via `signed-length`. *)
digit               = "0" | "1" | "2" | "3" | "4" | "5" | "6"
                    | "7" | "8" | "9" ;

css-selector        = ? any chars forming a valid CSS selector,
                        excluding the literal `")` terminator ? ;
```

## Direction & axis semantics

There is no global axis parameter. Each action resolves its own axis at execute time:

1. Explicit prefix wins: `up:` / `down:` / `left:` / `right:`.
2. Otherwise, the anchor type in an absolute target:
   - `top` / `bottom` → vertical
   - `left` / `right` → horizontal
   - `start` / `end` → vertical by default; use `.x` for horizontal
   - `selector(...)` → vertical by default; use `.x` for horizontal
3. Otherwise (bare delta with no prefix and no anchor):
   - Defaults to `down:` (vertical, positive = down).

`down:-100px` ≡ `up:100px`. A signed delta magnitude **composes with the direction prefix by sign-multiplication** — it does *not* take the magnitude as `abs` with the prefix unconditionally winning. The resolved delta is `prefixSign × signedMagnitude`, where the prefix sign is `+1` for `down` / `right`, `-1` for `up` / `left`, and `+1` (default `down`) when no prefix is present (`resolveScrollAction` in `src/scroll/executor.ts`). So a negative magnitude **reverses** the prefix's direction: `down:-100px` resolves to a delta of `+1 × (−100) = −100` and `up:100px` to `−1 × 100 = −100` — both scroll up 100, which is why they're equivalent.

Cross-axis conflicts (e.g. `down:left + 200px` — vertical direction with horizontal anchor) are validator errors at parse-after-resolve time, not grammar errors.

`until` conditions evaluate against the axis their condition expression references; count conditions (`until N times`) are axis-agnostic.

## Other semantics

- **Pauses.** A bare `<duration>` token (e.g. `2s`) is a pause. `pause:` is an optional decorative prefix — fine to use anywhere a pause appears, including mid-pattern, for stylistic alignment with `up:` / `down:`.

- **Scroll speed (duration vs constant-speed).** Each scroll action has a duration. Resolution priority (first match wins):
  1. **`/<duration>` on the action** — the user pinned a wall-clock time. Speed becomes magnitude / duration.
  2. **`@<n>pxps` on the action** — the user pinned a constant speed for THIS action only. Duration becomes magnitude / speed. Mutually exclusive with `/<duration>` on the same action.
  3. **Inherited `defaultSpeed`** — pattern-wide fallback. Duration becomes magnitude / defaultSpeed.

  The `defaultSpeed` parameter:
  - **Default value**: `1500 px/s` (`DEFAULT_SPEED_PX_PER_SEC` in `src/scroll/executor.ts`).
  - **Programmatic override**: `executeScrollPattern(..., { defaultSpeed: <px/s> })`.
  - **CLI override**: `--scroll-speed <px/s>` on `domotion capture` (see `src/cli/capture.ts`).
  - **Config override**: `scroll.speed: <px/s>` in `domotion animate` frame config (see `src/cli/animate.ts`).

  Per-action `@<speed>` is preferred for mixed-speed patterns (e.g. a slow hero pan followed by a fast scroll-through-feed). Per-action `/<duration>` is preferred when the scroll has to land on a specific beat (synchronized with audio, transitions, etc.). `defaultSpeed` is the right default when you want every untagged action to share one constant speed — exactly the shape used by the scroll demos.

- **Easing**: the `[easing-name]` suffix **is applied** to the rendered animation (DM-1076). Each action's easing becomes a per-keyframe `animation-timing-function` on the stop where that action's motion begins, since CSS applies a keyframe's timing-function to the interval that *starts* at it (`src/scroll/composer.ts`, `cssTimingFunction`). Named functions (`ease` / `ease-in` / `ease-out` / `ease-in-out` / `step-start` / `step-end`), `cubic-bezier(...)`, and `steps(n[, <position>])` (the CSS Easing L1 step family — positions `jump-start` / `jump-end` / `jump-none` / `jump-both` / `start` / `end`; `steps()` count must be a positive integer, and `jump-none` requires a count ≥ 2) are emitted verbatim as the keyframe `animation-timing-function`. A stepped easing makes the scroll jump in discrete increments rather than glide — unusual for a scroll, but supported for completeness. **The composite default is `linear`** — an action without an `[easing]` suffix (and the `linear` token itself) emits no per-keyframe function and inherits the animation-level `linear`, so existing patterns are unchanged. Two caveats: (1) a single long smooth-mode scroll is subdivided into viewport-height chunks (see *Auto-chunking* below), and the easing is applied **per chunk** rather than across the whole action — so `down:bottom/30s[ease-in-out]` eases each viewport-step, not the full travel; explicit per-token patterns with magnitudes ≤ one viewport are one chunk each and ease exactly. (2) `linear` is the settled no-suffix default. An opinionated non-linear default (e.g. `ease-out`) was considered and deliberately rejected, since applying it would change the feel of every existing scroll; explicit `[easing]` tokens remain the only way to alter an action's curve.

- **`until <position>`** repeats the group's body until the current scroll position satisfies the condition. Each scroll destination is **clamped to the page bounds** (`[0, maxScroll]`), so the travel never runs off the document. The **final iteration is clamped to the target**: when a step would carry the position past the `until` target, its destination is capped at the target so cumulative travel lands *exactly* on it rather than up to one action-magnitude past — e.g. `down:700px until bottom - 1000px` on a 4000 px page stops precisely at `y = 3000`, not `3500` (`src/scroll/executor.ts`, `clampScrollToTarget`). The clamp only applies when the motion heads toward the target; a body scrolling away leaves the position untouched and the no-progress guard ends the loop.

- **`until <N> times`** repeats the group's body exactly N times.

- An overall pattern-execution timeout (config-level, not grammar) guards against impossible conditions like `until selector(".never-appears")`. Default: 60 s; override via `ScrollExecutorOptions.maxTimeoutMs`.

- Comma between top-level groups means **sequential execution with no implicit pause**; insert `pause:` / `<duration>` if you want one.

- **Auto-chunking** (executor implementation detail, not grammar). A long single scroll (multiple viewport-heights covered by one `down:bottom/30s` action) is subdivided internally into viewport-height steps so the composer has enough anchor points to stack contiguous captures. The pattern grammar surface is unaffected — this is purely how the executor schedules the captures.

## Worked examples

### Basic

```
720px                       Scroll down 720px once (default speed).
720px,2s                    Scroll 720px then wait 2s (runs once).
720px/3s                    Scroll 720px over exactly 3s.
720px/3s[ease-in]           Scroll 720px over 3s with ease-in.
720px@800pxps               Scroll 720px at 800 px/s (= 0.9 s).
down:bottom@1200pxps        Scroll to the bottom at a constant 1200 px/s
                            (duration depends on the page height).
```

### Until conditions

```
720px,2s until bottom       Repeat (scroll 720, wait 2s) until bottom.
720px,2s until 5 times      Repeat (scroll, wait) exactly 5 times.
720px until selector(".footer")
                            Repeat until .footer's top hits viewport top.
```

### Direction prefixes

```
down:720px                  Scroll down 720px (delta).
up:300px                    Scroll up 300px (delta).
down:bottom                 Scroll down to absolute position `bottom`
                            (redundant but accepted).
up:top + 200px              Scroll up to absolute position `top + 200px`.
```

### Multi-group with parens

```
(720px,2s until bottom - 1000px), (200px,3s until bottom)
                            Quick scroll until 1000px from bottom, then
                            slow down for the last 1000px.

(720px,2s until 3 times), (300px,1s until bottom)
                            Three quick scrolls, then steady to bottom.

down:bottom - 800px@1500pxps, down:bottom@400pxps
                            Fast scroll (1500 px/s) until the last
                            viewport-height, then slow ramp (400 px/s)
                            into the page footer — same shape using
                            `@speed` instead of `/duration`, so the
                            wall-clock time scales with page length.
```

### Negative / reverse direction

```
720px,2s,-720px,2s          Down 720, wait, up 720, wait.
down:720px,2s,up:720px,2s   Same thing, explicit prefixes.
```

### Horizontal

```
right:400px,pause:1s,right:400px,pause:1s until right
                            Horizontal pan, 400 at a time, with pauses,
                            until reaching the right edge.

right:selector(".panel").x + 200px
                            Scroll right until 200px past .panel's right
                            edge (selector at its x-coordinate + 200).
```

### Mixed-axis

```
down:300px,right:400px      Scroll down 300, then right 400. Two
                            actions, two different axes.
```

### Decorative pause prefix

```
720px,pause:2s,720px        Same as `720px,2s,720px`; reads more clearly.
```

### The canonical example

```
down:720px/3s,pause:2s,up:top + 200px/2s,pause:4s
                            Scroll down 720 over 3s, wait 2s,
                            scroll up to (top + 200) over 2s, wait 4s.
```

## Notes on selector arithmetic

- `selector("...")` requires its CSS-selector argument to be quoted so the inner string can include commas (e.g. `selector(".a, .b")`).
- `until <position>` resolves relative to the **current scroll position at the start of each iteration**, so loops converge for monotonic conditions (`bottom`, `bottom - N`, `selector(...)`).
- For nested scrollable elements (a config-level concern, not pattern grammar): the same pattern grammar runs against each element's own `scrollTop` / `scrollLeft` rather than the window. The selector + pattern pair lives in the outer config.
- CSS-selector arithmetic resolves at scroll-start time and is **re-resolved per iteration** in `until` clauses, so a sticky-nav appearing mid-scroll doesn't break `until selector(...)`.
