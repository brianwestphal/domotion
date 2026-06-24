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

**Surface.** Make `input` optional. The first frame must load an `input`. A later frame that omits `input` (or sets `"continue": true`) keeps the **current live page** and captures it after running its own `actions`.

```jsonc
{ "input": "http://localhost:4188", "waitFor": ".diff-view", "actions": [ /* … */ ] },
{ "continue": true, "actions": [{ "type": "click", "selector": ".diff-line[data-line='23']" }] },
{ "continue": true, "actions": [{ "type": "fill",  "selector": ".annotation-form textarea", "value": "…" }] }
```

**Semantics.**
- The browser **context/page persists** across continued frames (one page, advanced step by step) instead of a fresh context per frame.
- Frame 0 must have an `input` (error otherwise). A continued frame must have a predecessor (error if frame 0 sets `continue`).
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
- **On `cast` / `template` frames there is no captured DOM** (the content is an embedded, pre-rendered animated SVG), so a selector `anchor` — and `maxWidth: "anchor"` — cannot resolve. Such an anchor is **ignored with a clear warning** (DM-1320) and the overlay falls back to its explicit `x`/`y` (default `0,0`); position overlays on these frames with `x`/`y`. Explicit-coordinate overlays still render normally on top of the embedded animation.
- `maxWidth: "anchor"` wraps `typing` text to the anchored element's **content width** (it resolves into the typing overlay's `wrapWidth` — the textarea-style wrap, DM-1134; `maxWidth` may also take a number in px). With `maxWidth` set, the author never measures the field or pre-splits the string into lines.

> **Typing-overlay wrap vs mask (DM-1134).** A `typing` overlay's wrapping and its placeholder cover are separate knobs: `wrapWidth` (px) controls where the text line-breaks, and `mask: { width, height, color }` controls the cover painted behind it (mask `width` defaults to `wrapWidth`, `height` grows to fit the wrapped lines, and the mask only paints when a `color` is set). The older `bgWidth` / `bgHeight` / `bgColor` fields still work as **deprecated aliases** — `bgWidth` feeds both `wrapWidth` and `mask.width`, `bgHeight` → `mask.height`, `bgColor` → `mask.color` — so existing configs are unchanged; prefer the new fields in new configs.
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

## Nested animation: preserved vs snapshotted (DM-1322)

Composition primitives differ in whether a **nested animation** survives. This is the single most surprising thing about composing animated pieces, so the contract is spelled out:

| Primitive | Nested animation? | Notes |
|---|---|---|
| `cast` frame | **Preserved** | The terminal recording plays. Since DM-1319 its timeline is re-anchored to start when the frame appears (see `docs/67`). |
| `template` frame | **Preserved** | An animated template (one with a `durationMs`) plays; re-anchored like a cast (DM-1319). A static template (e.g. `device-mockup`) has nothing to animate. |
| `scroll` frame (`--scroll` / `scroll` block) | **Preserved** | The composed scroll SVG carries its own keyframe loop. |
| `input` frame `animations` | **Preserved** | Intra-frame property animations on captured elements run during the frame's hold. |
| **`svg` overlay** | **Snapshot (NOT preserved)** | A referenced `.svg` is inlined as a **static first-frame** graphic — an *animated* SVG loses its animation. Use a `cast` / `template` frame for an animated inset, not an `svg` overlay. |
| `device-mockup` / `wrapInDeviceChrome` (decorator) | **Snapshot (NOT preserved)** | The wrapped page is **re-captured to a static SVG** before the bezel is drawn; an animated input is flattened to one frame. General animated nesting (window/device chrome around a still-animating layer) is tracked separately (DM-1323). |

Rule of thumb: **frame kinds** (`cast` / `template` / `scroll` / `input`) preserve animation; **overlays and decorator wrappers** snapshot it.

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

**Coverage caveat.** JSON Schema captures *structure and types* only. Cross-field and content rules expressed as zod refinements — "frame 0 must load an `input`", a `scroll.pattern` must parse against the scroll-pattern grammar (`docs/37`), a `replaceText.pattern` must be a valid regex — have no JSON Schema equivalent and are **not** represented. Those stay enforced at runtime by `validateAnimateConfig`. A config that passes the JSON Schema can still be rejected by the CLI for one of these reasons; the JSON Schema is an editor aid, not a substitute for the runtime validator.

---

## Rollout

These compose, but the dependency order is: **§1 (continuous-session)** is the keystone everything else builds on; **§7 (`${}`)** is cross-cutting and should land early so later features inherit it; the action/wait/overlay/cursor features (§2–§6) are independent of each other; **§8 (`evaluate`)** is small and last. Each section has its own implementation ticket. The CLI `--help` and `docs/08-animation-model.md` should gain pointers here once any of this ships.
