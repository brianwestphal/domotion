import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";
import type { CapturedElement } from "../src/capture/types.js";

const rejectionField = "_testNativeDecorationRejections";
const predicates = [
  ["part.isConnected", "disconnected"],
  ['partStyle.display !== "none"', "display-none"],
  ['partStyle.visibility === "visible"', "visibility"],
  ["(!isFinite(partOpacity) || partOpacity > 0)", "opacity"],
  ["partRect.width > 0", "width"],
  ["partRect.height > 0", "height"],
] as const;

type Rejection = { partIndex: number; predicate: (typeof predicates)[number][1] };
type Admission = { state: "admitted" } | { state: "rejected"; rejections: Rejection[] } | { state: "unavailable" };

function instrumentCaptureScript() {
  const separator = " && ";
  const originalGate = `if (${predicates.map(([test]) => test).join(separator)}) {`;
  const observedGate = `if (${predicates
    .map(([test, rejection]) => `(${test} || recordDecorationRejection(el, kind, refIndex, "${rejection}"))`)
    .join(separator)}) {`;
  const replacements = [
    [
      "function normalizePseudoShadowPhase(",
      `let decorationRejections;
function recordDecorationRejection(owner, kind, partIndex, predicate) {
  if (kind === "inner-spin-button") {
    decorationRejections ??= new WeakMap();
    let entries = decorationRejections.get(owner);
    if (entries == null) decorationRejections.set(owner, entries = []);
    if (entries.length < 8) entries.push({ partIndex, predicate });
  }
  return false;
}
function normalizePseudoShadowPhase(`,
    ],
    [originalGate, observedGate],
    [
      "return Object.assign(base, { empty: true });",
      `return Object.assign(base, { empty: true }, decorationRejections?.has(el)
      ? { ${rejectionField}: decorationRejections.get(el) } : {});`,
    ],
  ];
  let source = CAPTURE_SCRIPT;
  for (const [before, after] of replacements) {
    const pieces = source.split(before);
    if (pieces.length !== 2) return undefined;
    source = pieces.join(after);
  }
  return source;
}

const capturePrefix = `(${CAPTURE_SCRIPT})(`;
const instrumentedCapture = instrumentCaptureScript();

/**
 * Observe the exact walker gate in the already-issued final test capture.
 * The inserted handlers only run on the first false term, after its original
 * read. They return false so the remaining terms still short-circuit.
 */
export function observeNativeDecorationAdmission() {
  let admission: Admission = { state: "unavailable" };
  return {
    expression(source: string): string | undefined {
      if (instrumentedCapture == null || !source.startsWith(capturePrefix)) return undefined;
      const args = source.slice(capturePrefix.length);
      if (args.includes('"textPaintProbe":true')) return undefined;
      return `(${instrumentedCapture})(${args}`;
    },
    retain(value: unknown): void {
      const tree = (value as { tree?: CapturedElement[] } | null)?.tree;
      if (!Array.isArray(tree)) return;
      const visit = (nodes: CapturedElement[]) => {
        for (const node of nodes) {
          const raster = node.nativeControlDecorationRaster as
            | (NonNullable<CapturedElement["nativeControlDecorationRaster"]> & { [rejectionField]?: Rejection[] })
            | undefined;
          const rejections = raster?.[rejectionField];
          if (rejections != null) delete raster![rejectionField];
          if (node.animId === "number" && raster?.kinds?.includes("inner-spin-button")) {
            if (raster.empty && rejections?.length) admission = { state: "rejected", rejections };
            else if (raster.parts?.some(({ kind }) => kind === "inner-spin-button")) admission = { state: "admitted" };
          }
          if (Array.isArray(node.children)) visit(node.children);
        }
      };
      visit(tree);
    },
    snapshot: () => admission,
  };
}
