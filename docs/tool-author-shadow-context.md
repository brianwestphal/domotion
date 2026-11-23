# Private author-shadow context capabilities

DM-QKGJQ5 supplies source identity facts to future selected-root and inline-SVG
consumers. It changes no capture admission, SVG mapping, outline policy, public
options, or existing inset/CSP helpers by itself.

`createAuthorShadowScope(page)` owns one public CDP session. Call `prepare` for
at most one `selected-root` purpose and one `inline-svg-roots` purpose before
calling `evaluateCapture`. Each preparation retains actual candidate Elements,
DOM parent chains, selected roots, Document, Window and default execution-context
identity. The inset helper’s pierced-DOM classifier identifies author-shadow
ancestry, including light descendants of closed slotted hosts. CSS clip and
mask isolation uses its own document-wide ownership guard. [Native CSS shadow
isolation](278-native-css-shadow-isolation.md)

The scope passes only frozen adoption capabilities into the private
`args.authorShadowContexts.selectedRoot` / `inlineSvgRoots` slots. It overwrites
caller-provided slots. Original admins, records and sticky usage ledgers remain
in closures behind remote objects on the same session. No registry, token,
expando or callable bridge is placed in page globals. A copied capability
receiver, different Element, foreign Document, wrong mode/purpose, missing fact
or changed original identity returns `unavailable`. Only an authenticated
`none` adopted with `markUsed !== false` marks the original ledger. Neutral
captures may request `markUsed:false`; they cannot erase earlier usage.

Consumers must still prove their own feature eligibility. A successful capture
verifies every adopted original before returning. Relevant remove/reinsert,
slot changes, new author shadow roots and context loss remain observable even
if the final DOM is restored. Each adopted element must still belong to an
original selector match that covers it. Removing an unused match leaves the
other records valid, as do unrelated temporary color probes. Both consumers’
final ledgers are read together in one source-realm call, followed by a check
of all adopted records’ topology events. Registration seals
before the first tracked snapshot. `DOM.getDocument` is used once: Chromium
clears its frontend NodeId bindings on another call. Later verification uses
`DOM.describeNode` on the original Document backend identity, preserving that
event-tracking epoch.

Authority work has a three-second Node deadline, inventory limits (128 selected
roots/candidates/ancestors per probe, two probes), a 20,000-node/512-level pierced
snapshot limit and an 8,192-event pre-index buffer. Exhaustion produces absent
authority. These bounds do not impose a new deadline or size cap on the actual
CAPTURE_SCRIPT. Scope/probe disposal closes only original owned objects, removes
its slots before releasing handles, and detaches the session independently of
never-settling replies. A bounded warning distinguishes unconfirmed closure close
or group release (timeout, exception or rejection); removing authority does not
claim listener cleanup succeeded. Late creation retains targeted cleanup handlers. The
original pagehide listener deactivates its own closure; navigation does not
transfer it to another Document. Default Playwright disables BFCache, so the
native test establishes pagehide invalidation and real navigation, not an actual
cached-return lifecycle.

`evaluateCapture` runs the same trusted capture body in the main default realm,
with the Chromium evaluation flags `awaitPromise`, `userGesture` and
`returnByValue`. Prepared scopes inject capabilities through actual remote
object arguments; scopes without authority execute once through public
`page.evaluate`. Setup failure may decline authority and retain the prior
capture route. Once execution starts, a thrown/failed capture is never retried.
The helper does not change CSP, launch flags, animation scheduling or network
policy.

The private plain-data codec covers CaptureScriptArgs/CapturedTree: own
undefined, null, nonfinite numbers, negative zero, Unicode, plain objects,
arrays, aliases and cycles. Sparse holes become own undefined entries and
`__proto__` is omitted, matching Playwright1.59.1. Other dynamic keys use safe own
data properties. The iterative graph walk adds no arbitrary captured-tree cap.
Functions, DOM nodes, Date/RegExp/Map/Set and other exotic objects are explicitly
outside this private data contract. This is not a replacement for general
Page.evaluate. Native parity includes the actual ordinary CAPTURE_SCRIPT and a
50-level plain graph. A separate baseline-only investigation found the existing
Page.evaluate stalls at a 100-level graph; no helper failure or new limit is
inferred from that experiment.

The strict 32-case native file is `tests/author-shadow-context.e2e.test.ts`.
It exercises actual open/closed slots, clone/foreign Elements, sticky adoption,
transient events, source immutability, independent probe cleanup, options
aliasing, navigation, source CSP/errors and both transports. Focused unit tests
cover never-reply detach, late original cleanup, failed attempted groups and
codec validation. Native JSON/PNG evidence lives under
`author-shadow-context/` in the platform output root, with exact source SHA,
runtime, LF-normalized source hashes and original synthetic source PNGs. A
focused native pass cannot replace full shipping CI or platform-native evidence.

Source authority: Chromium147 inspector
[`getDocument`/`DiscardFrontendBindings` and `describeNode`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/inspector/inspector_dom_agent.cc),
[DOM public protocol](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/public/devtools_protocol/domains/DOM.pdl),
and its pinned V8
[`ensureContext`/`callFunctionOn` object-context correlation](https://chromium.googlesource.com/v8/v8/+/e92be92d2c1537d41acb9d82bacf3c1c19e93ff9/src/inspector/v8-runtime-agent-impl.cc).
These exact runtime-source revisions are distinct from the repository's
materialized Chromium7d859f27 subset. Installed Playwright1.59.1 serializers and
Chromium execution-context flags supply the existing transport comparison;
production imports and patches none of those private modules.
