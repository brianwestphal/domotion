/**
 * `domotion/mapped-row-data-key` — in a kerf browser client, a list rendered with
 * `.map()` whose rows hold a form field must key each row.
 *
 * `eslint-plugin-kerfjs`'s `require-data-key` only inspects `each()` calls, so a `.map()` that
 * returns JSX passes lint even when its rows contain a focus-bearing `<input>` / `<textarea>` /
 * `<select>` (or a `data-field` element). Without a `data-key` (or `id`) the reconciler matches
 * rows by position, and inserting or deleting a row moves the focused field, the caret and the
 * IME state onto the wrong row — the Studio beat/scene/annotation lists shipped that bug.
 *
 * Exempt (documented, kerf-app: a list that never changes identity needs no key):
 *   - a STATIC enumeration: the receiver is an array literal, an `as const` array literal, or an
 *     UPPER_SNAKE_CASE constant, e.g. `["bug", "issue"].map(...)` or `ZOOM_PRESETS.map(...)`;
 *   - a deliberate one-off, marked `// eslint-disable-next-line domotion/mapped-row-data-key -- <why>`.
 */
const FIELD_ELEMENTS = new Set(["input", "textarea", "select"]);
const KEY_ATTRIBUTES = new Set(["data-key", "id"]);

function attributeName(attribute) {
  if (attribute.type !== "JSXAttribute") return null;
  const { name } = attribute;
  return name.type === "JSXNamespacedName" ? `${name.namespace.name}:${name.name.name}` : name.name;
}

function elementName(element) {
  const { name } = element.openingElement;
  return name.type === "JSXIdentifier" ? name.name : null;
}

function hasAttribute(element, wanted) {
  return element.openingElement.attributes.some((a) => {
    const n = attributeName(a);
    return n != null && wanted.has(n);
  });
}

/** True when `node` (a JSX element/fragment) contains a form field anywhere beneath it. */
function containsField(node) {
  if (node.type === "JSXElement") {
    const name = elementName(node);
    if (name != null && FIELD_ELEMENTS.has(name)) return true;
    if (hasAttribute(node, new Set(["data-field"]))) return true;
  }
  for (const child of node.children ?? []) {
    if ((child.type === "JSXElement" || child.type === "JSXFragment") && containsField(child)) return true;
    if (child.type === "JSXExpressionContainer" && expressionContainsField(child.expression)) return true;
  }
  return false;
}

/** Fields nested inside `{cond ? <input/> : null}`, `{cond && <input/>}` and the like. */
function expressionContainsField(expr) {
  if (expr == null) return false;
  switch (expr.type) {
    case "JSXElement":
    case "JSXFragment":
      return containsField(expr);
    case "ConditionalExpression":
      return expressionContainsField(expr.consequent) || expressionContainsField(expr.alternate);
    case "LogicalExpression":
      return expressionContainsField(expr.right) || expressionContainsField(expr.left);
    default:
      return false;
  }
}

/** The JSX roots a callback returns (arrow expression body, or every `return` argument). */
function returnedJsx(callback) {
  const roots = [];
  const collect = (expr) => {
    if (expr == null) return;
    if (expr.type === "JSXElement" || expr.type === "JSXFragment") roots.push(expr);
    else if (expr.type === "ConditionalExpression") {
      collect(expr.consequent);
      collect(expr.alternate);
    } else if (expr.type === "LogicalExpression") collect(expr.right);
  };
  if (callback.body.type !== "BlockStatement") {
    collect(callback.body);
    return roots;
  }
  const visit = (node) => {
    if (node == null || typeof node.type !== "string") return;
    if (node.type === "ReturnStatement") return collect(node.argument);
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    )
      return; // a nested function's returns are not ours
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const value = node[key];
      if (Array.isArray(value)) value.forEach(visit);
      else if (value != null && typeof value === "object") visit(value);
    }
  };
  visit(callback.body);
  return roots;
}

function isStaticEnumeration(receiver) {
  let node = receiver;
  while (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    node = node.expression;
  }
  if (node.type === "ArrayExpression") return true;
  return node.type === "Identifier" && /^[A-Z][A-Z0-9_]*$/.test(node.name);
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require data-key/id on .map() rows that contain a form field, in kerf browser clients.",
    },
    messages: {
      missingKey:
        "This .map() row contains a form field but its root element has no `data-key` (or `id`). Without one the reconciler matches rows by position, so an insert or delete moves focus and the caret onto the wrong row. Add data-key={item.id}, or mark a static list with an eslint-disable comment explaining why.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "map") return;
        const callback = node.arguments[0];
        if (callback == null) return;
        if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") return;
        if (isStaticEnumeration(callee.object)) return;
        for (const root of returnedJsx(callback)) {
          if (root.type === "JSXFragment") {
            // A fragment cannot carry a key attribute the reconciler reads.
            if (containsField(root)) context.report({ node: root, messageId: "missingKey" });
            continue;
          }
          if (containsField(root) && !hasAttribute(root, KEY_ATTRIBUTES)) {
            context.report({ node: root, messageId: "missingKey" });
          }
        }
      },
    };
  },
};
