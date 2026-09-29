import { isDeepStrictEqual } from "node:util";
import { HttpError } from "../utils/local-server.js";
import { studioContentRevisionId } from "./authoring.js";
import type { StudioProject } from "./project-schema.js";

export type GenerationSelection = { kind: "story" } | { kind: "scene"; sceneId: string };

/** The authored part of a project: everything the AI adapters must leave exactly as it was. */
function authored({ review: _review, artifacts: _artifacts, updatedAt: _updatedAt, ...value }: StudioProject): unknown {
  return value;
}

/**
 * The contract a generation adapter must keep, as pure checks with no I/O. A generation may add review
 * revisions, annotations and artifacts, and refresh `updatedAt`; it must not touch authored content,
 * rewrite existing review provenance or artifacts, or change the saved content revision, and it must
 * return a current SVG artifact for the selection that was asked for. Each violation is a 400.
 */
export function verifyGeneratedProject(
  current: StudioProject,
  next: StudioProject,
  selection: GenerationSelection,
): void {
  if (!isDeepStrictEqual(authored(next), authored(current))) {
    throw new HttpError(400, "generation adapters must preserve authored narrative, scenes, and settings");
  }
  if (
    !isDeepStrictEqual(next.review.revisions.slice(0, current.review.revisions.length), current.review.revisions) ||
    !isDeepStrictEqual(next.review.annotations.slice(0, current.review.annotations.length), current.review.annotations)
  ) {
    throw new HttpError(400, "generation adapters must preserve existing review provenance");
  }
  if (studioContentRevisionId(next) !== studioContentRevisionId(current)) {
    throw new HttpError(400, "generation adapters cannot replace the saved authoring content revision");
  }
  if (
    current.artifacts.some((artifact) => !next.artifacts.some((candidate) => isDeepStrictEqual(candidate, artifact)))
  ) {
    throw new HttpError(400, "generation adapters must preserve existing artifacts");
  }
  const contentRevisionId = studioContentRevisionId(next);
  const hasCurrentArtifact = next.artifacts.some(
    (artifact) =>
      artifact.kind === "svg" &&
      artifact.sourceRevisionId === contentRevisionId &&
      (selection.kind === "story"
        ? artifact.sceneIds == null || artifact.sceneIds.length === 0
        : artifact.sceneIds?.length === 1 && artifact.sceneIds[0] === selection.sceneId),
  );
  if (!hasCurrentArtifact) {
    throw new HttpError(400, "generation adapter did not return a current SVG artifact for the requested selection");
  }
}
