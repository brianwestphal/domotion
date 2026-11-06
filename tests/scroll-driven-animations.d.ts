// Scroll-driven animation timelines (CSS Scroll-driven Animations Level 1).
// Chromium ships both constructors, but TypeScript's DOM library does not
// declare them yet, so the page-world callbacks in the browser tests that
// build them need these ambient declarations to typecheck.

interface ScrollTimelineOptions {
  source?: Element | null;
  axis?: "block" | "inline" | "x" | "y";
}

declare class ScrollTimeline extends AnimationTimeline {
  constructor(options?: ScrollTimelineOptions);
  readonly source: Element | null;
  readonly axis: "block" | "inline" | "x" | "y";
}

interface ViewTimelineOptions {
  subject?: Element | null;
  axis?: "block" | "inline" | "x" | "y";
  inset?: string;
}

declare class ViewTimeline extends ScrollTimeline {
  constructor(options?: ViewTimelineOptions);
  readonly subject: Element | null;
}
