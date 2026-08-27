# Opt-in authenticated animated-image byte collector

Status: implemented base-owner acquisition contract (DM-2585)

## Requirement

Domotion may acquire encoded GIF, APNG, or WebP bytes only when the caller
supplies a strict nonnegative frame request for an exact element selector.
Omitting the option preserves legacy capture: no CDP session, Network domain,
document nonce, byte record, warning, timing change, or new failure.

The first production increment covers `<img>` (including a `<picture>`-selected
`currentSrc`) and `<input type=image>`. SVG and CSS/pseudo/shadow image slots are
owned by DM-2581. The macOS/Linux stock-CDP gate in DM-2584 further limits this
increment to same-origin HTTP(S), settled same-origin redirects, ordinary
`data:` URLs, and same-partition `blob:` URLs. CORS, cache/revalidation,
service-worker/CacheStorage, repeated-URL ambiguity, multipart, and every
unratified route fail closed.

## Transaction

Before navigation the collector installs a per-document nonce and enables a
bounded Network ledger. After load it resolves exactly one requested owner,
records its backend node, frame, loader, nonce, owner kind/slot, selected URL,
DPR and viewport, and joins one completed response without matching URL alone:
the selected URL, frame and current document loader must identify one ledger
entry. HTTP(S) bytes come only from `Network.getResponseBody`; there is no
fetch, XHR, interception, CacheStorage read, or retry. `data:` parsing and a
double-read same-partition `blob:` transaction are separate transports.

The collector binds response URL/status/MIME/raw Content-Type, redirect hops,
request mode/credentials, byte length/SHA-256 and a preflight digest. It then
re-resolves the owner and document and requires the complete logical record to
match before returning an immutable byte copy. Fixed resource, per-body,
aggregate, and redirect ceilings fail rather than truncate. Errors expose only
stable reason codes; denied bytes, lengths, digests, URLs and protocol details
are not included.

This component acquires bytes only. It does not instantiate `ImageDecoder`,
select a frame, create PNG output, replace a source, retain playback, or change
visual tolerances.
