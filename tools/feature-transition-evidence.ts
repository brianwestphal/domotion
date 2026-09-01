import ts from "typescript";

export interface TransitionEvidenceRef {
  /** Repo-relative test file that contains the assertion. */
  test: string;
  /** Exact literal title passed to `it(...)` or `test(...)`. */
  title: string;
}

export interface TransitionFeatureLike {
  id: string;
  tests: string[];
  transition?: string;
  transitionEvidence?: TransitionEvidenceRef[];
}

/**
 * Return the literal titles declared by Vitest/Jest-style `it` and `test`
 * calls. Parsing the source prevents a title copied into a comment, fixture, or
 * unrelated string from masquerading as an assertion.
 */
export function declaredTestTitles(source: string, fileName = "test.ts"): Set<string> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const titles = new Set<string>();

  const rootCallName = (expr: ts.Expression): string | null => {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return rootCallName(expr.expression);
    if (ts.isCallExpression(expr)) return rootCallName(expr.expression);
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const root = rootCallName(node.expression);
      const title = node.arguments[0];
      if ((root === "it" || root === "test")
        && title != null
        && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        titles.add(title.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return titles;
}

/** Validate that every transition claim points to an exact, declared test. */
export function transitionEvidenceProblems(
  features: readonly TransitionFeatureLike[],
  readTestSource: (testPath: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const titlesByPath = new Map<string, Set<string>>();

  for (const feature of features) {
    const hasTransition = feature.transition != null && feature.transition.trim() !== "";
    const evidence = feature.transitionEvidence ?? [];
    if (!hasTransition) {
      if (evidence.length > 0) problems.push(`${feature.id} has transitionEvidence but no transition`);
      continue;
    }
    if (evidence.length === 0) {
      problems.push(`${feature.id} has a transition but no transitionEvidence`);
      continue;
    }

    const seen = new Set<string>();
    for (const ref of evidence) {
      const key = `${ref.test}\u0000${ref.title}`;
      if (seen.has(key)) problems.push(`${feature.id} repeats transition evidence ${ref.test} → ${JSON.stringify(ref.title)}`);
      seen.add(key);

      if (!feature.tests.includes(ref.test)) {
        problems.push(`${feature.id} transition evidence is not listed in tests: ${ref.test}`);
        continue;
      }

      let titles = titlesByPath.get(ref.test);
      if (titles == null) {
        const source = readTestSource(ref.test);
        if (source == null) {
          problems.push(`${feature.id} transition evidence file is missing: ${ref.test}`);
          continue;
        }
        titles = declaredTestTitles(source, ref.test);
        titlesByPath.set(ref.test, titles);
      }
      if (!titles.has(ref.title)) {
        problems.push(`${feature.id} transition evidence title is not declared by ${ref.test}: ${JSON.stringify(ref.title)}`);
      }
    }
  }

  return problems;
}
