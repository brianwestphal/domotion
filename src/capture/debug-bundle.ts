/**
 * Filesystem-neutral debug artifacts for programmatic capture callers.
 *
 * The CLI owns directory names and file writes. This module only snapshots
 * bytes/text so library consumers can choose their own transport (disk, object
 * storage, issue attachment, database, etc.).
 */

import type { CapturedElement } from "./types.js";

export interface CaptureDebugArtifacts {
  /** Chromium's source pixels for the exact capture viewport, encoded as PNG. */
  expectedPng: Uint8Array;
  /** Pretty-printed raw capture tree for inspection and reproduction. */
  capturedTreeJson: string;
}

export interface CaptureDebugBundle extends CaptureDebugArtifacts {
  /** Complete SVG emitted by the caller's render pipeline. */
  actualSvg: string;
  /** Optional caller-recorded Playwright HAR bytes. */
  captureHar?: Uint8Array;
}

export interface AssembleCaptureDebugBundleOptions {
  /**
   * HAR content read after the caller closes its BrowserContext. Playwright
   * requires HAR recording at context creation and flushes on context close,
   * so a capture helper cannot retroactively obtain it from a caller-owned
   * context.
   */
  captureHar?: string | Uint8Array;
}

/** Snapshot screenshot bytes and a JSON inspection form of the captured tree. */
export function createCaptureDebugArtifacts(
  expectedPng: Uint8Array,
  tree: CapturedElement[],
): CaptureDebugArtifacts {
  return {
    expectedPng: Uint8Array.from(expectedPng),
    capturedTreeJson: JSON.stringify(tree, null, 2),
  };
}

/**
 * Combine capture-time evidence with the caller-rendered SVG and optional HAR.
 * Byte arrays are copied so later buffer reuse cannot mutate the bundle.
 */
export function assembleCaptureDebugBundle(
  artifacts: CaptureDebugArtifacts,
  actualSvg: string,
  options: AssembleCaptureDebugBundleOptions = {},
): CaptureDebugBundle {
  const captureHar = options.captureHar == null
    ? undefined
    : typeof options.captureHar === "string"
      ? new TextEncoder().encode(options.captureHar)
      : Uint8Array.from(options.captureHar);
  return {
    expectedPng: Uint8Array.from(artifacts.expectedPng),
    capturedTreeJson: artifacts.capturedTreeJson,
    actualSvg,
    ...(captureHar == null ? {} : { captureHar }),
  };
}
