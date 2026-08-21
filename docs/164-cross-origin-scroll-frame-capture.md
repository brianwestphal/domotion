# 164 — Cross-origin iframe recursion during scroll capture

Scroll capture now passes `ScrollExecutorOptions.crossOriginFrames` into every segment's ordinary or self-contained `captureElementTree` call. The CLI supplies the same value used to build `crossOriginFramesLaunchArgs`, so the launch-time web-security opt-in and the per-host recursion gate cannot diverge between static and scroll modes.

The browser test uses separate localhost origins and two scroll anchors. An allowlisted frame remains native, retains its inner text, moves by the exact 40px viewport offset, and has no duplicate captured IDs in either segment. A non-allowlisted host remains an isolated raster in both segments. The existing warning and trusted-page CLI notice are unchanged; no allowlist still means raster-only.
