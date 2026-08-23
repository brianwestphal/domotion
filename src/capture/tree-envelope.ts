import type {
  CapturedElement,
  CapturedSessionGenericFamilies,
  CapturedTreeEnvelope,
  CapturedTreeInput,
} from "./types.js";

export const CAPTURED_TREE_SCHEMA = "domotion-captured-tree-v1" as const;

function preferenceSignature(record: CapturedSessionGenericFamilies): string {
  return JSON.stringify({
    source: record.source,
    common: Object.entries(record.common).sort(([a], [b]) => a.localeCompare(b)),
    byScript: Object.entries(record.byScript)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([script, families]) => [
        script,
        Object.entries(families).sort(([a], [b]) => a.localeCompare(b)),
      ]),
  });
}

function assertPreferenceRecord(record: CapturedSessionGenericFamilies): void {
  if (
    record == null
    || typeof record !== "object"
    || record.source !== "chromium-platform-fonts-v1"
    || record.common == null
    || typeof record.common !== "object"
    || Array.isArray(record.common)
    || record.byScript == null
    || typeof record.byScript !== "object"
    || Array.isArray(record.byScript)
  ) {
    throw new Error("Captured tree has malformed generic-family preference authority");
  }
  if (Object.entries(record.common).some(([generic, family]) => generic === "" || typeof family !== "string")) {
    throw new Error("Captured tree has malformed generic-family preference authority");
  }
  for (const [script, families] of Object.entries(record.byScript)) {
    if (
      script === ""
      || families == null
      || typeof families !== "object"
      || Array.isArray(families)
      || Object.entries(families).some(([generic, family]) => generic === "" || typeof family !== "string")
    ) {
      throw new Error("Captured tree has malformed generic-family preference authority");
    }
  }
}

function rootPreferenceRecord(tree: CapturedElement[]): CapturedSessionGenericFamilies | null {
  const records = tree
    .map((element) => element.sessionGenericFamilies)
    .filter((record): record is CapturedSessionGenericFamilies => record != null);
  if (records.length === 0) return null;
  if (records.length !== tree.length) {
    throw new Error("Cannot mix captured roots with and without generic-family preference authority");
  }
  for (const record of records) assertPreferenceRecord(record);
  const firstSignature = preferenceSignature(records[0]);
  if (records.some((record) => preferenceSignature(record) !== firstSignature)) {
    throw new Error("Cannot render roots captured from different generic-family preference sessions in one tree");
  }
  return records[0];
}

function isEnvelope(input: CapturedTreeInput): input is CapturedTreeEnvelope {
  return !Array.isArray(input);
}

/** Return the roots after validating the envelope discriminator. */
export function capturedTreeRoots(input: CapturedTreeInput): CapturedElement[] {
  if (Array.isArray(input)) return input;
  if (input.schema !== CAPTURED_TREE_SCHEMA || !Array.isArray(input.tree)) {
    throw new Error("Unsupported or malformed captured-tree envelope");
  }
  return input.tree;
}

/**
 * Resolve the one serialized Page-authority record for a legacy tree or
 * envelope. Partial/conflicting legacy annotations and envelope/root conflicts
 * fail closed; insertion-order-only JSON differences remain equivalent.
 */
export function capturedTreeSessionGenericFamilies(
  input: CapturedTreeInput,
): CapturedSessionGenericFamilies | null {
  const tree = capturedTreeRoots(input);
  const rootRecord = rootPreferenceRecord(tree);
  if (!isEnvelope(input)) return rootRecord;
  const envelopeRecord = input.sessionGenericFamilies ?? null;
  if (envelopeRecord == null) return rootRecord;
  assertPreferenceRecord(envelopeRecord);
  if (rootRecord != null && preferenceSignature(rootRecord) !== preferenceSignature(envelopeRecord)) {
    throw new Error("Captured-tree envelope conflicts with root generic-family preference authority");
  }
  return envelopeRecord;
}

function withoutRootPreferenceRecord(root: CapturedElement): CapturedElement {
  if (root.sessionGenericFamilies == null) return root;
  const copy = { ...root };
  delete copy.sessionGenericFamilies;
  return copy;
}

/**
 * Move legacy root annotations into one JSON-stable Page-ownership envelope.
 * The input is not mutated; only annotated roots are shallow-cloned.
 */
export function createCapturedTreeEnvelope(input: CapturedTreeInput): CapturedTreeEnvelope {
  const record = capturedTreeSessionGenericFamilies(input);
  return {
    schema: CAPTURED_TREE_SCHEMA,
    tree: capturedTreeRoots(input).map(withoutRootPreferenceRecord),
    ...(record == null ? {} : { sessionGenericFamilies: record }),
  };
}

function collectTreeNodes(roots: CapturedElement[]): Set<CapturedElement> {
  const nodes = new Set<CapturedElement>();
  const visit = (element: CapturedElement): void => {
    if (nodes.has(element)) return;
    nodes.add(element);
    for (const child of element.children) visit(child);
  };
  for (const root of roots) visit(root);
  return nodes;
}

/**
 * Promote one or more descendants to independent roots while retaining the
 * exact Page generic-family authority from their originating capture.
 * Selection uses object identity so authority cannot accidentally be attached
 * to an unrelated tree. JSON round-trips are supported: select the descendant
 * from the parsed source envelope, then pass that same object here.
 */
export function promoteCapturedSubtree(
  source: CapturedTreeInput,
  selected: CapturedElement | readonly CapturedElement[],
): CapturedTreeEnvelope {
  const sourceRoots = capturedTreeRoots(source);
  const sourceEnvelope = createCapturedTreeEnvelope(source);
  const roots = Array.isArray(selected) ? [...selected] : [selected];
  if (roots.length === 0) {
    throw new Error("Cannot promote an empty captured subtree selection");
  }
  const sourceNodes = collectTreeNodes(sourceRoots);
  if (roots.some((root) => !sourceNodes.has(root))) {
    throw new Error("Cannot promote a node that does not belong to the captured tree");
  }
  return {
    schema: CAPTURED_TREE_SCHEMA,
    tree: roots.map(withoutRootPreferenceRecord),
    ...(sourceEnvelope.sessionGenericFamilies == null
      ? {}
      : { sessionGenericFamilies: sourceEnvelope.sessionGenericFamilies }),
  };
}
