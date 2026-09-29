import { existsSync, realpathSync } from "node:fs";
import * as nativePath from "node:path";

/** The subset of `node:path` the containment check needs (injectable so tests can use `win32`). */
export interface WorkspacePathApi {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  dirname(path: string): string;
  extname(path: string): string;
  sep: string;
}

/** True when `target` is `root` or lies beneath it, judged lexically. */
export function isInsideRoot(root: string, target: string, pathApi: WorkspacePathApi = nativePath): boolean {
  const relative = pathApi.relative(root, target);
  return !(relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative));
}

/**
 * `realpath` of `target` even when it does not exist yet: the deepest existing ancestor is
 * resolved through any symlinks and the missing tail is re-appended. This is what lets
 * `/api/create` (a path that does not exist) be checked for a symlinked parent directory.
 */
function realpathOfDeepestExisting(target: string, pathApi: WorkspacePathApi): string {
  let existing = target;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = pathApi.dirname(existing);
    if (parent === existing) break;
    tail.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }
  return nativePath.join(realpathSync(existing), ...tail);
}

export interface ResolveInsideOptions {
  /** Path implementation; symlink resolution is skipped for a non-native one (tests). */
  pathApi?: WorkspacePathApi;
  /** Required file extension (lower-case, with the dot). Omit to accept any. */
  extension?: string;
  /** Message when the extension is wrong. */
  extensionMessage?: string;
  /** Message when the path escapes `root`; receives the resolved root. */
  escapeMessage: (root: string) => string;
  /** Also follow symlinks and require the REAL target to stay inside the REAL root. */
  followSymlinks?: boolean;
  /** Error factory so each caller keeps its own error class / HTTP status. */
  makeError?: (message: string) => Error;
}

/**
 * The one workspace-containment check. Resolves `requested` against `root`, rejects a path
 * that leaves the root lexically (`..`, an absolute path elsewhere) and, with
 * `followSymlinks`, one that leaves it through a symlink — a `.json`/`.svg` inside the
 * workspace that points at `/etc/passwd` is still outside it.
 */
export function resolveInsideWorkspace(root: string, requested: string, options: ResolveInsideOptions): string {
  const pathApi = options.pathApi ?? nativePath;
  const fail = options.makeError ?? ((message: string) => new Error(message));
  const resolvedRoot = pathApi.resolve(root);
  const resolved = pathApi.resolve(resolvedRoot, requested);
  if (!isInsideRoot(resolvedRoot, resolved, pathApi)) throw fail(options.escapeMessage(resolvedRoot));
  if (options.extension != null && pathApi.extname(resolved).toLowerCase() !== options.extension) {
    throw fail(options.extensionMessage ?? `path must use a ${options.extension} extension`);
  }
  if (options.followSymlinks === true && pathApi === nativePath) {
    const realRoot = realpathSync(resolvedRoot);
    if (!isInsideRoot(realRoot, realpathOfDeepestExisting(resolved, pathApi), pathApi)) {
      throw fail(options.escapeMessage(resolvedRoot));
    }
  }
  return resolved;
}
