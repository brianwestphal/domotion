# Authenticated animated-image encoded-byte ownership

DM-2578 is a source-first design investigation. It adds no production capture
behavior, decoder runtime, or visual tolerance. All findings are pinned to
Chromium revision `7d859f271cbda744098ac69f44978d4edfa62be3`.

## Decision

Blink retains the exact encoded entity bytes selected for an image in the
owner's `ImageResourceContent`. Chromium DevTools can return those same bytes
through `Network.getResponseBody(requestId)` because the inspector keeps a weak
reference to the exact `Resource` and, for binary resources, base64-encodes its
`ResourceBuffer`. That is the preferred body transport for HTTP(S): it joins
the browser's completed response and does not issue a second request.

The transport is not, by itself, an ownership or security proof. Public CDP
does not expose a general relation from an element, pseudo, or CSS layer to the
`ImageResourceContent*` it selected, and debugger privilege can read a
cross-origin no-CORS body that page script could not read. URL equality is
insufficient when a URL is redirected, revalidated, intercepted by a service
worker, reused from memory cache, requested more than once, or retained by a
stale owner.

The strict design therefore has two independent requirements:

1. authenticate the exact owner/slot -> `ImageResourceContent` -> `Resource`
   -> inspector request relation before and after body collection; and
2. authorize byte release from Blink's actual origin-clean/CORS result, never
   from CDP body availability, response headers alone, or an independent
   refetch.

A pinned renderer-side truth helper is required as the investigation oracle
for that relation. A stock-CDP implementation may ship only the subset whose
public join is proven equivalent by the oracle. Every ambiguous route remains
explicitly unsupported and fails closed only when a strict frame selector is
present. Legacy capture remains byte-for-byte behaviorally unchanged when the
selector is absent.

## Source-owned bytes

All requested image consumers converge on one Blink object graph:

```text
owner and exact slot
  -> ImageLoader or selected StyleImage
  -> ImageResourceContent
  -> ImageResource / Resource
  -> ResourceBuffer (encoded entity body)
  -> inspector request id
  -> Network.getResponseBody(requestId)
```

The source establishes each edge:

- `core/loader/resource/image_resource_content.cc:122-130` fetches an
  `ImageResource` and returns that resource's `ImageResourceContent`.
- `core/loader/resource/image_resource.cc:288-317` sends an image-context
  request through `ResourceFetcher::RequestResource`.
- `image_resource.cc:557-591` transfers a completed non-multipart response into
  the image and clears the duplicate resource buffer only because the same
  encoded data remains available through `Image::Data()`.
- `image_resource_content.cc:316-319` returns that exact image data as
  `ResourceBuffer`; `image_resource.cc:434-437` delegates to it after the
  resource's transient buffer has been cleared.
- `platform/loader/fetch/resource_fetcher.cc:1380-1386` assigns an inspector
  identifier to each request. `platform/loader/fetch/resource.h:192` exposes
  the retained resource identifier. For memory-cache reuse, the resource's
  identifier can differ from a newly proposed local identifier
  (`resource_fetcher.cc:1655-1660`), which is why a URL/local-request join is
  not authoritative.
- `core/inspector/inspector_network_agent.cc:1638-1705` associates the inspector
  request id with the exact cached `Resource`, response, loader id, and frame
  id. A 304 reports retained encoded size rather than a new body.
- `core/inspector/network_resources_data.cc:142-171,323-355` weakly retains that
  resource and snapshots its buffer if the resource dies, subject to explicit
  inspector buffer limits.
- `core/inspector/inspector_network_agent.cc:2767-2796` services
  `Network.getResponseBody` from saved content or the exact cached resource.
  `core/inspector/inspector_page_agent.cc:371-394` base64-encodes non-text
  `ResourceBuffer` bytes without text decoding.
- `public/devtools_protocol/domains/Network.pdl:1167-1176,1377-1403,
  1448-1515` defines
  `requestWillBeSent`, `responseReceived`, `loadingFinished`,
  `requestServedFromCache`, and `getResponseBody`. `loadingFinished`'s
  `encodedDataLength` is transfer/wire accounting; it is not the decoded entity
  body's byte length and must never substitute for the collected buffer length.

`Fetch.getResponseBody` at response interception is not selected: interception
changes request lifetime, redirect bodies are unavailable, and stream capture
can consume a response that then has to be fulfilled or cancelled. Page-side
`fetch()`, XHR, CacheStorage reads, and Node HTTP clients are also rejected for
HTTP(S), because each can select a different redirect, credential state, cache
entry, service-worker version, or server response. `Page.getResourceContent`
and Resource Timing remain URL-indexed and cannot authenticate the owner edge.
Screenshots prove painted pixels, not the encoded bytes needed by WebCodecs.

## Owner and slot routes

The record identifies an owner structurally, not through an author id or URL.
Every row below ultimately retains one `ImageResourceContent`; generated
images such as gradients, cross-fades, paint worklets, and element snapshots do
not and are outside the encoded-image selector.

| Consumer | Blink-selected owner | Exact slot identity | Selection fact |
| --- | --- | --- | --- |
| `<img>` / `<picture>` | `HTMLImageElement` -> `HTMLImageLoader` -> `ImageLoader::GetContent()` | element backend node, `html-current` | `HTMLImageElement::FindBestFitImageFromPictureParent` and `SelectSourceURL` select source/type/media/srcset; `currentSrc()` returns the current content URL (`html_image_element.cc:475-514,734-750,1002-1029`). |
| SVG `<image>` | `SVGImageElement` -> `SVGImageLoader`, a common `ImageLoader` route | SVG element backend node, `svg-href` | `svg_image_element.cc:69,121-150,172-179` owns the loader and reloads on href, CORS, or document changes. |
| `<input type=image>` | `HTMLInputElement` -> `HTMLImageLoader` | input backend node, `input-src` | `image_input_type.cc:125-146` updates the loader on `src` and layout attachment. There is no `currentSrc`; the loader content URL is authoritative. |
| `background-image` / `image-set()` | computed `FillLayer` -> selected `StyleImage` / `StyleImageSet` -> `StyleFetchedImage` | backend node or pseudo node, property, ordered layer index, selected image-set option | `css_image_set_value.cc:46-105,118-122` removes unsupported types, de-duplicates resolutions, and selects the first adequate or highest option. The retained selected `StyleImage`, not computed CSS text, owns the candidate. |
| generated `content` image | `ContentData` chain -> `ImageContentData` -> selected `StyleImage` | host and pseudo identity plus ordered content-item index | `longhands_custom.cc:3267-3291` creates one image item; `content_data.h:108-166` retains its exact `StyleImage`. |
| `list-style-image` | computed style -> selected `StyleImage` | list owner/marker identity, `list-style-image`, item 0 | `longhands_custom.cc:6640-6645` stores the selected style image. |
| `border-image-source` | `NinePieceImage` -> selected `StyleImage` | backend node or pseudo, `border-image-source`, item 0 | `longhands_custom.cc:1547-1552` stores the selected source. Slice geometry belongs to later PNG substitution, not byte acquisition. |
| `mask-image` | ordered mask `FillLayer` -> selected `StyleImage` | backend node or pseudo, property, ordered layer index | `element_style_resources.cc:491-500` loads non-SVG mask sources with anonymous CORS and retains each selected layer. |

`core/css/css_image_value.cc:51-130` constructs the resource request and wraps
the returned `ImageResourceContent` in `StyleFetchedImage`.
`core/css/style_image_cache.cc:24-37` may share one content pointer for the same
fragment-stripped URL within a document. `core/style/style_fetched_image.h`
and `.cc` retain that pointer; `core/style/style_image_set.cc` forwards the
selected option's content. `core/css/resolver/element_style_resources.cc:417-500`
then installs ordered background, content, list, border, and mask images into
computed style. Sharing is valid, but it makes URL-only owner correlation even
less meaningful.

### Document, shadow, and pseudo identity

An exact owner key is:

```text
targetId / frameId / documentLoaderId / documentNonce
  + backendNodeId
  + shadow-host backendNodeId chain and shadow-root type
  + pseudo backendNodeId and pseudo type, when present
  + property and ordered layer/item index
```

The document nonce is installed before navigation in every new document and is
paired with `Page.getFrameTree` loader identity. A light-DOM element, an open or
closed shadow-tree element, and a generated pseudo may have identical selectors
and CSS; their backend-node/tree-scope paths remain distinct. For generated
content the host and pseudo identities are both retained. When CDP does not
materialize an exact pseudo or closed-shadow owner, the strict route is
unavailable rather than inferred from a selector.

Backend node ids are never accepted across a changed loader/document nonce.
Responsive selection also binds viewport, DPR, sizes/media results, selected
candidate URL, `currentSrc` where defined, and the exact content/resource
relation. `image_loader.cc:595-597,646-723` shows that relevant mutations can
replace or clear the loader's content pointer asynchronously; equality of the
eventual URL does not preserve owner epoch.

## Security boundary

The security predicate comes from the selected resource, not the inspector:

- `image_loader.cc:337-346` applies an element's `crossorigin` state.
- `platform/loader/fetch/fetch_parameters.cc:54-87` maps anonymous to CORS with
  same-origin credentials and `use-credentials` to CORS with included
  credentials.
- `css_image_value.cc:87-107` applies property/URL-modifier CORS and tracks an
  origin-dirty stylesheet. Most ordinary CSS images default to no-CORS;
  `mask-image` is loaded anonymous-CORS as noted above.
- `image_resource_content.cc:660-664` requires both one image security origin
  and `ImageResourceInfo::IsCorsSameOrigin`.
- `image_resource.cc:689-696` delegates that decision to the selected
  `ResourceResponse`; `platform/loader/fetch/resource_response.cc:254-259`
  derives it from the Fetch response type.

The strict authorization rule is exactly `ImageResourceContent::IsCorsSameOrigin()`
for the bound content, plus an unchanged document/owner epoch. It accepts a
same-origin response and a successfully CORS-approved anonymous or credentialed
response. It rejects opaque/no-CORS cross-origin responses, failed CORS,
multiple-security-origin images, missing request/credential facts, and any
redirect whose effective response is not CORS-same-origin. Header inspection
alone is insufficient: wildcard origin, credentials, redirect hops, and a
service-worker-produced response all affect the Fetch response type.

`Network.getResponseBody` is a debugger capability and can still return bytes
when this predicate is false. The collector may hash such a body inside the
trusted capture process for a negative probe, but it must discard it immediately
and must never attach it to a result, error, log, fixture, or SVG. A production
record carries only the denial code and non-sensitive request identity in that
case.

No new request means the selected load's CSP, mixed-content, CORP, COEP, client
certificates, cookies, and service-worker policy are not bypassed. The design
does not relax browser launch flags or disable web security.

## Response, redirect, cache, and service-worker identity

`platform/loader/fetch/resource.cc:573-605` retains the ordered redirect chain
on the exact resource. `resource.cc:1032-1055` folds a successful 304 into the
cached response while retaining its body and requires the current URL to match.
`resource_response.h:99-130` distinguishes current request URL from response
URL; they can differ for service workers. `resource_response.cc:137-166` uses
the service-worker URL list for response URL. `resource_response.h:227-280,
648-665` retains service-worker source/router information, Fetch response type,
URL list, CacheStorage name, response time, and original response time.

Accordingly, `currentSrc`/selected URL, last request URL, and response URL are
three separate fields. The record keeps every redirect hop and the final CDP
response, including disk/memory cache and service-worker facts. A stable cached
or service-worker response is supported when it is already settled before
preflight and the exact content/resource/body/security facts are unchanged.
Revalidation, redirect change, controller/version change, CacheStorage entry
replacement, or response movement between preflight and reverify fails closed
even if the visible URL or pixels remain the same.

`multipart/x-mixed-replace` is unsupported. `image_resource.cc:609-618,
652-686` repeatedly replaces the image buffer for multipart parts, so there is
no single immutable animated-image entity to bind.

## Exact record

The future collector emits one immutable record per unique owner slot. Fields
marked `oracle` are required in the pinned truth helper and must either be
source-proven by the public adjudicator or make the production route
unavailable.

```ts
interface AnimatedImageByteOwnershipRecord {
  protocol: "domotion-animated-image-bytes-v1";
  chromiumRevision: "7d859f271cbda744098ac69f44978d4edfa62be3";
  strictRequest: {
    ownerSelectorToken: string;
    requestedFrameIndex: number;
    limitsFingerprint: string;
  };
  document: {
    targetId: string;
    frameId: string;
    documentLoaderId: string;
    documentNonce: string;
    url: string;
    origin: string;
    navigationSequence: number;
  };
  owner: {
    kind: "html-image" | "svg-image" | "image-input" | "css-image";
    backendNodeId: number;
    shadowHostBackendNodeIds: number[];
    shadowRootTypes: Array<"user-agent" | "open" | "closed">;
    pseudo: null | { backendNodeId: number; type: string };
    slot: {
      property: "html-current" | "svg-href" | "input-src" |
        "background-image" | "content" | "list-style-image" |
        "border-image-source" | "mask-image";
      index: number;
      imageSetOptionIndex: number | null;
    };
    currentSrc: string | null;
    selectedResourceUrl: string;
    candidateFactsSha256: string;
    devicePixelRatio: number;
    viewportSha256: string;
  };
  resource: {
    contentLogicalId: string;       // oracle: stable only within transaction
    resourceLogicalId: string;      // oracle: stable only within transaction
    inspectorRequestId: string;
    requestLoaderId: string;
    requestFrameId: string;
    requestMode: string;
    credentialsMode: string;
    redirects: Array<{
      requestUrl: string;
      responseUrl: string;
      status: number;
      responseTime: number;
    }>;
    currentRequestUrl: string;
    responseUrl: string;
    status: number;
    mimeType: string;
    rawContentType: string | null;
    fetchResponseType: string;      // oracle/security authority
    corsSameOrigin: true;           // oracle/security authority
    fromDiskCache: boolean;
    fromMemoryCache: boolean;
    fromServiceWorker: boolean;
    serviceWorkerResponseSource: string | null;
    serviceWorkerRouterSha256: string | null;
    serviceWorkerUrlList: string[];
    cacheStorageCacheName: string | null;
    responseTime: number;
    originalResponseTime: number;
    revalidationCount: number;
    lastRevalidationStatus: number | null;
    networkEncodedDataLength: number; // wire metric, never body identity
  };
  body: {
    transport: "network-get-response-body" | "data-url" | "blob-read";
    base64EncodedByProtocol: boolean;
    byteLength: number;
    sha256: string;
    networkLoadingFinished: true | null; // true for HTTP(S), null for data/blob
  };
  epochs: {
    preflightSha256: string;
    postflightSha256: string;
    resourceResponseSequence: number;
    collectedAtMonotonicMs: number;
  };
}
```

The exact transaction digest covers every field except collection time. The
preflight and postflight digests must match exactly. `body.byteLength` is the
decoded response entity length fed to the image decoder, not Content-Length,
compressed transfer length, or `loadingFinished.encodedDataLength`. The body
SHA is computed only after base64 decoding, and is recomputed before WebCodecs
consumes a copy.

Records are deduplicated only after owner records are complete: two slots may
share a request/body digest but retain different owner/slot keys and requested
frame indices.

## Acquisition transaction

1. Before navigation, attach the CDP Network ledger, choose fixed inspector
   body-buffer limits, install a per-document nonce in every new document, and
   record target/frame loader epochs. Missing early events are fatal to the
   strict route.
2. After normal image settling, enumerate only explicitly requested owners.
   Resolve exact backend/shadow/pseudo/slot identity and snapshot selection,
   style, viewport, DPR, and document facts.
3. The pinned truth helper snapshots the selected
   `ImageResourceContent`/`Resource`, inspector id, response/security/cache/SW
   facts, and exact `ResourceBuffer` digest. The public collector identifies a
   request only through a join shape already proven equivalent by that helper;
   it never joins by URL alone.
4. Require a completed successful image response, a supported raster MIME, and
   `corsSameOrigin === true`. Reject multipart and generated images. For an
   unauthorized resource, discard any inspector body without reporting its
   length or digest outside trusted negative-test output.
5. For HTTP(S), call `Network.getResponseBody` for the authenticated request id
   after `loadingFinished`, decode its declared representation once, and bind
   exact length/SHA. Body eviction or missing content fails closed; there is no
   fallback request.
6. For a selected `data:` URL, parse the URL itself into bytes with one pinned
   Fetch-compatible parser and compare its length/SHA with the oracle resource
   buffer. For a same-partition `blob:` URL, read the immutable Blob in its
   owning document realm, bind URL/origin/document epoch, and hash twice. A
   revoked, inaccessible, moved, or changed blob owner fails closed. A blob
   read is never used for HTTP(S).
7. Re-enumerate the owner and repeat the private/public resource snapshot after
   body collection. Require exact owner, candidate, resource pointer/id,
   request, redirects, response, cache/SW, revalidation, CORS, body, and
   document equality. Release all temporary body copies on failure.
8. Only the later static-frame transaction may pass authenticated bytes to
   `ImageDecoder`; it must revalidate this record again before substituting its
   PNG. This investigation does not implement that behavior.

Implementations must use fixed, recorded resource-count, body-size,
transaction-total, redirect-count, and inspector-buffer ceilings. Crossing a
ceiling is an explicit operational failure, never truncation. The follow-up
evidence ticket owns ratifying the constants against repository capture limits;
they are not visual tolerances.

## Bounded support matrix

| Case | Intended strict status | Required proof |
| --- | --- | --- |
| Same-origin HTTP(S) GIF/APNG/WebP, settled before preflight | eligible | exact owner/resource/request join, successful final response, origin-clean resource, stable body SHA |
| Cross-origin HTTP(S) with successful anonymous or credentialed CORS | eligible only where the oracle proves the public join and actual `corsSameOrigin` fact | request mode/credentials, Fetch response type, redirect result, single security origin, stable body |
| Cross-origin no-CORS image that paints successfully | rejected | `corsSameOrigin` is false; CDP body availability is ignored |
| CORS-denied or credential-mismatched response | rejected | load/error response and CORS failure are retained without body disclosure |
| Stable redirect, memory/disk cache hit, 304, or service-worker/CacheStorage response | eligible after settlement | full hop/response/SW/cache/revalidation record and exact pre/post identity |
| Revalidation, redirect, SW controller/version, router, or cache entry changes during transaction | rejected | response/resource epoch drift |
| Selected `data:` GIF/APNG/WebP | eligible | exact selected URL parsing matches resource-buffer length/SHA |
| Same-partition live `blob:` GIF/APNG/WebP | eligible when immutable blob read and oracle digest agree | blob URL/origin/document and double hash remain exact |
| Revoked/inaccessible blob, opaque document origin, or unsupported scheme | rejected | no exact authorized byte transport |
| Responsive `<picture>`/srcset or CSS `image-set()` | eligible only after selection settles | chosen candidate/content pointer and DPR/viewport/source facts remain exact |
| Multiple requests for the same URL, ambiguous memory-cache reuse, or missing early Network events | rejected unless the exact pointer/request relation is privately/publicly proven | URL equality never disambiguates |
| CSS gradients, cross-fade, paint worklet, element image, outer SVG document, broken/placeholder/loading image | rejected | no supported GIF/APNG/WebP encoded-resource owner |
| `multipart/x-mixed-replace` | rejected | mutable part buffer has no single entity epoch |
| Animated-image live playback or continuation | out of scope | the output remains one authenticated static PNG |

The first production increment should be narrower than this design matrix:
`<img>/<picture>` and `<input type=image>` routes whose owner/request/security
joins pass the evidence gate. SVG and every CSS slot remain on their dedicated
extension ticket. A CORS-approved row is not enabled merely because it is
listed here; it needs an exact exposed/proven `corsSameOrigin` fact.

### Fail-closed reasons

The logical API uses stable reason codes, including:

`strict-owner-not-found`, `owner-detached`, `unsupported-owner`,
`unsupported-slot`, `pseudo-or-shadow-owner-unavailable`, `stale-document`,
`navigation-drift`, `candidate-pending`, `candidate-drift`,
`ambiguous-resource`, `missing-request-ledger`, `request-drift`,
`redirect-drift`, `response-drift`, `revalidation-in-flight`,
`service-worker-drift`, `cache-entry-drift`, `body-evicted`,
`body-limit-exceeded`, `body-length-mismatch`, `body-digest-mismatch`,
`cors-denied`, `opaque-response`, `credential-mode-mismatch`,
`multiple-security-origins`, `unsupported-mime`, `mime-mismatch`,
`multipart-response`, `data-url-parse-failed`, `blob-unavailable`, and
`unsupported-scheme`.

Errors never contain rejected cross-origin body bytes or their digest. Strict
failure never falls back to compositor current frame, default frame zero,
another decoder, or legacy output. With no strict selector, none of this
collection runs.

## Source-linked logical probe plan

These are exact logical probes for the implementation tickets. They compare
records and digests; they do not use a raster tolerance.

| Probe | Source fact exercised | Required discrimination |
| --- | --- | --- |
| `<picture>`/srcset candidate mutation | `html_image_element.cc:475-514,1002-1029`; `image_loader.cc:595-597,646-723` | change media, sizes, DPR, source order, or srcset after preflight; reject changed candidate/content/request even if final URL or pixels match |
| CSS `image-set()` and layer/item mutation | `css_image_set_value.cc:46-105`; `element_style_resources.cc:417-500`; `content_data.h:108-166` | reorder equal-resolution options, background/mask layers, or generated-content items; reject wrong selected `StyleImage` or slot while unchanged siblings remain stable |
| Same selected URL with redirect/response drift | `resource.cc:573-605`; `resource_response.h:99-130` | keep owner URL fixed while redirect destination, status, response URL, MIME, or bytes change; reject hop/request/response/SHA drift |
| Settled 304 versus active revalidation | `resource.cc:1032-1055`; `inspector_network_agent.cc:1698-1705` | accept a fully settled 304 retaining exact body and recorded epoch; force a revalidation between pre/post and reject it even if SHA is unchanged |
| Service-worker/cache replacement | `resource_response.cc:137-166`; `resource_response.h:227-280,648-665` | same URL switches SW source/router/URL list/CacheStorage entry or cached body; reject metadata, resource, or SHA drift |
| Cross-origin body disclosure control | `image_resource_content.cc:660-664`; `image_resource.cc:689-696`; `inspector_network_agent.cc:2767-2796` | prove CDP can hold a no-CORS body but the authorization gate emits only `cors-denied`; accept only actual CORS-same-origin anonymous/credentialed controls |
| Same-URL competing owners/cache reuse | `resource_fetcher.cc:1655-1660`; `style_image_cache.cc:24-37` | create repeated requests and shared CSS content; accept a shared exact resource but reject an unproven request-id choice |
| Stale element/document reuse | `svg_image_element.cc:176-179` and loader/document ownership | navigate or adopt/recreate an identical owner with the same selector/URL; reject loader/document nonce or backend/tree-scope drift |
| Pseudo/shadow slot collision | `longhands_custom.cc:3267-3291`; `content_data.h:108-166` | use identical URLs in light DOM, closed shadow, `::before`, and `::after`; mutate one item and require only its exact host/pseudo/slot record to move |
| Data/blob lifecycle | exact selected resource-buffer relation above | mutate data payload, replace blob URL, revoke blob, or navigate owning document; accept only exact parser/blob/oracle digest agreement |
| Body storage loss and bounds | `network_resources_data.cc:125-180,323-355` | force inspector eviction or configured count/byte ceiling; reject rather than refetch or truncate |

Every browser arm in those tickets must launch Chromium with explicit
`headless: true`. Proposal and validation arms use fresh contexts/decoders and
retain source revision, browser version, OS/arch, request ledger, logical
records, and mutation results. Sensitive denied bodies are never artifacts.

## Implemented private-oracle evidence

DM-2583 implements this investigation oracle as an evidence-only private
Chromium patch; it does not put patched Chromium on Domotion's production
runtime path. The reproducible 26-file patch is
`tools/animated-image-owner-resource-truth-chromium.patch` (file SHA-256
`3665513738fd42e310ec382c2087949927c805abeab4b0da2bd9e07213f51afa`). It
applies cleanly to the pinned revision above. Its normalized source patch
identity is
`93e150ec097a69dd4ef923bc223570ca7da3c647526cf147b1b3c3b1170e174f`;
the reopened source-manifest identity is
`3dc66cab6e2982a336eb275cc808a260b590b535ed304a0701c43350f3b838cd`.

The private `DomotionAnimatedImageTruth` renderer domain is excluded from
untrusted DevTools clients. It resolves the exact owner and slot directly to
`ImageResourceContent` and its `Resource`, then requires that exact pointer in
the inspector request ledger. Its response, redirect, cache, active/settled
revalidation, service-worker/router, CORS, single-origin, and `ResourceBuffer`
facts are bounded and snapshotted before and after public-body collection.
Only an authorized unchanged record carries body length/SHA. Every denial is
constructed before body serialization and has an exact safe structural key
set; even a debugger-readable no-CORS body is discarded without its bytes,
length, digest, URL query, protocol payload, or error entering an artifact.

The stable evidence surface is split deliberately:

- `tools/animated-image-owner-resource-truth-schema.ts` owns schema SHA-256
  `52969c415240f444dde400e0bd6920f0aee0ff2c68787a4edfe204b8c958b2c5`,
  22 source-linked probes, 38 exact cases, strict redaction, logical
  normalization, and the six-artifact adjudicator;
- the probes and fixture server retain source references and exercise every
  HTML, SVG, input, CSS layer/item, image-set, generated-pseudo, closed-shadow,
  cache, redirect, revalidation, service-worker, CORS, data/blob, multipart,
  adoption, detachment, DPR, and stale-navigation route required above;
- the collector has one browser launch site, always passes `headless: true`,
  uses hard timeouts for private calls and teardown, authenticates live browser
  and renderer executable/library mappings, and serializes only rows that pass
  the exact schema; and
- the adjudicator reopens and hashes each complete input file, checks fresh
  proposal/validation build/process/context independence on every OS, compares
  the normalized logical digest exactly, and self-hashes its sorted report.

The first retained macOS proposal contains all 38 rows (20 authorized and 18
body-free denied) with normalized logical SHA-256
`2af7b4b95aeac7f8bd94c2f619e7b2bbdbb9c7c676a54f0ea8b4e63940eade5a`.
Its artifact SHA-256 is
`53e7a5f8bf43d47545bcf13a5a930a1fbca25e69fdeb6a04143d4eb6f278d61e`.
The independently rebuilt macOS validation arm contains the same 38 rows and
20/18 authorization split, with distinct build, process, observation, and
browser-context provenance. Its artifact SHA-256 is
`e8333f8e2d19d9cff00eba6e0a4a894f72edc9db48cc935f3ea9a06153c96f08`,
and it reopens to the same normalized logical SHA-256 above.

The retained macOS two-arm adjudication file SHA-256 is
`0d4ce53fa5e5730b5138a75bed4496c7741f51b9b507491aabc7b9c5eb513f26`;
its canonical report self-hash is
`6cc9deb0697a4d865b742228b83e4a479279c5c69dab8cff3d3261f41d38706d`.
DM-2589 additionally retains independent Linux x64 proposal and validation
arms with artifact SHA-256 identities
`1218ffadfaed3d1272a79b5681d47f0d4283c5ff4293eae5138d9e813594964b` and
`51f0455203bb8e5497ed59f4946c6ff651cc015338d0cb84554960294d407f0a`.
Each contains the same 38 rows, 20/18 authorization split, explicit-headless
launch authority, body-free denied envelopes, and normalized logical SHA-256
above, with distinct build, process, observation, and browser-context
provenance. A fail-closed four-artifact macOS/Linux adjudication has zero
failures and report self-hash
`5be4a89902b2eeccd605226dce912be12c83db22e57567a09c63794852dddb38`.
The global verdict remains withheld for exactly two absent artifacts: Windows
proposal and validation, now owned by DM-2590. The four retained arms are a
private logical evidence checkpoint, not authorization for the stock-CDP or
production collectors and not a partial-platform global verdict.

## Implemented stock-CDP support adjudication

The evidence-only stock-CDP adjudicator is
`tools/animated-image-stock-cdp-support.ts`. It reopens the retained four-arm
macOS/Linux adjudication by exact input-file identity and report self-hash,
then publishes a 38-case supported/denied/unsupported matrix. The accepted
interim matrix SHA-256 is
`7c7f3087c909686030efb0760dfd399043d66587021a268b1c33735aae88e9a6`.
Windows remains expressly withheld; this is not a three-platform verdict.

The smallest production-eligible network subset is same-origin HTTP(S)
`<img>`, `<picture>`, and `<input type=image>` with a settled GIF, APNG, or
animated WebP response. The ledger must be attached before navigation and
must contain exactly one request matching the selected URL, frame, and
document loader. Backend owner/slot, document nonce, responsive candidate,
DPR, viewport, redirect chain, response, and decoded entity length/SHA-256
must be identical before and after `Network.getResponseBody`. A redirect is
eligible only when every hop is settled and same-origin.

This uniqueness requirement closes the public-protocol gap conservatively.
`DOM.pdl:95-180` exposes backend node, shadow, and pseudo structure but no
`Network.RequestId`; `Network.pdl:445-487,1167-1176,1377-1515` exposes the
request/frame/loader ledger and exact response body but no selected
`ImageResourceContent*`. The join therefore rejects repeated same-URL owners
or shared resources instead of treating URL equality as authority.

The retained `data:` and same-partition `blob:` positives ratify only ordinary
HTML `<img>` owners: parse the selected data URL once and hash twice, or read
the blob in its owning document realm and double-hash it. Cross-origin CORS
success, memory/disk-cache and settled-304 responses, service-worker or
CacheStorage responses, SVG images, CSS layers/items, generated pseudos, and
closed-shadow pseudos remain unsupported by stock CDP in this increment.
Their private-truth positives do not expose enough public ownership or
authorization state to make them safe. CORS/no-CORS failures, active
revalidation, multipart responses, candidate mutation, and stale-document
controls remain explicit body-free denials.

The eligible retained positive cases are the stable HTML WebP and APNG rows,
the settled same-origin redirect row, the stable HTML data/blob rows, and the
stable image-input row. The existing private-truth schema already requires
each retained public body to equal the private `ResourceBuffer` in transport,
decoded byte length, and SHA-256, and requires every denied or mutated row to
retain no public body facts. DM-2585 may implement only this bounded subset;
broader routes require new public evidence rather than a relaxed join.

## Follow-up ownership

The implementation sequence is deliberately split:

1. build the pinned private owner/resource/security truth helper and source-
   linked mutation oracle;
2. build and gate the stock-CDP response ledger/adjudicator against that helper,
   publishing the exact public support subset;
3. implement the production authenticated byte collector only for that subset,
   with data/blob transports and legacy no-option behavior unchanged;
4. implement the existing strict WebCodecs static-frame transaction, then its
   downstream resize/SVG ownership, CSS/SVG extension, and native release gate.

Until all prerequisite gates land, arbitrary animated-image frame selection is
unsupported production behavior. This design does not authorize a patched
browser as a silent runtime dependency: if stock Chromium cannot expose/prove
one route, that route stays unavailable or requires an explicit separately
reviewed transport decision.
