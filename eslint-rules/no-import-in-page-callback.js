/**
 * `domotion/no-import-in-page-callback` — a function handed to Playwright to run INSIDE the page must not
 * reference a module import.
 *
 * Playwright serializes the function's source text and evaluates it in the page, where no module scope
 * exists. A reference to an imported binding therefore fails only at runtime (`__vite_ssr_import_N__ is not
 * defined` under vitest, a bare `ReferenceError` in a built package), and the capture code degrades such a
 * failure to a warning — a native-control raster once reported "surface unavailable" for every checkbox
 * because its page-side probe called an imported color predicate.
 *
 * Checked: an inline function (arrow or expression) passed to `evaluate`, `evaluateHandle`, `$eval`, `$$eval`,
 * `waitForFunction` or `addInitScript`. Type-only imports are erased and allowed. A callback passed by name
 * is not followed.
 */
const PAGE_METHODS = new Set(["evaluate", "evaluateHandle", "$eval", "$$eval", "waitForFunction", "addInitScript"]);

function isTypeOnlyImport(def) {
  const spec = def.node;
  const decl = def.parent;
  return spec?.importKind === "type" || decl?.importKind === "type";
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Forbid page-evaluated callbacks that reference module imports." },
    messages: {
      importInPage:
        "'{{name}}' is a module import, which does not exist inside the page; this callback runs via {{method}}() and would throw a ReferenceError at runtime. Inline the logic or pass the value as an argument.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return;
        const method = callee.property.name;
        if (!PAGE_METHODS.has(method)) return;
        for (const arg of node.arguments) {
          if (arg.type !== "ArrowFunctionExpression" && arg.type !== "FunctionExpression") continue;
          const scope = sourceCode.getScope(arg);
          for (const ref of scope.through) {
            const variable = ref.resolved;
            if (variable == null || (ref.isTypeReference === true && ref.isValueReference !== true)) continue;
            const def = variable.defs[0];
            if (def?.type !== "ImportBinding" || isTypeOnlyImport(def)) continue;
            context.report({
              node: ref.identifier,
              messageId: "importInPage",
              data: { name: ref.identifier.name, method },
            });
          }
        }
      },
    };
  },
};
