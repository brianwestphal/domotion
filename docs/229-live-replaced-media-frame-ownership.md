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

## Explicitly unsupported

Post-capture video playback, animated-image continuation, live canvas mutation,
media-driven CSS/JS effects, audio, controls and decoder timing are unsupported
inside the self-contained SVG. Preserving them would require embedding an
uncontrolled decoder/runtime, contradicting the deterministic self-contained
output contract, so no playback feature ticket is warranted.
