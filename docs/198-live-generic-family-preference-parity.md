# Live generic-family preference parity

DM-2351 establishes which component owns the concrete face behind CSS generic
families and closes a real cross-page state race. This is a logical face gate:
it compares Chromium's painted PostScript/family identity with Domotion's
resolver. It takes no screenshots, has no pixel threshold, and carries no
committed per-OS answer table.

## Source verdict

Generic-family preferences belong to a Chromium **Page/renderer Settings
instance**, not to a Node process or Playwright `BrowserContext`.
`InspectorPageAgent::setFontFamilies` writes the supplied Common and
script-specific values into the inspected page's `Settings`; its one-call
guard is state on that Inspector session, so a fresh CDP session can mutate the
same Page later (`external/chromium/third_party/blink/renderer/core/inspector/inspector_page_agent.cc`,
`setFontFamilies`). `GenericFontFamilySettings` stores a map per ICU script and
falls back to Common when a script has no entry. Blink's selector consults only
the seven settings families: standard, fixed/monospace, serif, sans-serif,
cursive, fantasy, and math.

Launch shape determines who initialized those Settings:

| Launch shape | Effective initialization |
|---|---|
| Playwright default headless | The headless shell starts with Blink Common defaults; Playwright applies its vendored Common/per-script table. |
| Playwright bundled Chromium headed | The full browser preference layer initializes Settings; Playwright does not call `Page.setFontFamilies`. |
| Full Chrome headed | Chrome's profile maps initialize all seven settings families and registered scripts. |
| Full Chrome headless | Chrome profile maps initialize first; Playwright then overwrites only fields/scripts in its partial table. Math and omitted scripts therefore remain profile-owned. |

Playwright selects the headless shell only for a headless launch without a
channel/custom executable (`playwright-core/lib/server/chromium/chromium.js`),
and calls `_setDefaultFontFamilies` for every non-headful page, including a
full-Chrome channel launch (`crPage.js`, `defaultFontFamilies.js`). Full Chrome
fills the profile maps in
`external/chromium/chrome/browser/chrome_content_browser_client.cc`; Blink's
Common defaults are in `third_party/blink/common/web_preferences/web_preferences.cc`.

`system-ui` is intentionally only a negative control here. It does not use
`GenericFontFamilySettings`: Blink routes it through platform system-font
ownership (`FontCache::SystemFontFamily`/`MatchSystemUIFont`). Staying stable
when the seven generic preference maps mutate proves separation, not complete
cross-platform `system-ui` parity.

## The race and the ownership correction

The retired design probed once and installed the result in one module-global.
That made this deterministic sequence wrong even without simultaneous work:

1. capture Page A;
2. capture Page B with different preferences;
3. render A — but resolve its generics using B's last-installed answers.

A live same-context discriminator also proved that Page A can be mutated while
its sibling remains unchanged, and that a second capture of A must observe a
fresh-CDP-session mutation. A BrowserContext or persistent Page cache therefore
has no source-owned invalidation boundary.

The capture funnel now probes the **exact Page on every capture**. It injects
author-important, offscreen logical spans, temporarily neutralizes hostile
`html`/`body` display and visibility declarations, reads
`CSS.getPlatformFontsForNode`, and requires two stable reads (a third is the
tie-break). Common, ten standing scripts, and every additional script derived
from the captured documents' language facts are recorded. Language discovery
uses `DOMSnapshot.captureSnapshot`: its flattened DOM includes closed as well
as open shadow trees, while each document's `contentLanguage` is Blink's exact
response-header-owned `Document::ContentLanguage()` value. This matches
`Element::ComputeInheritedLanguage()`, which walks element/`xml:lang` ancestry,
crosses shadow hosts, and consults `Document::ContentLanguage()` last
(`external/chromium/third_party/blink/renderer/core/dom/element.cc`, revision
`7d859f271c`). Reachable child-frame DOM language attributes remain an
additional control; this does not claim target-divergent OOPIF Settings.

Legacy array captures serialize the concrete answers as
`sessionGenericFamilies` on each top-level captured root. The stable
`CapturedTreeEnvelope` instead stores that Page authority once beside `tree`:

```ts
{
  schema: "domotion-captured-tree-v1",
  tree: CapturedElement[],
  sessionGenericFamilies?: CapturedSessionGenericFamilies,
}
```

`captureElementTreeEnvelope()` captures directly into that form.
`createCapturedTreeEnvelope()` non-mutatingly converts a legacy root array,
requiring every annotated root to carry the same canonical record.
`promoteCapturedSubtree(source, selected)` verifies that every selection
belongs to `source` by object identity, then emits a new envelope whose roots
are the selected descendants and whose authority is the source Page record.
After JSON serialization, the selection must come from the parsed source
envelope; this retains both membership proof and authority without copying the
full map onto every descendant.

`elementTreeToSvg` and `elementTreeToSvgInner` accept either the legacy array or
the envelope, read its one record, and call
`withSessionGenericFamilyOverrides(record, render)`. The scope is synchronous,
so JavaScript cannot interleave another render; `try/finally` restores any
explicit oracle setting. Mixed annotated/unannotated roots and conflicting
page/envelope records fail closed. Equivalent JSON records compare canonically
rather than by object insertion order. Legacy trees without a record retain the
documented degraded route; the envelope never synthesizes a browser/profile
table when Page authority is absent.

## Independent logical gate

`npm run fonts:generic-preferences` runs four native launch modes: pinned
Chromium headless/headed and full Chrome headless/headed. Every mode records a
stable default state, then applies a controlled `Page.setFontFamilies` mutation
whose replacement faces come only from that exact run's observed installed
faces. It crosses seven settings generics over Common plus ten scripts (77
settings rows), adds Common/script `system-ui` separation controls (11 rows)
and quoted `"serif"` keyword-classification controls (11 rows). Each state
therefore observes 99 rows: 88 exact preference/classification rows plus 11
mandatory stable `system-ui` separation controls.

The report also runs the old process-global ownership as a destructive
discriminator: B must contaminate at least one A settings row, the captured A
scope must recover all 77 settings rows, and the prior explicit global must be
restored. It records
browser/product/protocol revisions, launch engine/headful state, locale,
OS/architecture, Node and Playwright versions, source revisions, and a native
font-inventory digest. No tolerance or snapshot can turn a face mismatch green.

`.github/workflows/generic-family-preference-parity.yml` runs the strict matrix
on native macOS, Linux, and Windows. Linux uses Xvfb for the headed legs; every
runner installs both pinned Chromium and full Chrome and uploads its JSON even
on failure.

Focused ownership controls add a distinct logical layer beneath that native
matrix: unit tests cross legacy/envelope JSON, equivalent/reordered A/B
records, partial/conflicting authority, authority-free legacy input, and
unrelated-node promotion. A real Chromium E2E captures an envelope, JSON
round-trips it, promotes a live descendant, renders it, and proves the
process-global compatibility slot remains untouched. A second E2E serves a
Thai `Content-Language` header and a Georgian `lang` inside a closed shadow
root; both scripts must appear with all seven settings rows. No assertion uses
pixels, a font-name snapshot, or a tolerance.

## Explicit residual boundaries

- `npm run fonts:generic-profile-target` now proves the upstream
  PrefService-to-WebPreferences path with an isolated, dynamically derived
  profile rather than a saved font-name snapshot. Full Chrome headed honors all
  supported Common/script fields. Full Chrome headless instead uses its clean
  headless Settings for 20 rows while retaining the profile's Common `math`
  field, because Playwright's Common override table does not assign `math`.
  The source-owned split is asserted exactly and cannot be hidden by a pixel
  tolerance.
- The same gate proves that an ordinary child frame shares its Page authority,
  while a fresh target CDP session can make a cross-site OOPIF diverge without
  moving the main frame. Production supports only the non-divergent state and
  now fails closed when authenticated target Settings disagree; it does not
  clone the main Page record into a divergent target.
- Script probes paint representative scalars (`日`, `अ`, `ก`, `ა`, and their
  peers), so a reported script setting must participate in selection. A Latin
  fallback glyph can no longer make a script-key assertion vacuously green.
- `system-ui` remains outside this gate's parity claim. Its separate exact
  CoreText / Linux renderer-family / Windows menu-font route oracle shipped in
  [doc 211](211-platform-system-ui-preference-route.md); the rows here remain
  ownership negative controls only.
