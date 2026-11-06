/**
 * The one formatter for zod validation issues, shared by the CLI, the template
 * and brand loaders, the local servers and Studio so a bad config, request or
 * AI decision reports its paths the same way everywhere.
 *
 * Paths render with property keys joined by `.` and array indexes as `[n]`:
 * `scenes[0].tracks[2].at`. Two path styles exist, and both use that grammar:
 *
 * - the plain style (no base): a root-level issue has the empty path, and
 *   `formatIssues` then shows its message alone;
 * - a based style, where the path is appended to a base expression such as
 *   `$` (Studio's JSON-path style, `$.scenes[0].id`) or a caller-supplied
 *   prefix like `$.scene.tracks`.
 *
 * Kept in `src/utils/` so templates and Studio do not import from `cli/`.
 */

/** The part of a zod issue the formatter reads; `z.ZodError["issues"]` satisfies it. */
export interface ValidationIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * Render an issue path. Without a `base` the leading `.` is dropped, so a
 * root-level issue renders as `""`; with a base (e.g. `"$"`) the segments are
 * appended to it and a root-level issue renders as the base itself.
 */
export function formatIssuePath(path: readonly PropertyKey[], base = ""): string {
  const segments = path.map((seg) => (typeof seg === "number" ? `[${seg}]` : `.${String(seg)}`)).join("");
  return base === "" ? segments.replace(/^\./, "") : `${base}${segments}`;
}

/**
 * Render every issue on one line as `path: message`, separated by `; `. A
 * root-level issue in the plain style shows its message alone. Showing every
 * issue lets a user fix an input in one round trip instead of one error per run.
 */
export function formatIssues(issues: readonly ValidationIssueLike[], base = ""): string {
  return issues
    .map((issue) => {
      const path = formatIssuePath(issue.path, base);
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    })
    .join("; ");
}
