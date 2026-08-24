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

Domotion's current `rasterizeReplacedElements()` correctly asks Chromium to
screenshot the isolated `<canvas>`, `<video>`, inaccessible `<iframe>`,
`<object>`, or `<embed>` surface and embeds those bytes as a static SVG
`<image>`. The DM-2542 headless discriminator captures an unchanged canvas
twice byte-identically and requires a deliberate frame mutation to change the
snapshot. That proves snapshot ownership, not playback synchronization.

## Deterministic contract

Before a future multi-media transaction may be called deterministic it must:

1. wait for image decode and video seek completion (`loadeddata`/`seeked` plus a
   presented-video-frame callback where available);
2. freeze page animation/rAF and media time before the capture prepasses;
3. record media kind, ready state, requested/current media time, dimensions and
   a digest of the exact captured bytes;
4. capture every replaced surface inside one validated frame epoch and reject
   navigation, decode, seek, canvas mutation, or compositor-frame drift;
5. reverify the same facts after screenshots before restoring the page.

Animated image decoder time is not controllable through the existing page
clock, and a playing video may submit a new compositor frame between DOM facts
and screenshot. Current production therefore remains an observational frozen
snapshot for those inputs; callers needing determinism must pause/seek or supply
a static poster/frame themselves.

## Explicitly unsupported

Post-capture video playback, animated-image continuation, live canvas mutation,
media-driven CSS/JS effects, audio, controls and decoder timing are unsupported
inside the self-contained SVG. Preserving them would require embedding an
uncontrolled decoder/runtime, contradicting the deterministic self-contained
output contract, so no playback feature ticket is warranted.
