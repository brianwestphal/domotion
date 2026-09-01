import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const LIVE_STATUSES = new Set(["current", "partial"]);

/**
 * Validate every code-owner path declared by a live documentation record.
 *
 * Checking only that a handbook has at least one owner lets a mixed list such
 * as `["real.ts", "removed.ts"]` pass and then publishes the removed path into
 * the machine manifest and every generated owner packet. Historical records
 * intentionally retain old paths, so the existence contract applies only to
 * current/partial metadata.
 */
export function documentationCodePathErrors(
  filename,
  metadata,
  projectRoot,
  pathExists = existsSync,
) {
  if (!LIVE_STATUSES.has(metadata?.status) || !Array.isArray(metadata?.code)) return [];

  const errors = [];
  for (const declaredPath of metadata.code) {
    if (typeof declaredPath !== "string" || declaredPath.trim() === "") {
      errors.push(`${filename}: code path must be a non-empty repository-relative string`);
      continue;
    }
    const resolvedPath = resolve(projectRoot, declaredPath);
    const repositoryPath = relative(projectRoot, resolvedPath);
    if (repositoryPath === "" || repositoryPath === ".."
        || repositoryPath.startsWith(`..${sep}`)
        || isAbsolute(repositoryPath)) {
      errors.push(`${filename}: code path escapes the repository: ${declaredPath}`);
      continue;
    }
    if (!pathExists(resolvedPath)) {
      errors.push(`${filename}: code path does not exist: ${declaredPath}`);
    }
  }
  return errors;
}
