import type { AnimateConfig, AnimateFrameCfg } from "./animate-orchestrator.js";

type RunStateInput = NonNullable<AnimateFrameCfg["states"]>[number];

const AUTO_COLLAPSED_RUNS = new WeakSet<AnimateFrameCfg>();

/** Whether this `states` frame was synthesized by the automatic collapse pass
 *  (rather than authored). Exported for unit tests. */
export function wasAutoCollapsed(frame: AnimateFrameCfg): boolean {
  return AUTO_COLLAPSED_RUNS.has(frame);
}

function collapseCompressibleRuns(
  cfg: AnimateConfig,
  log: (msg: string) => void,
  mode: "auto" | "marker",
): AnimateConfig {
  const frames = cfg.frames;
  const n = frames.length;
  const strict = mode === "marker";
  const tag = strict ? "compress" : "auto-compress";
  // In marker mode an ineligible run is an author error, not a skip.
  const failMarked = (idx: number, reason: string): never => {
    throw new Error(`animate: frames[${idx}] sets \`compress: true\` but the run cannot be collapsed — ${reason}`);
  };

  const isCut = (f: AnimateFrameCfg): boolean => f.transition?.type === "cut";
  // A frame that carries content or interactions the simple-case run can't
  // absorb into a `states` run. Any of these on a member disqualifies the run.
  // Named (not just detected) so the marker mode's hard error can say which.
  const blockingFeature = (f: AnimateFrameCfg): string | null => {
    if (f.cast != null) return "cast";
    if (f.template != null) return "template";
    if (f.scroll != null) return "scroll";
    if (f.states != null) return "states";
    if (f.typeResample != null) return "typeResample";
    if (f.jsReveal != null) return "jsReveal";
    if (f.hoverReveal != null) return "hoverReveal";
    if (f.hoverDetect != null) return "hoverDetect";
    // DM-1767 (docs/104): `overlays` is NO LONGER a blocker. A member's
    // overlays become that state's `overlays` — anchor-resolved against its own
    // state's page and bounded to its state's hold by the explicit per-overlay
    // window — so the authored behavior survives the collapse instead of the
    // frame having to stay a plain sibling.
    if (f.animations != null && f.animations.length > 0) return "animations";
    if (f.textTracks != null && f.textTracks.length > 0) return "textTracks";
    if (f.forceState != null && f.forceState.length > 0) return "forceState";
    return null;
  };
  // A content-producing frame kind is its own nested composition — it can't be a
  // state of someone else's run. Everything else in `blockingFeature` is a
  // per-frame decoration with no per-state equivalent, for which the hand-
  // authored `states:` block (which CAN carry frame-level overlays) is the way.
  const contentKinds = new Set([
    "cast",
    "template",
    "scroll",
    "states",
    "typeResample",
    "jsReveal",
    "hoverReveal",
    "hoverDetect",
  ]);
  const blockingFeatureReason = (idx: number, feature: string): string =>
    feature === "states"
      ? `frames[${idx}] already IS a compressed run (it carries a \`states\` block) — drop the \`compress\` marker`
      : contentKinds.has(feature)
        ? `frames[${idx}] is a \`${feature}\` frame, which produces its own nested content and cannot be a state of a compressed run`
        : `frames[${idx}] carries \`${feature}\`, which has no per-state equivalent inside a compressed run — author that run as a \`states:\` block instead, which can carry frame-level \`${feature}\` (docs/43 §11)`;
  const hasInteractionAction = (f: AnimateFrameCfg): boolean =>
    f.actions != null && f.actions.some((a) => a.type === "click" || a.type === "hover" || a.type === "fill");
  const hasReadinessWaitOrScroll = (f: AnimateFrameCfg): boolean =>
    f.waitFor != null ||
    f.waitForText != null ||
    f.waitForGone != null ||
    f.waitForCount != null ||
    f.wait != null ||
    f.scrollTo != null;

  // Why frame `idx` cannot SEED a run (null when it can), and why frame `idx`
  // cannot JOIN one. Shared by both modes: auto uses them as predicates, marker
  // turns the string into the hard error's reason.
  const anchorBlocker = (idx: number): string | null => {
    const f = frames[idx];
    if (f.compress === false) return `frames[${idx}] sets \`compress: false\``;
    if (!isCut(f))
      return `frames[${idx}] leaves via a \`${f.transition?.type ?? "crossfade"}\` transition, not a \`cut\` (a compressed run holds its states with cuts)`;
    const feature = blockingFeature(f);
    if (feature != null) return blockingFeatureReason(idx, feature);
    if (f.selector != null) return `frames[${idx}] captures a \`selector\` subtree rather than the whole page`;
    return null;
  };
  const memberBlocker = (idx: number): string | null => {
    const f = frames[idx];
    if (f.compress === false) return `frames[${idx}] sets \`compress: false\``;
    if (f.input != null) return `frames[${idx}] loads an \`input\` (a compressed run holds ONE continuous page)`;
    if (f.cast != null || f.template != null)
      return `frames[${idx}] is a \`${f.cast != null ? "cast" : "template"}\` frame (a compressed run holds ONE continuous page)`;
    if (!isCut(f))
      return `frames[${idx}] leaves via a \`${f.transition?.type ?? "crossfade"}\` transition, not a \`cut\``;
    const feature = blockingFeature(f);
    if (feature != null) return blockingFeatureReason(idx, feature);
    if (f.selector != null) return `frames[${idx}] captures a \`selector\` subtree rather than the whole page`;
    if (hasReadinessWaitOrScroll(f))
      return `frames[${idx}] carries a readiness wait / \`scrollTo\` (a compressed run has no per-state wait)`;
    return null;
  };

  const cursorAuto = cfg.cursor === "auto";
  const explicitCursorFrames = new Set<number>(
    cfg.cursor != null && cfg.cursor !== "auto" ? cfg.cursor.events.map((e) => e.frame) : [],
  );

  const newFrames: AnimateFrameCfg[] = [];
  // Old frame index → its index in the rewritten frames array (a collapsed run
  // maps every member index to the single states frame's index).
  const newIndexForOld: number[] = new Array(n);

  /** Emit frame `idx` unchanged, recording its new index. */
  const passThrough = (idx: number): void => {
    newIndexForOld[idx] = newFrames.length;
    newFrames.push(frames[idx]);
  };
  /** Collapse frames [start..end] (≥ 2, all eligible) into ONE `states` frame:
   *  the anchor's own frame-level setup is preserved, state 0 is the anchor's
   *  post-actions capture, and each later member contributes its actions + hold. */
  const collapseInto = (start: number, end: number): void => {
    const runAnchor = frames[start];
    const runFrames = frames.slice(start, end + 1);
    const totalDuration = runFrames.reduce((sum, f) => sum + f.duration, 0);
    // DM-1767: each member's `overlays` become its STATE's overlays. That is
    // what preserves the authored behavior through the collapse: the state's
    // capture is where its anchors resolve, and the state's slice of the run is
    // the window `buildStatesRunContent` bounds them to — so an overlay on the
    // third of five members still dies at that member's cut instead of holding
    // to the end of the whole run.
    const states: RunStateInput[] = [
      {
        duration: runAnchor.duration, // state 0 = the anchor's own post-actions capture
        ...(runAnchor.overlays != null && runAnchor.overlays.length > 0 ? { overlays: runAnchor.overlays } : {}),
      },
      ...runFrames.slice(1).map((f) => ({
        ...(f.actions != null ? { actions: f.actions } : {}),
        duration: f.duration,
        ...(f.overlays != null && f.overlays.length > 0 ? { overlays: f.overlays } : {}),
      })),
    ];
    const collapsed: AnimateFrameCfg = {
      ...(runAnchor.input != null ? { input: runAnchor.input } : { continue: true }),
      ...(runAnchor.wait != null ? { wait: runAnchor.wait } : {}),
      ...(runAnchor.waitFor != null ? { waitFor: runAnchor.waitFor } : {}),
      ...(runAnchor.waitForText != null ? { waitForText: runAnchor.waitForText } : {}),
      ...(runAnchor.waitForGone != null ? { waitForGone: runAnchor.waitForGone } : {}),
      ...(runAnchor.waitForCount != null ? { waitForCount: runAnchor.waitForCount } : {}),
      ...(runAnchor.scrollTo != null ? { scrollTo: runAnchor.scrollTo } : {}),
      ...(runAnchor.actions != null ? { actions: runAnchor.actions } : {}),
      transition: { type: "cut", duration: 0 },
      duration: totalDuration,
      states,
    };
    // Only the automatic pass's runs are guard-eligible (see AUTO_COLLAPSED_RUNS).
    if (!strict) AUTO_COLLAPSED_RUNS.add(collapsed);
    const collapsedIdx = newFrames.length;
    newFrames.push(collapsed);
    for (let k = start; k <= end; k++) newIndexForOld[k] = collapsedIdx;
    log(`  ${tag}: collapsed frames ${start}–${end} into a states run (${states.length} states, ${totalDuration}ms)`);
  };

  let i = 0;
  while (i < n) {
    const anchor = frames[i];
    // The anchor may load an `input` or `continue`; either kind of plain,
    // cut-transition, feature-free frame can seed a run. In marker mode only a
    // frame the author stamped `compress: true` seeds one — every other frame
    // passes straight through even when it would have been eligible.
    const marked = anchor.compress === true;
    const anchorWhyNot = anchorBlocker(i);
    if (strict && marked && anchorWhyNot != null) failMarked(i, anchorWhyNot);
    if ((strict ? marked : true) && anchorWhyNot == null) {
      // Extend the run over following pure `continue` + `cut` members.
      let j = i + 1;
      while (j < n && memberBlocker(j) == null) j++;
      const b = j - 1; // inclusive run end
      if (strict && b === i) {
        failMarked(
          i,
          j < n
            ? `no following frame can join it — ${memberBlocker(j)}`
            : "it is the last frame in the config (a compressed run needs at least 2 frames)",
        );
      }
      if (b > i) {
        // A maximal candidate run [i..b] (≥ 2 frames). The remaining exclusions
        // are single-FRAME reasons, not run-wide ones: a cursor event addressing
        // one member, an interaction action auto-cursor would derive a pointer
        // from, or a magic-move landing on the anchor. DM-1764: rather than
        // dropping the whole window (v1's behavior, which made one bad frame
        // cost every frame around it), split the window AT those frames and
        // collapse the eligible sub-runs on either side. Each split frame stays
        // a plain sibling frame, so whatever it carries — the pointer, the
        // magic-move landing — behaves exactly as it did uncollapsed.
        const splits: Array<{ idx: number; why: string; strictWhy: string }> = [];
        const addSplit = (idx: number, why: string, strictWhy: string = why): void => {
          if (!splits.some((s) => s.idx === idx)) splits.push({ idx, why, strictWhy });
        };
        if (i > 0 && frames[i - 1].transition?.type === "magic-move") {
          // Only the run's ENTRY is affected: keeping the anchor a plain frame
          // preserves the magic-move, and the sub-run after it still collapses.
          addSplit(i, "it is entered via a magic-move transition (would degrade to crossfade)");
        }
        for (let k = i; k <= b; k++) {
          if (explicitCursorFrames.has(k)) {
            addSplit(
              k,
              `an explicit cursor event addresses frame ${k}`,
              `an explicit cursor event addresses frame ${k} inside it`,
            );
          } else if (cursorAuto && hasInteractionAction(frames[k])) {
            addSplit(k, `cursor:"auto" derives a pointer from an interaction action in frame ${k}`);
          }
        }
        // Marker mode keeps the loud failure: the author asked for THIS run, so
        // silently compressing a shorter piece of it would hide the mismatch
        // between what they wrote and what they got.
        if (strict && splits.length > 0) failMarked(i, splits[0].strictWhy);
        const splitAt = new Map(splits.map((s) => [s.idx, s.why]));
        // Walk the window; every split frame closes the current sub-run and is
        // emitted plain. A sub-run of a single frame is emitted plain too (a
        // compressed run needs ≥ 2 states).
        let segStart = i;
        for (let k = i; k <= b + 1; k++) {
          if (k <= b && !splitAt.has(k)) continue;
          if (k - 1 > segStart) collapseInto(segStart, k - 1);
          else for (let m = segStart; m <= k - 1; m++) passThrough(m);
          if (k <= b) {
            log(`  ${tag}: leaving frame ${k} uncompressed — ${splitAt.get(k)}`);
            passThrough(k);
          }
          segStart = k + 1;
        }
        i = b + 1;
        continue;
      }
    }
    // Not a run head (or a run of one): keep frame i as-is.
    passThrough(i);
    i++;
  }

  if (newFrames.length === frames.length) return cfg; // nothing collapsed

  // Remap explicit cursor events onto the rewritten frame indices (auto-cursor
  // is re-derived from the rewritten frames, so it needs no remap). Rejected
  // runs mean no cursor event points inside a collapsed run.
  let cursor = cfg.cursor;
  if (cursor != null && cursor !== "auto") {
    cursor = { ...cursor, events: cursor.events.map((e) => ({ ...e, frame: newIndexForOld[e.frame] ?? e.frame })) };
  }
  log(`  ${tag}: ${frames.length} config frames → ${newFrames.length} after run collapse`);
  return { ...cfg, frames: newFrames, ...(cursor !== undefined ? { cursor } : {}) };
}

/**
 * DM-1757 (docs/43 §13.1): the whole-config `autoCompress: true` opt-in — collapse
 * EVERY eligible maximal `continue` + `cut` run into a `states` compressed run,
 * skipping (with a logged reason) anything the v1 safe scope excludes.
 *
 * Exported for unit tests. DM-1768: default-ON — collapses unless the config
 * explicitly sets `autoCompress: false` (undefined ⇒ on). The size-regression
 * guard makes this safe (an auto-collapsed run that composes larger than its
 * uncompressed states is reverted, DM-1772), and it is byte-neutral on the whole
 * committed example corpus (nothing there has an auto-collapsible plain
 * continue+cut run). Returns `cfg` unchanged only when compression is opted out.
 */
export function autoCompressRuns(cfg: AnimateConfig, log: (msg: string) => void = () => {}): AnimateConfig {
  if (cfg.autoCompress === false) return cfg;
  return collapseCompressibleRuns(cfg, log, "auto");
}

/**
 * DM-1761 (docs/43 §13.2): the per-frame `compress: true` marker — the surgical
 * counterpart to `autoCompress`. Only the runs whose FIRST frame carries the
 * marker collapse; every other frame passes through untouched, so an author can
 * compress the one run that pays for it (docs/100 notes a wholesale-change run
 * can pair poorly and end up marginally LARGER compressed) without flipping the
 * output shape of the whole config.
 *
 * Anchor-only semantics, with a greedy left-to-right scan: the marker means
 * "start a compressed run HERE and take the maximal eligible run". A marker on a
 * later member of that same run is therefore absorbed as a redundant no-op — the
 * scan already consumed the frame — so both the anchor-only and the mark-every-
 * member styles do the same thing, and neither can produce overlapping runs.
 *
 * Unlike `autoCompress`, an ineligible marker is a HARD ERROR naming the frame
 * and the reason: the author explicitly asked for this run, so silently emitting
 * a flipbook would hide the bug rather than surface it.
 *
 * Runs BEFORE `autoCompressRuns` when both are on. There is no double-collapse:
 * a collapsed frame carries `states`, which disqualifies it as an anchor and as
 * a member of the automatic pass.
 *
 * Exported for unit tests. Returns `cfg` unchanged when no frame is marked.
 */
export function compressMarkedRuns(cfg: AnimateConfig, log: (msg: string) => void = () => {}): AnimateConfig {
  if (!cfg.frames.some((f) => f.compress === true)) return cfg;
  return collapseCompressibleRuns(cfg, log, "marker");
}
