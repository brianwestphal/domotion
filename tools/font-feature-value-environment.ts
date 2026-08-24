import { createHash } from "node:crypto";
import type { FontFeatureValueTables } from "../src/font-feature-values-cascade.js";

export type RetainedFontSourceKind = "data" | "file" | "local" | "remote";

export interface RetainedFontSource {
  kind: RetainedFontSourceKind;
  cssText: string;
  sourceOrder: number;
  status: "loaded" | "failed";
  bytesBase64?: string;
  sha256?: string;
  faceIndex: number;
}

export interface RetainedFontFace {
  id: string;
  family: string;
  weightDescriptor: string;
  styleDescriptor: string;
  stretchDescriptor: string;
  unicodeRange: string;
  sources: RetainedFontSource[];
}

export interface AuthenticatedFontFeatureEnvironment {
  version: "font-feature-values-environment-v2";
  documentId: string;
  selectedFaceId: string;
  selectedSourceOrder: number;
  faces: RetainedFontFace[];
  effectiveAliasTable: FontFeatureValueTables;
}

export interface AuthenticatedSelectedFont {
  environment: AuthenticatedFontFeatureEnvironment;
  face: RetainedFontFace;
  source: RetainedFontSource & { bytesBase64: string; sha256: string };
  bytes: Buffer;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/**
 * Authenticate the browser-selected face/source before it enters an exact
 * named-alternate shaping record. Selection itself remains Blink-owned: the
 * caller must retain the selected face id and source-order slot from its
 * document-local browser probe. This boundary verifies that the retained
 * bytes and all descriptors still describe that exact selection.
 */
export function authenticateFontFeatureEnvironment(
  environment: AuthenticatedFontFeatureEnvironment,
): AuthenticatedSelectedFont {
  if (environment.version !== "font-feature-values-environment-v2") {
    throw new Error("unsupported font-feature-values environment version");
  }
  if (environment.documentId.trim() === "") {
    throw new Error("font-feature-values environment has no document identity");
  }
  const matchingFaces = environment.faces.filter((face) => face.id === environment.selectedFaceId);
  if (matchingFaces.length !== 1) throw new Error("selected font face is absent or ambiguous");
  const face = matchingFaces[0];
  for (const descriptor of [face.family, face.weightDescriptor, face.styleDescriptor,
    face.stretchDescriptor, face.unicodeRange]) {
    if (descriptor.trim() === "") throw new Error("selected font face has an empty descriptor");
  }
  const matchingSources = face.sources.filter((source) =>
    source.sourceOrder === environment.selectedSourceOrder);
  if (matchingSources.length !== 1) throw new Error("selected font source is absent or ambiguous");
  const source = matchingSources[0];
  const earlierLoaded = face.sources.some((candidate) =>
    candidate.sourceOrder < source.sourceOrder && candidate.status === "loaded");
  if (earlierLoaded) throw new Error("selected font source violates CSS source order");
  if (source.status !== "loaded") throw new Error("selected font source did not load");
  if (source.bytesBase64 == null || source.sha256 == null) {
    throw new Error(`unauthenticated ${source.kind} font bytes`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(source.bytesBase64)
      || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error("invalid retained font byte authentication");
  }
  const bytes = Buffer.from(source.bytesBase64, "base64");
  if (bytes.length === 0 || digest(bytes) !== source.sha256) {
    throw new Error("retained font byte digest mismatch");
  }
  if (!Number.isInteger(source.faceIndex) || source.faceIndex < 0) {
    throw new Error("invalid retained font face index");
  }
  return {
    environment,
    face,
    source: source as AuthenticatedSelectedFont["source"],
    bytes,
  };
}

/** Exact cache/probe partition: document identity prevents alias leakage. */
export function fontFeatureEnvironmentKey(
  environment: AuthenticatedFontFeatureEnvironment,
): string {
  const selected = authenticateFontFeatureEnvironment(environment);
  return JSON.stringify(canonical({
    version: environment.version,
    documentId: environment.documentId,
    selectedFaceId: environment.selectedFaceId,
    selectedSourceOrder: environment.selectedSourceOrder,
    faces: environment.faces,
    effectiveAliasTable: environment.effectiveAliasTable,
    selectedDigest: selected.source.sha256,
  }));
}
