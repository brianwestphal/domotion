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
from page `lang` facts are recorded. The concrete answers are serialized as
`sessionGenericFamilies` on each top-level captured root.

`elementTreeToSvgInner` reads that record and calls
`withSessionGenericFamilyOverrides(record, render)`. The scope is synchronous,
so JavaScript cannot interleave another render; `try/finally` restores any
explicit oracle setting. Mixed annotated/unannotated roots and conflicting
page records fail closed. Equivalent JSON records compare canonically rather
than by object insertion order. Legacy trees without a record retain the
documented static/degraded route.

Top-level metadata is the supported ownership envelope. A consumer that
promotes a captured descendant to a new independent render root must preserve
or reattach its originating record; a bare descendant cannot truthfully infer
which Page supplied it.

## Independent logical gate

`npm run fonts:generic-preferences` runs four native launch modes: pinned
Chromium headless/headed and full Chrome headless/headed. Every mode records a
stable default state, then applies a controlled `Page.setFontFamilies` mutation
whose replacement faces come only from that exact run's observed installed
faces. It crosses seven settings generics over Common plus ten scripts (77
settings rows), adds Common/script `system-ui` separation controls (11 rows)
and quoted `"serif"` keyword-classification controls (11 rows), and compares
all 99 rows directly with the production Page probe and Domotion resolver.

The report also runs the old process-global ownership as a destructive
discriminator: B must contaminate at least one A row, the captured A scope must
recover all rows, and the prior explicit global must be restored. It records
browser/product/protocol revisions, launch engine/headful state, locale,
OS/architecture, Node and Playwright versions, source revisions, and a native
font-inventory digest. No tolerance or snapshot can turn a face mismatch green.

`.github/workflows/generic-family-preference-parity.yml` runs the strict matrix
on native macOS, Linux, and Windows. Linux uses Xvfb for the headed legs; every
runner installs both pinned Chromium and full Chrome and uploads its JSON even
on failure.

## Explicit residual boundaries

- This gate mutates live Page Settings through CDP. An isolated non-default
  Chrome profile preference is still needed to prove the upstream
  PrefService-to-WebPreferences propagation path itself.
- Cross-origin OOPIF targets can theoretically receive independent Inspector
  mutations; one main-Page record does not claim target-divergent settings.
- Language discovery does not yet include shadow-root-only or response-header
  language facts. Standing script rows reduce that risk but do not enumerate
  every ICU script.
- Extracted descendant render roots need an explicit metadata propagation
  contract, as described above.
- `system-ui` requires its separate platform-route oracle; this document makes
  only the negative-control claim.
