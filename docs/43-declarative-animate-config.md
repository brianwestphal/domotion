# 43 — Declarative `animate` config

Status: **shipped**. This doc is the contract for the `domotion animate` JSON config; all eight sections below are implemented in `src/cli/animate.ts` (continuous-session `continue`, the DOM-mutation + interaction actions, the richer readiness waits, selector-anchored overlays, the config-level `cursor` incl. `"auto"`, `${}` variable interpolation, and the `evaluate` escape hatch — DM-846 through DM-853, with the auto-cursor timing refined in DM-1050). Each section reads as the spec; the per-section ticket tracked its build.

## Why

The `animate` config (see `docs/08-animation-model.md` for today's surface) can already capture multi-frame scenes with transitions, overlays, and intra-frame animations. But for **interaction demos** — drive a real app, click/type/save, capture the resulting UI — authors hit walls that today force either the programmatic API (`generateAnimatedSvg`) or the raw `evaluate` escape hatch:

1. Every frame re-loads its `input`, so client-side state resets between frames — you can't capture a multi-step flow.
2. Anything beyond click/fill/press/scroll/hover/wait (a DOM edit, a fired event, a non-window scroll) needs JS.
3. `waitFor` only waits for a selector to *exist* — not for text, removal, or counts.
4. Overlays take hardcoded `x`/`y` that break on any layout shift.
5. The on-screen cursor (`cursorOverlay`) exists in the API but isn't reachable from a config.
6. Repeated values (ports, paths, selectors) must be duplicated across frames.

**Goal:** the declarative surface covers 80–90% of interaction demos; a tightly-scoped `evaluate` covers the rest *without* forcing a jump to code. Driving the real review-loop demo (open diff → annotate → resolve → loop) should be expressible in JSON alone.

## Shared model & conventions

These cut across every feature below; they're specified once here.

### Frame lifecycle

A frame's steps run in this fixed order:

1. **Load** (`input`) or **continue** the live page from the previous frame (see §1).
2. **Readiness waits** — `wait`, `waitFor`, and the richer waits in §4.
3. **`scrollTo`** (static pre-scroll), then **`actions`** in array order.
4. **Capture** the DOM → frame `svgContent`.
5. **Overlays** + **intra-frame animations** are layered onto the captured frame.

### Selectors

Every `selector` is a CSS selector resolved **in page context at capture time** (the same world `page.evaluate` sees), against the live DOM — *not* against the SVG output. Unless a feature says otherwise, a selector that matches nothing is a **hard error** naming the selector and the frame index (fail fast — a silently-skipped step usually means the demo is subtly wrong). Multi-match: actions act on the first match; waits/anchors document their own rule per section.

### Validation & errors

The config is validated up front by the zod schema in `src/cli/animate.ts` (`animateConfigSchema`) — the schema is the source of truth (see `docs/08-animation-model.md` → "Config validation"). Every new field/action/overlay below extends that schema. Errors are path-specific, e.g. `animate: frames[2].actions[0].selector: Invalid input: expected string, received number`. Runtime failures (selector not found, wait timeout) throw `animate: frames[N]…: <what failed>`.

A standard **JSON Schema** projection of that zod schema ships with the package — see "Published JSON Schema" below — so editors can offer autocompletion and structural validation without running Domotion.

### String interpolation

All **string** fields in a config (`input`, every `selector`, action `value`/`html`/`text`, overlay text, etc.) are subject to `${name}` interpolation against the top-level `vars` map — see §7. Interpolation happens after parse, before each frame runs.

### Non-goals / guardrails

- This is **not** a general scripting language. The declarative actions are the supported surface; `evaluate` (§8) is the explicit last resort for the long tail and is deliberately kept small.
- No control flow (no loops/conditionals) in the config. Repetition is expressed as repeated frames/actions; parameterization is `vars`.
- Actions run in Chromium, sandboxed to the page via `page.evaluate` / Playwright primitives. No filesystem/network access from config-authored script beyond what the page itself can do.

---

## 1. Continuous-session frames — optional `input` / `continue` (keystone)

**Problem.** Today every frame re-loads `input` from scratch, so client-side state (open modals, typed text, route changes) resets between frames. A multi-step interaction can't be captured: each frame would have to replay every prior action from a fresh load, and client-only transient states can't be reconstructed at all.

**Surface.** Make `input` optional. The first frame must load a **content source** — an `input`, a `cast` (terminal recording), or a `template`. A later frame that omits all of these (or sets `"continue": true`) keeps the **current live page** and captures it after running its own `actions`.

```jsonc
{ "input": "http://localhost:4188", "waitFor": ".diff-view", "actions": [ /* … */ ] },
{ "continue": true, "actions": [{ "type": "click", "selector": ".diff-line[data-line='23']" }] },
{ "continue": true, "actions": [{ "type": "fill",  "selector": ".annotation-form textarea", "value": "…" }] }
```

**Semantics.**
- The browser **context/page persists** across continued frames (one page, advanced step by step) instead of a fresh context per frame.
- Frame 0 must load a content source — `input`, `cast`, or `template` (error otherwise). A continued frame must have a predecessor (error if frame 0 sets `continue`).
- `continue: true` and an explicit `input` on the same frame is an error (ambiguous: reload or continue?).
- A continued frame may still set `selector`, `wait`/`waitFor`, `scrollTo`, `actions`, `overlays`, `animations`. Its `actions` mutate the persisted page; capture happens after.
- `mobile` / `colorScheme` / viewport are context-level and fixed for the whole run (they can't change mid-session).

**Replaces.** The "replay all prior actions every frame" workaround, and the inability to capture client-only states — both otherwise force the programmatic API.

**Rendering note.** Continued frames are structurally near-identical (the same DOM, evolved). The old element-merge fast path mishandled that (overlapping text, dropped elements), so it was removed — every sequence now composites each frame as a complete sub-SVG, which renders continued frames correctly under either `cut` or `crossfade`. `cut` ("the page just updated") is the natural transition between interaction steps.

**Open questions.** (a) Spelling: support both `continue: true` *and* "omit `input`", or pick one? (Recommend: omitting `input` implies continue; `continue: true` is the explicit, self-documenting form — accept both, they mean the same.) (b) Do we ever want an explicit `reload` step within a session? (Defer.)

---

## 2. Declarative DOM-mutation actions

**Problem.** Any DOM edit — depict an applied fix, resolve/remove an element, redact a path, swap a label — forces the raw `evaluate` escape hatch today.

**Surface.** New `actions[]` entries (all selector-based, all run in page context):

```jsonc
{ "type": "setText",        "selector": "…", "value": "…" }
{ "type": "setHtml",        "selector": "…", "value": "…" }
{ "type": "remove",         "selector": "…" }
{ "type": "setAttribute",   "selector": "…", "name": "…", "value": "…" }
{ "type": "removeAttribute","selector": "…", "name": "…" }
{ "type": "addClass",       "selector": "…", "class": "…" }
{ "type": "removeClass",    "selector": "…", "class": "…" }
{ "type": "toggleClass",    "selector": "…", "class": "…" }
{ "type": "setStyle",       "selector": "…", "props": { "display": "none" } }
{ "type": "insert",         "selector": "…", "position": "beforeend|afterend|beforebegin|afterbegin", "html": "…" }
{ "type": "setValue",       "selector": "…", "value": "…" }     // form controls
{ "type": "check",          "selector": "…", "checked": true }
{ "type": "selectOption",   "selector": "…", "value": "…" }
{ "type": "replaceText",    "selector": "…", "pattern": "^/Users/[^/]+/", "replacement": "~/", "flags": "g" }
```

**Semantics.**
- Each acts on **all** matched elements (mutations are naturally batchy), except the form-control ones (`setValue`/`check`/`selectOption`) which act on the first match.
- `setText` sets `textContent`; `setHtml`/`insert` set/insert markup (author-trusted — same trust level as the rest of the config).
- `replaceText` runs a regex over each matched element's text nodes; `pattern`/`flags` compile to `new RegExp(pattern, flags)` and a bad pattern is a config-parse error.
- `setValue`/`check`/`selectOption` set the control's value/state; they do **not** fire `input`/`change` automatically — pair with §3 `dispatch` when framework reactivity must see the change.

**Replaces.** Every DOM edit the review-loop demo needs (rewrite a code line to show the fix, remove resolved annotations, swap a button's id/label, mask an absolute path) — all otherwise `evaluate`.

**Programmatic use (DM-1140, doc 63 §2).** This exact action vocabulary is exposed from the package root as `runActions(page, actions, log?)` and the typed `AnimateAction` union, so imperative scripting-API callers (`captureElementTree` + `generateAnimatedSvg`) can apply the same DOM-mutation set against a live page without authoring a JSON config — the runner is the SSOT the CLI uses, so the two can't diverge. `log` defaults to a no-op; the same all-matched-elements / throw-on-no-match semantics apply.

---

## 3. Interaction actions beyond click/fill

**Problem.** Bringing a specific element into view, or firing a specific event for framework reactivity, is window-coordinate-only or impossible without `evaluate` today.

**Surface.**

```jsonc
{ "type": "scrollIntoView", "selector": "…", "block": "center|start|end|nearest", "inline": "…" }
{ "type": "dispatch",       "selector": "…", "event": "input|change|mouseover|…", "bubbles": true }
{ "type": "focus",          "selector": "…" }
{ "type": "blur",           "selector": "…" }
{ "type": "selectText",     "selector": "…" }   // select the element's text (for a selection-highlight capture)
{ "type": "clear",          "selector": "…" }   // clear an input/textarea value
```

**Semantics.**
- `scrollIntoView` calls `element.scrollIntoView({ block, inline })` on the first match — distinct from the existing window-coordinate `scroll` action. This is the high-value one: it brings a target diff line into view before clicking/capturing.
- `dispatch` constructs and dispatches the named event (`bubbles` default true) on the first match; the second high-value one, for reactivity that listens for `input`/`change`/`mouseover`/custom events that click/fill don't naturally trigger.
- `focus`/`blur`/`selectText`/`clear` are thin wrappers over the obvious DOM calls.

**Replaces.** `scrollIntoView` and `dispatch` are otherwise pure-`evaluate`.

---

## 4. Richer readiness waits

**Problem.** `waitFor` only waits for a selector to *exist*. Real apps need "wait until X is true" without JS polling.

**Surface.** New frame-level wait fields (each polls in page context until satisfied or a timeout — default the page's 90 s — then errors):

```jsonc
{ "waitForText":  { "selector": ".annotation-count", "equals": "1" } }   // or "contains": "…"
{ "waitForGone":  ".loading-spinner" }                                    // removed or not visible
{ "waitForCount": { "selector": ".ai-note-guided", "atLeast": 1 } }       // or "equals" / "atMost"
```

**Semantics.**
- These run in the readiness phase (step 2 of the frame lifecycle), after `input`/`continue` and before `actions`. Multiple may be combined on one frame; all must be satisfied.
- `waitForGone` is satisfied when the selector matches no element, or all matches are not visible (`display:none`/`visibility:hidden`/zero-area).
- Timeout errors name the unmet condition and frame index.

**Replaces.** Async-loaded-content readiness checks that otherwise need `evaluate` polling.

---

## 5. Selector-anchored overlays

**Problem.** `typing`/`tap`/`svg` overlays take hardcoded `x`/`y`, which break on any layout shift and force hand-measuring pixels.

**Surface.** An overlay may give an `anchor` instead of (or in addition to) `x`/`y`. Since the page is captured, domotion resolves the selector's bounding box at capture time:

```jsonc
{ "kind": "typing", "text": "Sanitize the session id before building the Redis key.",
  "anchor": { "selector": ".annotation-form textarea", "at": "top-left", "dx": 8, "dy": 8 },
  "maxWidth": "anchor" }
```

**Semantics.**
- `anchor.at` ∈ `top-left | top | top-right | left | center | right | bottom-left | bottom | bottom-right`; `dx`/`dy` offset (px) from that point. Resolved against the **first** match's bounding box.
- The resolved point replaces `x`/`y` for that overlay; explicit `x`/`y` remain valid for un-anchored overlays.
- **`anchor.baseline: true` (typing overlays only, DM-1750)** resolves the overlay's `y` to the anchored element's **first-line text baseline** instead of a border-box point. A typing overlay's `y` IS its typed text's baseline, so with this the overlay glyphs land exactly on the element's own text — no hand-tuned ascent `dy` (the old workaround: `dy ≈ 11.5` for Menlo 12.5px). `x` still comes from `at`'s horizontal component (+ `dx`); `dy` remains an additional nudge from the measured baseline (default 0). The baseline is measured in page context from the element's computed font (canvas font metrics + the same line-box placement the `typeResample` caret uses: a single-line `<input>` centers its line box in the content box, `<textarea>`/block content lays lines from the top; a 1.15-em ascent/descent split stands in when the canvas metrics are unavailable). Composes with `fontFamily: "anchor"`. Setting `baseline` on any other overlay kind is a validation error (their `y` is a box corner, not a baseline).
- **On `cast` / `template` frames there is no captured DOM** (the content is an embedded, pre-rendered animated SVG), so a selector `anchor` — and `maxWidth: "anchor"` — cannot resolve. Such an anchor is **ignored with a clear warning** (DM-1320) and the overlay falls back to its explicit `x`/`y` (default `0,0`); position overlays on these frames with `x`/`y`. Explicit-coordinate overlays still render normally on top of the embedded animation.
- `maxWidth: "anchor"` wraps `typing` text to the anchored element's **content width** (it resolves into the typing overlay's `wrapWidth` — the textarea-style wrap, DM-1134; `maxWidth` may also take a number in px). With `maxWidth` set, the author never measures the field or pre-splits the string into lines.

> **Typing-overlay wrap vs mask (DM-1134).** A `typing` overlay's wrapping and its placeholder cover are separate knobs: `wrapWidth` (px) controls where the text line-breaks, and `mask: { width, height, color }` controls the cover painted behind it (mask `width` defaults to `wrapWidth`, `height` grows to fit the wrapped lines, and the mask only paints when a `color` is set). The older `bgWidth` / `bgHeight` / `bgColor` fields still work as **deprecated aliases** — `bgWidth` feeds both `wrapWidth` and `mask.width`, `bgHeight` → `mask.height`, `bgColor` → `mask.color` — so existing configs are unchanged; prefer the new fields in new configs.

> **Realistic typing — `mode` / `jitter` (DM-1518).** A `typing` overlay reveals its text **character-by-character** with the caret glued to the true trailing edge of the visible text (advances are measured via fontkit, so the caret sits exactly at the glyph edge instead of drifting behind it). Two extra knobs shape the feel: `"mode": "type" | "paste"` — `type` (default) steps one glyph per keystroke, `paste` drops the whole string in at once (a clipboard paste) with the caret jumping to the end; and `"jitter": 0–1` — humanizes the per-keystroke cadence by `speed × (1 ± jitter)` from a deterministic seeded PRNG, so the output SVG stays byte-stable while the typing loses its robotic fixed interval. `speed` (ms/char) and `caret` are unchanged. See `docs/93-realistic-typing.md` for the full model, the tunable parameters, and the roadmap (per-keystroke re-sampling, paste-with-selection).
>
> **Hold-to-frame-end (DM-1749).** By default a `typing` overlay fades out starting 150 ms before its frame ends (text, mask, and parked caret). `"holdToFrameEnd": true` opts out: the overlay holds at **full opacity** through the frame's end and drops with a hard `step-end` cut exactly at the frame boundary. Use it when the next frame carries the identical text as real page content at the same geometry — the cut then hands off seamlessly, with no page-side cover-rect/reveal choreography. Typing still compresses into the frame when the natural typing time overruns it, minus the 150 ms fade reserve (which this mode reclaims). Default `false` keeps the fade, byte-identical to before.
>
> **Typos, glyph-path text & font override (DM-1555 / DM-1557 / DM-1558).** Three further knobs: `"mistakes"` — a probability `0–1` or an explicit `[{ at, wrong? }]` list — makes the typist occasionally type a wrong glyph, pause (`mistakeThinkMs`, default 400), backspace, and retype the correct one; positions and wrong glyphs are deterministic (seeded off the text) so the SVG stays byte-stable. The reveal now paints its text as **glyph paths** (not a native `<text>`), so advances match on every viewer and PROPORTIONAL fonts wrap by measured pixel width. `"fontFamily"` points the reveal at any CSS family (default the monospace field stack) — e.g. the captured field's own font — for both measurement and paint.
- Anchor selector not found → hard error (consistent with §Shared/Selectors).

**Replaces.** The manual pixel-measuring + line-splitting authors do today for field-aligned annotations.

---

## 6. Cursor overlay in the config

**Problem.** `generateAnimatedSvg` supports `cursorOverlay` + `resolveSelector` (see `docs/13-cursor-overlay.md`), but the `animate` CLI calls `generateAnimatedSvg({ width, height, frames })` and never passes them through — so an on-screen pointer is impossible from a config.

**Surface.** A top-level `cursor`, in two forms.

**Explicit** — frame-relative + selector-anchored. The CLI plays the `resolveSelector` role and converts `{ frame, at }` → global scene time using the timeline it already computes:

```jsonc
"cursor": {
  "style": { "scale": 1.5 },
  "events": [
    { "frame": 2, "at": 1600, "type": "moveClick", "selector": ".diff-line[data-line='23']" },
    { "frame": 6, "at": 0,    "type": "hide" }
  ]
}
```

**Derived** — `"cursor": "auto"`: for each `click`/`hover`/`fill` action, resolve the target's bbox and emit a move + click-pulse, so the pointer simply *follows the actions* — perfectly synced, zero manual authoring.

**Semantics.**
- Explicit `events[].selector` resolves to a bbox at the named frame's capture; `at` is ms within that frame, mapped to global time via the existing per-frame timeline.
- `"auto"` derives one cursor event per interaction action from the action's resolved target + a computed time (see the timing model below); `style` defaults apply.
- Event `type` mirrors the cursor-overlay API (`move`/`click`/`moveClick`/`hide`).
- **Aiming the derived pointer (DM-1742).** By default `"auto"` aims at the target's border-box **center**. When the changing value *is* the target's label (a `Clicked N times` counter button), the pointer + pulse would sit exactly on the one thing the viewer must read — so `click` / `hover` / `fill` actions accept an optional aim: `"cursorAt"` picks one of the nine named anchor points (`top-left` … `center` … `bottom-right`, the overlay `anchor.at` vocabulary), and `"cursorOffset": { "dx", "dy" }` nudges from there in px. Example: `{ "type": "click", "selector": "#btn", "cursorOffset": { "dx": 40, "dy": 10 } }` lands the pointer beside the label. Both fields are ignored under an explicit `cursor` events form (those carry their own `selector`/`offset`).

**Auto-cursor timing — where the click lands (DM-1050).** This is the one part of the model that surprises authors, so it's worth stating plainly. A frame's captured **content is the _result_ of its `actions`** — capture runs *after* the actions — and the **transition _into_ a frame is what reveals that result**. So a frame's job is to show the *outcome* of its own click. To read as cause→effect, the click must therefore be shown on the **previous** frame's image (the "before" state), landing just before the transition that reveals the result.

`"auto"` does exactly this: for a click in a `continue` frame, the move + pulse are placed near the **end of the previous frame's hold**, so the pointer clicks the button on the before-image and the crossfade then reveals what the click produced. (A click in frame 0, or in a frame that reloads via `input`, has no prior before-image to stage over, so its pulse stays within its own hold.)

Worked example — the cart demo:

```jsonc
{ "input": "…/cart/", "duration": 1000 },                              // frame 0: empty cart
{ "continue": true,
  "actions": [{ "type": "click", "selector": "#load-cart" }, { "type": "wait", "ms": 200 }],
  "transition": { "type": "crossfade", "duration": 220 }, "duration": 1100 }  // frame 1: LOADED cart
```

The pointer clicks `#load-cart` during frame 0's hold (over the empty cart), then the 220 ms crossfade reveals the loaded cart that the click produced — *not* a click landing in the middle of the already-loaded cart. The `duration`/`transition` on frame 1 size **frame 1's own hold and the crossfade out of it**; they don't bound the click, which belongs to the frame-0 → frame-1 reveal. (Before DM-1050 the auto-cursor placed each click at the mid-hold of its *own* result frame, so the pointer appeared to click *after* the change it caused was already on screen.)

**Replaces.** The need to drop to the programmatic API solely to get an on-screen pointer. `"auto"` is broadly useful for any interaction demo.

---

## 7. Variables + `${}` interpolation

**Problem.** Ports, paths, and selectors get duplicated across frames, and there's no way to retarget a config without editing every occurrence.

**Surface.** A top-level `vars` map; `${name}` interpolation in string fields:

```jsonc
"vars": { "base": "http://localhost:4188", "file": "src/auth/session.ts" },
"frames": [
  { "input": "${base}", "waitFor": ".diff-view",
    "actions": [{ "type": "click", "selector": ".file-name[title='${file}']" }] }
]
```

**Semantics.**
- Interpolation runs after schema parse, before each frame executes, over every string field in the config.
- `${name}` with no matching var is a **hard error** (typo-catching). Escaping: `$${` yields a literal `${`.
- Values are strings only (no expressions/computation — that's a non-goal). Nesting (`vars` referencing other vars) is out of scope for v1.

**Replaces.** Hand-duplicated constants; lets one config target different inputs without code.

---

## 8. `evaluate` — last-resort escape hatch

**Problem.** Even with all of the above, a long tail of one-off needs remains.

**Surface.**

```jsonc
{ "type": "evaluate", "script": "document.querySelector('.x').scrollLeft = 40" }
```

Runs the script in page context via `page.evaluate` during the frame's action phase.

**Semantics & guardrails.**
- Positioned explicitly as the **last resort**, for **very small snippets**. Documented rule: *"more than a line or two means you've outgrown the config — use the programmatic API."*
- Emit a **warning** (to stderr) when a `script` exceeds ~N characters or lines (proposed: > ~200 chars or > 2 lines), nudging toward the declarative actions (§2–§3) or the API. The warning is advisory, not a hard failure.
- Already sandboxed to the page via `page.evaluate` (no broader access than the page itself).

**Replaces.** Nothing it shouldn't — it's the deliberate catch-all so authors never get *fully* stuck in JSON, while everything common has a declarative form above.

---

## 9. Template frames (DM-1287)

A frame may embed a named **template** (doc 70) instead of an `input` page or a `cast` recording — the declarative way to drop a `lower-third` banner, a `kinetic-text` title, or a `device-mockup` framing into a larger animation.

**Surface.**

```jsonc
{ "template": "lower-third",
  "params": { "title": "Ada Lovelace", "subtitle": "First Programmer" },
  "duration": 3000, "transition": { "type": "cut", "duration": 0 } }
```

- `template` — a built-in (`lower-third`, `device-mockup`, `background-loop`, `kinetic-text`) or an installed `domotion-template-<name>` package, resolved exactly like the `domotion template` verb.
- `params` — validated against that template's own zod schema at compose time; an unknown name or bad params fails with a path-specific error. `${vars}` interpolation applies to `params` strings (§7).

**Semantics & guardrails.**
- `template` is mutually exclusive with `input` / `cast` / `continue`; `params` requires a `template`; frame 0 may be a template frame.
- The template **inherits the config `width`/`height`** when its schema declares them and they're unset, so it fills the frame. An output that still differs (e.g. `device-mockup`'s bezel growth) is placed per the frame's optional **`fit`**: `center` (default, 1:1 — oversized is clipped), `contain` (scale-to-fit, letterboxed), or `cover` (scale-to-fill, cropped). `fit` requires a `template`.
- `duration` is **optional** on a template frame — omit it to inherit the template's intrinsic play time (`TemplateOutput.durationMs`); a static template (e.g. `device-mockup`) has none, so it needs an explicit `duration`. The template's internal animation plays within `duration` (size it to ≈ the template's play time, same rule as a `cast` frame).

**Implementation.** A template is itself a front-end onto `composeAnimateConfig`, so the embedding nests an animated SVG in the animation. Template frames are pre-rendered before the outer font lifecycle (so the nested compose can't clobber the outer frames' embedded fonts), and the nested document's global names (ids, font families, frame/anim classes, `@keyframes`, `--scene-dur`) are namespaced per-frame so they don't collide with the outer animation or sibling template frames. Full detail in **`docs/73-template-frames.md`**.

---

## 10. Forced CSS pseudo-state — `forceState` (DM-1516)

A frame may force real CSS pseudo-state on selectors **before capture**, so it paints the page's OWN `:hover` / `:active` / `:focus` styling instead of a synthetic overlay. This is how you capture the natural feedback a real site gives on pointer/keyboard interaction.

**Surface.**

```jsonc
{ "continue": true, "duration": 1800,
  "forceState": [ { "selector": ".cta", "states": ["hover"] } ] }
```

- `selector` — forced on **every** matched element (throws if it matches nothing, like an action selector).
- `states` — a non-empty list from `hover` / `active` / `focus` / `focus-within` / `focus-visible` / `visited` / `target` / `enabled` / `disabled` / `checked` / `indeterminate` / `read-only` / `read-write` / `link`.
- `reset: true` (in place of `states`) — DM-1566: **clear** any state a previous frame forced on `selector`, capturing it back at rest. Mutually exclusive with `states`. A later `continue` frame carrying `{ "selector": ".cta", "reset": true }` releases a hover an earlier frame set (the un-hover verb).

**Semantics.**
- Runs **after `actions`** (so it reflects the post-action DOM) and **before capture** (the forced paint is what gets serialized). The whole cascade fires, not just the hovered node — e.g. `.card:has(.cta:hover)` restyles the card, and descendant/`:hover`-derived rules all apply.
- Pair it with a **`cursor`** move (auto or explicit) so the pointer visibly sits on the element it's hovering. A common shape is a `continue` frame that forces `:hover` and cross-fades from the rest frame (see `examples/animate/hover-state/`).
- The forced state persists on the live page until navigation, carrying into a later `continue` frame like any other pre-capture mutation. Use `reset: true` (DM-1566) to drop it mid-session, or reload the frame (drop `continue`).

**Sugar.** Two one-field shorthands expand into `forceState` frames (see `docs/94-interaction-state-capture.md`):

- **`hoverReveal: { selector }`** (DM-1562) — auto-expands the frame into a rest → forced-`:hover` crossfade pair + a cursor move onto the element. Options: `states` (default `["hover"]`), `crossfadeMs`, `hoverMs`, `cursor`. Example: `examples/animate/hover-reveal/`.
- **`hoverDetect: { selector }`** (DM-1563; needs an `input`) — a pre-pass drives a real `:hover`, diffs `getComputedStyle` on the target + descendants, and synthesizes the transition: a **crossfade** for a paint change (color/background/border/box-shadow) or a single-frame intra-frame **tween** for a motion-only (transform/opacity) change. Options: `states`, `transitionMs`, `hoverMs`, `cursor`. Example: `examples/animate/hover-detect/`.

**Implementation.** The CLI applies each entry via the imperative primitive `applyForcedPseudoStates(page, forceState)` (exported from the package root), which uses CDP `CSS.forcePseudoState`. The CDP session is cached per page and left attached on purpose: a forced override is cleared the instant its session detaches, so it must outlive the capture — and `reset` re-issues an empty class list on that same cached session (under one cached document root) so it targets the exact node id the force was set on. Full design + the auto-detection roadmap is **`docs/94-interaction-state-capture.md`**.

---

## 11. Compressed editing runs — `states` (docs/100 Primitive 1)

A frame may capture **N editing states of the live page inside one frame** and compose them through the frame-sequence compressor (`composeCompressedRun`, `docs/100-rich-text-editing.md`): content shared across states is emitted once, and every later state contributes only what actually changed — new glyphs appear via `step-end` opacity births, a shifted tail rides `step-end` `translateX` waypoints, a recolored glyph gets a `fill` step keyframe. Layout **snaps** at state boundaries (real editors snap; crossfading near-identical lines reads as a blur-pulse). The composed run becomes this frame's content as a nested animated SVG — the `typeResample` / `cast` nesting pattern, so it needs no animator changes.

**Surface.**

```jsonc
{ "input": "./editor.html", "duration": 1910,
  "caret": { "color": "#e2e8f0" },
  "states": [
    { "duration": 260 },                                                      // state 0: the frame's own post-actions state
    { "actions": [{ "type": "evaluate", "script": "ins(2)" }], "duration": 150 },
    { "actions": [{ "type": "evaluate", "script": "ins(4)" }], "duration": 150 },
    { "actions": [{ "type": "evaluate", "script": "colorize()" }], "duration": 900 }
  ] }
```

**Semantics.**

- The frame loads / continues as usual and runs its own `actions`; **state 0 is that post-actions state**. Each later state runs its `actions` (the full §2–§3 vocabulary) against the live page, then captures. Per-state `duration` (> 0, required) is how long the state holds before snapping to the next; the run's total play time is the sum — size the frame's `duration` to ≈ that sum (the CLI warns otherwise, the `cast`-frame rule).
- `caret: true | { shape, color }` opts into the run's **auto-caret**: the compressor derives each state's edit point (where the typed glyphs landed / where a deletion closed up), so the docs/97-shaped caret rides the run with zero addressing. `shape` defaults to `bar`, `color` to `#111111`. `caret` requires `states`.
- The compressor logs its **pairing ratio** per run (`compress: run of N states, X% glyphs paired, Y KB → Z KB`) so authors can see when compression collapsed (anything failing exact pairing re-emits from its own state's capture — never wrong pixels, just less compression).
- `states` is mutually exclusive with the other content-producing kinds (`scroll` / `cast` / `template` / `typeResample` / `jsReveal`). It drives the live page, so it works on a `continue` frame or a fresh `input` load. Like those kinds, a `states` frame has no single captured tree: magic-move to/from it falls back to crossfade, and cursor events can't address the states *inside* the run (editing runs have no pointer).
- A `compress: true` form stamped across a run of ordinary consecutive `continue`+`cut` frames is **not** part of v1 — collapsing config frames would re-index every frame-addressed feature (cursor events, transitions, magic-move); `states:` keeps the 1 config-frame ↔ 1 animation-frame invariant instead.

Examples: `examples/animate/compressed-run/` (minimal), `examples/animate/editor-session/` (the flagship editor rebuild). Engine + measured behavior: `docs/100-rich-text-editing.md` ("Shipped engine (v1)"); authoring recipe: `docs/102-editing-page-rig-cookbook.md`.

## 11.1 Independent per-region timing — `regions` + `advances` (DM-1770)

A scene often holds several **independently-updating regions**: an editor pane and a rendered-preview pane, a code view and its minimap, a log tail beside a static sidebar. The compressor already keeps each one's glyph identities apart — every run of text carries a **region**, auto-detected as its innermost *clipping* ancestor, else the innermost side-by-side **column** taller than one line box (`docs/100`, "Independent regions in one scene"). What §11 alone cannot express is regions running on **different schedules**: `states:` is one grid, so the author must interleave both panes' sequences by hand into a single list, and every distinct moment in the union of their schedules costs its own whole-page capture.

`regions` + `advances` fixes both. It is a **hybrid**: auto-detection stays the default, and an explicit declaration overrides it only for the elements it covers.

**Surface.** A frame-level `regions: { <name>: <selector> }` map beside `states:`, plus a per-state `advances: [<name>…]`:

```jsonc
{ "input": "./panes.html", "duration": 1940,
  "regions": { "editor": "#ed", "preview": "#pv" },
  "states": [
    { "duration": 320 },                                                                              // state 0: both regions at their start
    { "advances": ["editor"],  "actions": [{ "type": "evaluate", "script": "setEditor(3)" }],  "duration": 200 },
    { "advances": ["preview"], "actions": [{ "type": "evaluate", "script": "setPreview(1)" }], "duration": 200 },
    { "advances": ["editor"],  "actions": [{ "type": "evaluate", "script": "setEditor(6)" }],  "duration": 200 },
    { "advances": ["preview"], "actions": [{ "type": "evaluate", "script": "setPreview(2)" }], "duration": 620 }
  ] }
```

**Semantics.**

- **`regions` (the declaration).** Each selector resolves in page context at capture time and is stamped `data-domotion-anim` on its **first** match — the same mechanism `textTracks` (§12) and intra-frame `animations` (§2) already use — so the captured element becomes an explicit **region root**. It overrides the auto-detected discriminator inside it, changes nothing outside it, and auto-detection still subdivides *within* it (a nested scroll container inside a declared pane is still its own, finer region). Two hard errors: a selector matching nothing, and two regions resolving to the **same** element — a region is the unit a state advances, so they must be distinct. `regions` requires `states`.
- **Naming beats geometry.** An auto-detected region is identified by its box, all the detector has to go on, so a pane that **resizes** between states is a different region and its lines re-emit ("re-emit on any doubt"). A *declared* region is identified by its name, so a resizing pane stays itself and its lines still pair. This is a **bytes-only** difference — every emitted position comes from that state's own capture and every track is `step-end`, so pairing quality can never move a pixel.
- **`advances` (the timing).** Names the region(s) a state moves forward. State 0 may not declare it (it is every region's starting point), names must be declared on the same frame and may not repeat, and the list may not be empty — all path-specific validation errors.
- **Capture stays whole-page.** The browser paints the page; there is no such thing as capturing one pane. What changes is that one whole-page capture is **assigned** to several regions at once: states advancing **disjoint** regions are driven into the page together and captured once, and each state's tree is then assembled by taking each region's subtree from the capture round that holds *its* state. A state's `actions` are one indivisible script, so they run in exactly one round, and every region a state advances must move strictly past the round of its own previous advance (rounds are cumulative). Measured on a two-pane scene: **7 states over 2 alternating regions cost 4 whole-page captures instead of 7**, and 3 regions × 4 advances cost 5 instead of 13 — `1 + max(nᵢ)` against `1 + Σnᵢ`.
- **The one precondition, checked not assumed.** The assembly is only valid if a region's content cannot move anything **outside** itself. The non-region remainder of every capture round must therefore be byte-identical; when it isn't, the run **hard-errors**, naming the frame and the round that diverged. (A plausible-looking but wrong composition is exactly what that check exists to prevent.) The fix is to declare the changing element as a region, or drop `advances`. A region's own subtree may of course change however it likes — that is the point. Region roots are re-stamped before every capture, so a state's actions may rebuild the DOM *under* a region root; losing the root **element** itself is its own named error.
- **`advances` is what engages the schedule.** A bare `regions` map with no `advances` anywhere is a **discriminator override only** — capture stays sequential, one per state, exactly as §11 has always behaved.
- **Payload is not the point.** Every track is `step-end` and the emitter only writes a stop where a value *changes*, so a state in which a region is unchanged contributes nothing to that region's keyframes: a 3.5× finer state grid costs 0.4% of the output (`docs/100`). Per-region timing buys the **authoring model** (two independent sequences instead of one hand-interleaved list) and the **capture count** — not bytes.
- **`${}` interpolation** (§7) applies to region **selectors**, like every other selector. Region **names** are config-internal identifiers matched literally: object keys are never interpolated, so the `advances` entries that must match them are not either.

The CLI logs the schedule it chose:

```
  states: 7 states over 2 regions → 4 whole-page captures (per-region timing; 7 without it)…
  compress: run of 7 states, 98.3% glyphs paired, 108.7 KB → 25.4 KB
```

Example: `examples/animate/region-timing/`. Design + measurements: `docs/100-rich-text-editing.md` ("Independent regions in one scene" and "Independent per-region timing").

## 12. Caret + selection tracks — `textTracks` (docs/101)

A frame may declare **caret / selection tracks** anchored to its captured text: timed events addressing character positions inside an element, rendered as a blinking caret (bar / block / underscore, docs/97 geometry) and/or a sweeping selection highlight — on **Chromium's own painted glyph positions** from the captured tree (no live-page probe, no hand-tuned ascent constants). See `docs/101-caret-selection-track.md` for the engine.

**Surface.**

```jsonc
{ "continue": true, "duration": 2200,
  "textTracks": [
    { "selector": "[data-line='3']",
      "color": "#93c5fd",
      "events": [
        { "type": "park",   "at": 200, "charOffset": 19 },
        { "type": "move",   "at": 600, "charOffset": 9 },
        { "type": "select", "at": 800, "charStart": 9, "charEnd": 15, "sweepMs": 450 }
      ] }
  ] }
```

**Semantics.**

- **Addressing.** The track's `selector` resolves at capture time by stamping `data-domotion-anim` on the **first** match (the intra-frame-animation mechanism); a selector matching nothing is a **hard error** naming the frame + config path. Offsets count Unicode **code points** over the element's own text runs in captured order. A per-event `selector` override retargets that one event.
- **Events** (`at` = ms within the frame, mapped to global time like cursor events): `park` / `move` `{ at, charOffset }` place the caret (step-end jumps; blinks while parked); `hide` `{ at }` hides it until the next park/move; `select` `{ at, charStart, charEnd, sweepMs?, color? }` sweeps a selection over the range, growing per painted character edge over `sweepMs` (0 = appears at once); `clearSelection` `{ at }` clears the most recent selection.
- **Track options**: `shape` (`bar` default / `block` / `underscore`), `color` (default `#111111`), `barWidthPx` (2), `blinkMs` (1060), `selectionColor` (default a translucent blue; per-event `color` overrides).
- **Auto-end at the frame's cut — `persist` (DM-1763).** A track's caret/selection would otherwise HOLD their final state through the animation loop and layer above *every later frame* (a caret parked in frame N keeps blinking over frames N+1..end). Because config tracks are **per-frame** (`frames[i].textTracks`), a frame's track now **ends at that frame's cut by default**: when the authored events leave the caret visible or a selection active at end-of-frame, the CLI synthesizes a trailing `clearSelection` (if a selection is active) then `hide` at the frame's `duration`. So the common case — park, move, sweep, done — needs **no** explicit terminal events. Two escape hatches: (a) an author who *does* end the track by hand (their own final `hide` / `clearSelection`) is never doubled — the synthesis only adds what's still "on"; (b) `"persist": true` on the track opts out entirely, carrying the caret/selection past the frame's cut (the pre-DM-1763 behavior, for a deliberate hold above later frames). This is a CLI-config-layer synthesis only — the programmatic `resolveTextTrack` API is unchanged (global-timeline callers manage their own lifetimes).
- Unresolvable **events** (out-of-range offsets) are skipped with a warning (the cursor-overlay soft-fail convention) — only the selector itself is a hard error.
- `textTracks` requires this frame's single captured tree, so it can't be combined with `scroll` / `cast` / `template` / `typeResample` / `jsReveal` / `states`. Z-order: selection rects paint **above** the captured text (a highlight-marker look — true behind-the-glyphs selection is the compressed run's merged emission), and the whole track layers above frame content but **below the cursor overlay**.

Examples: frame 1 of `examples/animate/compressed-run/`; the selection frame of `examples/animate/editor-session/` (park → move → sweep — the `clearSelection` + `hide` at the cut are now synthesized by the auto-end default, so the config just declares the sweep).

---

## 13. Compressed-run detection — `autoCompress` (whole config) and `compress` (per run)

There are three ways to get a compressed run, from most explicit to least:

| Surface | Scope | You restructure frames? | Ineligible run |
| --- | --- | --- | --- |
| `states: [...]` (§11) | one frame you author | yes — states live inside one frame | n/a (you wrote the states) |
| `compress: true` (§13.2) | one run you mark | no | **hard error** naming the frame + reason |
| `autoCompress: true` (§13.1) | every run in the config | no | left uncompressed, logged reason |

All three end up at the **same** machinery and the same output shape: `autoCompress` and `compress` are pure config pre-passes that rewrite the run into a `states` frame before capture, so the composed result is exactly what hand-authoring the `states` block would have produced. Per doc 100 the result is **pixel-identical to the uncompressed flipbook** at every time; the win is **raw size + live-DOM weight** (shared content emitted once), never fidelity.

### 13.1 Automatic detection — `autoCompress` (DM-1757)

The `states` block (§11) is the **explicit** way to compress an editing run: the author lists the states inside one frame. `autoCompress` is the **automatic** counterpart — a top-level opt-in that finds compressible runs in an *ordinary* multi-frame config and collapses each without the author restructuring anything.

**Surface.** A top-level boolean (also `--auto-compress` on the CLI, which forces it on regardless of the config key):

```jsonc
{ "width": 640, "height": 360, "autoCompress": true, "frames": [ /* ordinary continue+cut frames */ ] }
```

**What it does.** Before capture, a pre-pass detects **maximal runs of consecutive plain `continue` + `cut` frames** and rewrites each into a single `states` compressed run (§11) — reusing the exact same machinery, so the composed output is a nested compressed run just as if you had authored the `states` block by hand. Per doc 100, the result is **pixel-identical to the uncompressed flipbook** at every time; the win is **raw size + live-DOM weight** (shared content emitted once), never fidelity. The pairing-ratio log line (`compress: run of N states, …`) surfaces for each collapsed run.

**Default OFF — and why.** Turning it on changes the **output shape** of any config that contains such a run (those frames now nest as one run instead of N sibling frame groups). That is a deliberate, global decision, so it is opt-in; a config without the flag is byte-identical to before. This mirrors doc 100's staged rollout ("behind a flag first, then default").

**Safe scope.** A run is collapsed only when it is safe to do so with zero interaction loss; anything else is **left uncompressed with a logged reason** (never a hard error). A run's members must all be plain captured frames with a `cut` transition and **none** of: `overlays`, `animations`, `textTracks`, `forceState`, a non-default (`body`) `selector`, or a content kind (`scroll`/`cast`/`template`/`states`/`typeResample`/`jsReveal`). Non-anchor members must be pure `continue` frames with no readiness waits or `scrollTo` (a `states` run has no per-state readiness wait; a frame carrying one instead becomes the anchor of the *next* run). Frame-addressed features that survive (explicit `cursor.events[].frame` on frames *outside* the runs) are **remapped** onto the collapsed indices automatically.

**Sub-run splitting — one bad frame costs one frame.** Three exclusions are *single-frame* reasons rather than run-wide ones: an explicit `cursor` event addressing a member, an interaction action (`click`/`hover`/`fill`) a `cursor: "auto"` pointer would be derived from, and a `magic-move` transition landing on the run's anchor (collapsing it would degrade that transition to a crossfade). Such a frame **splits** the candidate window instead of disqualifying it: it stays a plain sibling frame — so its pointer, or the magic-move morph into it, behaves exactly as it did uncompressed — and the eligible sub-runs on either side collapse normally, subject to the two-frame minimum. A window of eight frames with a cursor event on frames 2 and 5 therefore yields `[0,1]` compressed · `2` plain · `[3,4]` compressed · `5` plain · `[6,7]` compressed. Frame-level blockers (`overlays`, `animations`, a readiness wait, …) split the same way — the member scan ends at that frame and the next eligible frame anchors a new run. Each split logs its own line:

```
  auto-compress: collapsed frames 0–2 into a states run (3 states, 600ms)
  auto-compress: leaving frame 3 uncompressed — an explicit cursor event addresses frame 3
  auto-compress: collapsed frames 4–6 into a states run (3 states, 600ms)
```

Under the `compress: true` marker a split point is still a **hard error** (§13.2): the author asked for that exact run, so quietly compressing a shorter piece of it would hide the mismatch between what they wrote and what they got.

**Why per-frame `overlays` split rather than ride along.** An overlay looks like it should just move onto the collapsed frame with its `delay` shifted by the state's offset into the run. Two things stop that from being a remap:

- **Overlay lifetime is frame-scoped.** Every kind is emitted against its frame's window, and `typing` / `blink` / `interact` explicitly HOLD until the frame ends (§5). An overlay authored on the third of five members currently disappears at that member's cut; moved onto the collapsed frame it would hold to the end of the *whole run*. Only `tap` is fully described by its own `delay` + `duration`. Preserving the authored behavior needs a per-overlay end — a new concept in the overlay model, not a config rewrite.
- **Anchors resolve against the live page, once per frame.** A `selector`-anchored overlay (or `maxWidth: "anchor"`) is resolved after the frame's actions have run. A collapsed run leaves the page at its LAST state, so a state-3 overlay would anchor against state 5's layout — and layout moving between states is precisely why the run compresses at all. Preserving it needs anchor resolution interleaved into the run's per-state capture.

Both are changes to the overlay contract itself rather than to the collapse pass, so overlays remain a split point: the frame carrying one stays a plain sibling frame and the run compresses around it, which since sub-run splitting costs exactly that one frame.

**Size-regression guard — `autoCompress` can never make output bigger.** Compression is pixel-identical but not unconditionally *smaller*: a wholesale-change run (a slideshow, where consecutive frames share almost nothing) pairs badly, re-emits nearly everything as births/deaths, and pays the union + track overhead on top. Measured on a five-slide run: **9.3 KB of uncompressed payload composed to 19.2 KB compressed — 2.1×**, at 10% of glyphs paired. So after composing a run *the automatic pass created*, the collapse is checked against the alternative and reverted when it lost:

```
  compress: run of 5 states, 10.2% glyphs paired, 9.3 KB → 19.2 KB
  auto-compress: reverting frame 0's run to uncompressed states — compressing it
    grew the payload 107% (9.3 KB → 19.2 KB, only 10.2% of glyphs paired);
    uncompressed is 10.1 KB
```

The reverted run keeps the same shape — one nested frame holding the N captured states, each gated by a `step-end` `display` window instead of the compressor's identity tracks — so it stays **pixel-identical** and the collapse's one config frame ↔ one animation frame invariant is untouched. End to end on that config, `autoCompress: true` produces **43.2 KB against the flipbook's 44.3 KB** (0.976×): the flag cannot make output worse, which is what makes it safe to enable blindly.

The comparison is free of extra capture and near-free of extra compose: the compressor already reports both sides (`rawBytes` = the same states rendered independently, `compressedBytes` = what it produced), which triggers the check, and the uncompressed alternative is built only when that trigger fires (~5 ms; the state snapshot it needs costs ~1 ms).

A run **you** asked for is not silently rewritten — a hand-authored `states:` block (§11) or a `compress: true` marker (§13.2) that regresses gets a `note:` line reporting the measured growth and pointing at the opt-out, exactly like the marker's hard-error contract. Only the automatic pass reverts.

See **`docs/100-rich-text-editing.md`** (Primitive 1) for the compressor design, the measured size/DOM savings, and the pairing model; the automatic detection is the "automatic pass over all continue+cut runs" that doc anticipated, now shipped behind this flag.

### 13.2 Explicit per-run marker — `compress` (DM-1761)

`autoCompress` is all-or-nothing: every eligible run in the config collapses. `compress: true` is the **surgical** form of the same thing — a per-frame boolean that collapses **one** run, on the author's terms, leaving every other frame exactly as it was.

**Surface.** `compress: true` on the **first frame of the run** (the anchor — the frame that loads the `input` or starts the `continue`). It takes the maximal eligible run *starting there*:

```jsonc
{
  "width": 640, "height": 360,
  "frames": [
    { "input": "editor.html", "duration": 400, "transition": { "type": "cut", "duration": 0 } },
    { "continue": true, "duration": 300, "transition": { "type": "cut", "duration": 0 },
      "compress": true,                                    // ← anchors the run
      "actions": [{ "type": "evaluate", "script": "ins(3)" }] },
    { "continue": true, "duration": 150, "transition": { "type": "cut", "duration": 0 },
      "actions": [{ "type": "evaluate", "script": "ins(6)" }] },
    { "continue": true, "duration": 300, "transition": { "type": "cut", "duration": 0 },
      "actions": [{ "type": "evaluate", "script": "colorize()" }] }
  ]
}
```

Frame 0 stays a sibling frame even though it is just as eligible; frames 1–3 become one compressed run. Under `autoCompress: true` the same config would collapse **all four**.

**Anchor-only, greedy left-to-right.** The marker means "start a compressed run here." A marker on a *later member of the same run* is a redundant no-op — the scan has already consumed that frame — so marking only the anchor and marking every member produce byte-identical output, and two markers can never yield overlapping runs. There is no marker on the *end* of a run: a run always extends to the last frame that can join it (same eligibility rules as §13.1). To split one long eligible stretch into two runs, mark the anchor of the first and make the second anchor ineligible as a *member* (e.g. give it a readiness wait), or use two `states:` blocks.

**Ineligible marker ⇒ hard error.** This is the one behavioral difference from `autoCompress`, and it is deliberate. An automatic pass that skips a run is doing its job; a marker the author *typed* that silently emitted a flipbook would hide the bug. So `compress: true` on a frame that cannot anchor a valid run throws, naming the frame index and the reason:

```
animate: frames[2] sets `compress: true` but the run cannot be collapsed —
  no following frame can join it — frames[3] carries `animations`, which has no
  per-state equivalent inside a compressed run — author that run as a `states:`
  block instead, which can carry frame-level `animations` (docs/43 §11)
```

Every §13.1 exclusion becomes such an error under the marker: a non-`cut` transition, a content kind (`scroll`/`cast`/`template`/`states`/`typeResample`/`jsReveal`/`hoverReveal`/`hoverDetect`), a `selector` subtree capture, per-frame `overlays`/`animations`/`textTracks`/`forceState`, a member that reloads an `input` or carries a readiness wait/`scrollTo`, an explicit `cursor` event addressing a member, `magic-move` entry into the run, a member interaction action under `cursor: "auto"`, or a marked frame with nothing after it to join. The per-frame decorations point at the `states:` block (§11), which *can* carry them at frame level.

**`compress: false` — the opt-out.** The complement, and the reason the marker is a boolean rather than a bare flag: a frame set to `compress: false` can neither anchor nor join a run, under *either* surface. Use it to hold one run out of a whole-config `autoCompress: true` — doc 100 notes a *wholesale-change* run (a slideshow, where consecutive frames share almost nothing) pairs poorly and can come out marginally **larger** compressed, since the compressor re-emits from chrome and pays the nesting overhead on top.

**Both at once.** `compress` markers are resolved **first**, then `autoCompress` sweeps the rest. There is no double-collapse: a collapsed frame carries `states`, which disqualifies it as both anchor and member of the automatic pass. So `autoCompress: true` plus markers means "compress everything, and fail loudly if these particular runs ever stop being compressible" — a useful regression guard on a config whose compression you care about.

**Log lines.** Marker collapses log under the `compress:` tag, automatic ones under `auto-compress:`; both are followed by the compressor's own `compress: run of N states, …` pairing-ratio line.

---

## Nested animation: preserved vs snapshotted (DM-1322)

Composition primitives differ in whether a **nested animation** survives. This is the single most surprising thing about composing animated pieces, so the contract is spelled out:

| Primitive | Nested animation? | Notes |
|---|---|---|
| `cast` frame | **Preserved** | The terminal recording plays. Since DM-1319 its timeline is re-anchored to start when the frame appears (see `docs/67`). |
| `template` frame | **Preserved** | An animated template (one with a `durationMs`) plays; re-anchored like a cast (DM-1319). A static template (e.g. `device-mockup`) has nothing to animate. |
| `scroll` frame (`--scroll` / `scroll` block) | **Preserved** | The composed scroll SVG carries its own keyframe loop. |
| `states` frame (compressed run, §11) | **Preserved** | The composed run is a nested animated SVG (step-end birth/shift/recolor tracks), re-anchored to start when the frame is shown (`embeddedAnimationPeriodMs`). |
| `input` frame `animations` | **Preserved** | Intra-frame property animations on captured elements run during the frame's hold. |
| **`svg` overlay** | **Snapshot (NOT preserved)** | A referenced `.svg` is inlined as a **static first-frame** graphic — an *animated* SVG loses its animation. Use a `cast` / `template` frame, or the `composite` primitive, for an animated inset — not an `svg` overlay. |
| `device-mockup` / `wrapInDeviceChrome` (decorator) | **Preserved with animated content** | `wrapInDeviceChrome` *nests* its screen (it doesn't re-render), so it preserves animation. The `device-mockup` template's `input`-capture path is static, but its `screenSvg` param (DM-1323) nests a pre-rendered **animated** SVG with animation intact. |
| `composite` layers (`composeAnimatedLayers` / `domotion composite`) | **Preserved** | The general animated-nesting primitive (DM-1323, doc 77): every layer keeps its animation, on its own timeline. |

Rule of thumb: **frame kinds** (`cast` / `template` / `scroll` / `input`) and **composite layers** preserve animation; an **`svg` overlay** and a decorator's **static capture path** snapshot it. To nest an animated thing inside another (terminal-in-window-on-desktop), reach for `composite` (doc 77).

---

## Output structure & post-processing (DM-1324)

The composed document is **one outer `<svg>`** built by `generateAnimatedSvg` with a predictable, stable shape — useful if you post-process the SVG (e.g. to add custom chrome). The supported seams come first; the raw structure is documented so a reader knows what they're looking at, **not** as an API to depend on.

**Prefer the extension seams** over reaching into the markup:

- **`composeAnimateFrames`** (doc 62) returns the assembled `AnimationConfig` *before* the final `generateAnimatedSvg`, so you can edit frames/overlays/transitions as data.
- **`onFrame`** (doc 62) is a per-frame hook to mutate each `AnimationFrame` (its `svgContent`, `overlays`, …) as it's composed.
- **`generateAnimatedSvg`** is itself exported — assemble or wrap frames and render yourself.

**Raw structure** (stable, but treat the seams above as the contract):

- Each frame is a group `<g class="f f-N">` (N = frame index). Visibility/opacity over the master loop is driven by `@keyframes fv-N` (opacity/visibility) and, for the display-culling pass, `@keyframes fd-N`; the rule is `.f-N { animation: fv-N <totalSec>s infinite … }`.
- A `cast` / `template` / `scroll` frame's content is a **nested `<svg>`** inside its frame group. To avoid document-global name clashes, that nested document's ids / classes / `@keyframes` / `--scene-dur` are prefixed per frame — `cfN_` for casts, `tfN_` for templates (`namespaceEmbeddedAnimatedSvg`, doc 73 / DM-1287 / DM-1292). A cast's nested timeline is additionally re-anchored to the frame's offset (DM-1319, `embeddedAnimationPeriodMs`).
- Embedded fonts appear **once** as a top-level `@font-face` block (`dmfN` families); frames don't carry their own copies.

If you must hand-edit the markup (e.g. apple-fm's window chrome around a single cast frame), key off `<g class="f f-N">` and the `fv-N` keyframe — but expect those to evolve; the data-level seams won't.

---

## Published JSON Schema

A formal **JSON Schema (draft 2020-12)** for this config ships with the npm package at `schemas/animate-config.schema.json` and is published at a stable URL:

```
https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/animate-config.schema.json
```

Point a config's `"$schema"` key at either the URL or a local path to get autocompletion and structural validation in any JSON-Schema-aware editor (VS Code, JetBrains, etc.):

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/brianwestphal/domotion/main/schemas/animate-config.schema.json",
  "width": 600,
  "height": 360,
  "frames": [ /* … */ ]
}
```

The CLI ignores the `"$schema"` key. Every config under `examples/animate/` carries this pointer as a worked example.

**Source of truth & sync.** The schema is *generated from* the zod `animateConfigSchema` in `src/cli/animate.ts` — never hand-edited — so it cannot drift from what the CLI actually enforces. Regenerate with `npm run build:animate-schema` (also run automatically as part of `npm run build`); the `animate-config-json-schema.test.ts` unit test fails if the committed file is stale.

**Coverage caveat.** JSON Schema captures *structure and types* only. Cross-field and content rules expressed as zod refinements — "frame 0 must load a content source (`input` / `cast` / `template`)", a `scroll.pattern` must parse against the scroll-pattern grammar (`docs/37`), a `replaceText.pattern` must be a valid regex — have no JSON Schema equivalent and are **not** represented. Those stay enforced at runtime by `validateAnimateConfig`. A config that passes the JSON Schema can still be rejected by the CLI for one of these reasons; the JSON Schema is an editor aid, not a substitute for the runtime validator.

---

## Rollout

These compose, but the dependency order is: **§1 (continuous-session)** is the keystone everything else builds on; **§7 (`${}`)** is cross-cutting and should land early so later features inherit it; the action/wait/overlay/cursor features (§2–§6) are independent of each other; **§8 (`evaluate`)** is small and last. Each section has its own implementation ticket. The CLI `--help` and `docs/08-animation-model.md` should gain pointers here once any of this ships.
