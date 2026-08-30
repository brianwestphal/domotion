---
id: "requirements/live-replaced-media-frame-ownership"
title: "229 — Live replaced-media frame ownership"
kind: "contract"
status: "current"
owners: ["images-media"]
platforms: []
tickets: ["DM-2542"]
code: ["tools/animated-image-frame-selection-audit.ts"]
aliases: ["docs/229-live-replaced-media-frame-ownership.md","doc-229"]
---

# 229 — Live replaced-media frame ownership

DM-2542 defines the supported boundary as **one frozen Chromium-presented
frame**. Domotion does not claim to preserve playback after capture.

At Chromium revision `7d859f271c`, video presentation is compositor-owned:
`VideoFrameSubmitter` obtains the provider's current frame on begin-frame and
submits it as compositor resources. Canvas snapshots materialize the current
surface through `CanvasSnapshotInfo`; video-to-canvas conversion consumes one
concrete `media::VideoFrame`. Animated bitmap images keep decoder animation
state in `BitmapImage`, with page policy able to disable or limit animation.
These are three different clocks and there is no DOM scalar whose value proves
that all three surfaces belong to one compositor presentation.

Domotion's `rasterizeReplacedElements()` asks Chromium to screenshot the
isolated `<canvas>`, `<video>`, inaccessible `<iframe>`, `<object>`, or
`<embed>` surface and embeds those bytes as a static SVG `<image>`. The
headless frozen-frame discriminator captures an unchanged canvas twice
byte-identically and requires a deliberate frame mutation to change the
snapshot. That proves snapshot ownership, not playback synchronization.

Chromium's source makes the ownership boundary explicit. At revision
`7d859f271c`, `video_frame_submitter.cc:531-572` updates and obtains exactly one
provider frame on a compositor begin-frame, submits it, and calls
`PutCurrentFrame()` immediately so a later begin-frame cannot be mistaken for
the submitted one. `video_frame_submitter.cc:782-785` refuses to submit the
same unique frame twice. Canvas snapshot materialization retains exact
size/alpha/color/HDR/format facts in `canvas_snapshot_info.h:19-37`; it is not a
DOM clock. Domotion therefore authenticates the presented/snapshotted surface
instead of deriving either one from playback time.

## Deterministic contract

An atomic transaction is active when `captureElementTree*()` receives both an
exact `animationTimeMs` and the opaque rAF handle installed by
`installCaptureRafClock()` **before navigation**. It performs the following
source-owned sequence:

1. require one exact page/rAF requested time, pause every visible video, wait
   for metadata, seek completion, `loadeddata`, and a concrete
   `requestVideoFrameCallback()` presentation;
2. require finite seekable video and origin-clean canvas readback, then record
   ready state, requested/current media time, CSS/intrinsic dimensions, current
   source, canvas surface bytes, and presented-frame metadata before any other
   capture prepass;
3. bind every live non-projective `replacedSnapshot` owner by element identity
   after the synchronous walk; any surface/fact movement since preflight fails
   rather than silently rebasing the epoch;
4. screenshot every bound owner through the existing isolated Chromium path,
   record a SHA-256 digest of each exact PNG, and reject missing owners or
   screenshots;
5. reverify the same element, decoder/seek state, current time, dimensions,
   canvas digest, video presented-frame epoch, document identity, and complete
   Playwright frame/URL set before attaching `replacedSnapshot.frameTransaction`;
6. restore the videos' prior time and paused/playing state in `finally`.

The capture result also returns `replacedMediaFrameState`, containing the
clock protocols, Chromium revision, document/frame identities, per-owner facts
and PNG digests, plus one digest over the validated global frame epoch. The
transaction rejects a caller-supplied `rasterizeFromImagePath`: bytes captured
outside this lifetime cannot authenticate the live owner state.

Captures without both clock authorities remain the backward-compatible
observational frozen snapshot and carry no deterministic frame record. Tainted
canvas readback, non-finite/non-seekable video, unavailable presented-frame
callbacks, and any hostile mutation fail closed only on the strict path; they
do not turn legacy capture into a hard failure. Animated-image decoder time is
not controllable through these clocks and remains outside the atomic path.

## Animated-image frame-selection investigation

Revision `7d859f271cbda744098ac69f44978d4edfa62be3` proves two distinct
ownership routes. The ordinary `<img>`/CSS image route does **not** expose an
arbitrary frame selector. `bitmap_image.cc:62-83` maps animation policy and the
CSS `image-animation` state to a repetition state; `bitmap_image.cc:146-180`
serializes a generator, repetition count, and timeline/reset identifiers into a
`PaintImage`, but no selected frame index. The shared/own timeline state machine
in `bitmap_image.cc:414-590` likewise manages running, paused, stopped, and
reset ownership rather than a caller-selected index. The compositor's
`ImageAnimationController` explicitly tracks the active/pending frame index and
advances it only when a sync tree is created
(`cc/trees/image_animation_controller.h:34-48` and
`cc/trees/image_animation_controller.cc:177-199,299-430`). Consequently,
pausing an `<img>` can retain a compositor-selected frame and stopping/default
policy can suppress continuation, but neither authenticates arbitrary frame
*N*. `BitmapImage::ImageForDefaultFrame()` merely disables repetition
(`bitmap_image.cc:597-614`); the normal generator backing uses default frame
index zero (`cc/paint/paint_image.cc:233-252`).

Blink nevertheless has a bounded, wall-clock-independent selector when the
caller owns the exact encoded bytes. The secure-context WebCodecs
`ImageDecoder` is exposed to Window and DedicatedWorker and accepts
`decode({ frameIndex, completeFramesOnly })`
(`modules/webcodecs/image_decoder.idl:7-24` and
`image_decode_options.idl:7-14`). The requested index is retained through the
external request queue (`image_decoder_external.cc:287-317,486-527`), checked
against `frameCount`, and passed unchanged to
`ImageDecoder::DecodeFrameBufferAtIndex()`
(`image_decoder_core.cc:295-375` and
`platform/image-decoders/image_decoder.cc:590-622`). A successful complete
decode is materialized as an immutable `SkImage`-backed `VideoFrame` with its
timestamp, duration, color space, and orientation
(`image_decoder_core.cc:398-440`); out-of-range requests become `RangeError`
(`image_decoder_external.cc:559-615`). The platform decoder keeps required
previous-frame/disposal dependencies while decoding the requested index
(`image_decoder.cc:672-713,770-901`). GIF and APNG use the shared Skia decoder,
which passes the exact frame index and prior-frame dependency to `SkCodec`
(`skia_image_decoder_base.cc:244-271,273-330,407-455`); animated WebP records
the frame rect, duration, disposal, blend, and required predecessor before its
indexed decode (`webp_image_decoder.cc:618-705`).

`tools/animated-image-frame-selection-audit.ts` is an investigation oracle for
that second route, not a production capture path. It embeds the exact pinned WPT
bytes for `red-green-animated.gif`, `apng.png`, and `webp-animated.webp` (235,
259, and 340 bytes; two, two, and three frames). An explicitly headless
Chromium run decodes each index twice in forward order on a fresh proposal
decoder and twice in reverse order on a fresh validation decoder. It requires
complete frames, exact raw-RGBA and PNG SHA-256 identity for every repeated
index, at least two distinct frame pixels per format, stable frame metadata,
and a `RangeError` activation control. All three formats passed with no raster
tolerance. This proves arbitrary **static** frame selection for exact bytes; it
does not prove live playback or ownership of bytes merely referenced by an
element.

### Recommended production boundary (not implemented)

Any production continuation should remain strict, explicit, and fail closed:

1. accept an opt-in nonnegative frame index for a bounded set of animated-image
   owners; legacy capture remains unchanged when the option is absent;
2. bind each request to Blink's selected `currentSrc` and authenticated encoded
   bytes, recording URL, MIME type, length, and SHA-256 before decoding;
3. create `ImageDecoder` with `preferAnimation: true`, await track readiness,
   and require a selected animated track, a stable bounded `frameCount`, and an
   in-range requested index;
4. decode exactly that index with `completeFramesOnly: true`, record track and
   `VideoFrame` metadata plus exact raw-RGBA/PNG digests, and repeat on a fresh
   decoder/control order before accepting the result;
5. replace the animated source in the captured tree with the authenticated
   static PNG and reverify element/source/byte identity before completion; and
6. reject unavailable or changed bytes, unsupported formats, CORS/security
   barriers, partial frames, index drift, decode mismatch, and post-bind source
   mutation. Never silently fall back to the compositor's current/default
   frame, another library's page-zero choice, or an animation runtime.

[Doc 231](231-authenticated-animated-image-byte-ownership.md) now defines that
source/security boundary. It proves that `Network.getResponseBody` can join the
exact Blink `ResourceBuffer` without refetching once the owner-to-resource
request relation is authenticated, but public CDP does not itself expose that
relation or authorize cross-origin bytes for every element/CSS owner. A pinned
private truth oracle, a source-gated public join, and the strict capture
transaction still have to be implemented and gated. Until then,
animated-image arbitrary-frame capture remains unsupported production
behavior.

## Explicitly unsupported

Post-capture video playback, animated-image continuation, live canvas mutation,
media-driven CSS/JS effects, audio, controls and decoder timing are unsupported
inside the self-contained SVG. Preserving them would require embedding an
uncontrolled decoder/runtime, contradicting the deterministic self-contained
output contract, so no playback feature ticket is warranted.
