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
- `maxWidth: "anchor"` wraps `typing` text to the anchored element's **content width** (depends on the typing-overlay wrap support — the `bgWidth`-driven textarea-style wrap). `maxWidth` may also take a number (px). With `maxWidth` set, the author never measures the field or pre-splits the string into lines.
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

## Rollout

These compose, but the dependency order is: **§1 (continuous-session)** is the keystone everything else builds on; **§7 (`${}`)** is cross-cutting and should land early so later features inherit it; the action/wait/overlay/cursor features (§2–§6) are independent of each other; **§8 (`evaluate`)** is small and last. Each section has its own implementation ticket. The CLI `--help` and `docs/08-animation-model.md` should gain pointers here once any of this ships.
