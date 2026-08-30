---
id: "requirements/pre-navigation-raf-capture-ownership"
title: "228 — Pre-navigation rAF capture ownership"
kind: "contract"
status: "current"
owners: ["rendering"]
platforms: ["macos","linux","windows"]
tickets: ["DM-2553","DM-2554"]
code: [".github/workflows/raf-clock-ownership.yml","tests/raf-clock.e2e.test.ts"]
aliases: ["docs/228-pre-navigation-raf-capture-ownership.md","doc-228"]
---

# 228 — Pre-navigation rAF capture ownership

**Ticket:** DM-2554

Domotion can now include Window `requestAnimationFrame` callbacks in an exact
animated capture without relying on Playwright's page-visible clock. Call
`installCaptureRafClock(context)` before creating/navigating the capture page,
then pass the returned `rafClock` together with `animationTimeMs`.

## Ownership boundary

The context init script replaces `requestAnimationFrame` before author script
runs and never publishes the saved native function. Its callback queue is
drained at the caller's one finite time with a strict callback bound. A
callback that perpetually reschedules fails closed. The same init script is
installed in future page and OOPIF Window worlds.

Dedicated-worker and SharedWorker construction and
`transferControlToOffscreen()` fail closed during this capture mode. Context
init scripts do not run inside worker globals, so pretending to pause their
rAF clocks would be an ownership claim the protocol cannot authenticate.

Each sampling pass opens the target's CDP session, records its target id and
frame identity, forces style/layout through `Runtime.evaluate` and
`Page.getLayoutMetrics`, and rejects target churn or duplicate OOPIF target
identity. This is a logical rendering commit; no screenshot or pixel evidence
is used.

## Combined stable-frame ordering

The callback batch runs first at `animationTimeMs`. Document and SMIL timelines
then seek to that time while scroll/view timelines retain their exact percent
unit and DM-2553 source snapshot. The old two-rAF settle path is disabled in
this mode; later capture prepasses use the already-owned synchronous callback
queue and the target state is reverified between prepasses.

The protocol rejects:

- a late-installed handle;
- Playwright's page-visible `__pwClock` native escape;
- recurring/unbounded callback queues;
- worker or OffscreenCanvas escape attempts;
- changed target/frame sets, time, source fingerprint, or pause state.

`tests/raf-clock.e2e.test.ts` runs only headless Chromium and covers a real
site-isolated main/OOPIF pair, target churn, recurring callbacks, worker
attempts, late installation, and the combined callback→timeline→capture order.
`.github/workflows/raf-clock-ownership.yml` repeats the logical gate on macOS,
Linux, and Windows. No visual tolerance is involved.
