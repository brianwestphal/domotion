/** CSS variable token substitution over Blink's already-computed custom data.
 * Unlike authored variable cascade resolution, an absent computed variable is
 * known invalid, not an invitation to inspect another CSS rule. */
import { referenceCssIdentifier, referenceCssString } from "../render/svg-image-reference-syntax.js";
export type FamilyValue = { kind: "value"; value: string } | { kind: "invalid" } | { kind: "unknown"; reason: string };
const unknown = (reason: string): FamilyValue => ({ kind: "unknown", reason });
export function substituteComputedFontVariables(value: string, variables: ReadonlyMap<string, string>): FamilyValue {
  let budget = 256;
  const expand = (text: string, depth: number): FamilyValue => {
    if (text.length > 65536 || depth > 32 || --budget < 0) return unknown("font substitution budget exceeded");
    let out = "";
    for (let at = 0; at < text.length;) {
      if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end < 0) return unknown("unterminated font value comment");
        out += text.slice(at, end + 2);
        at = end + 2;
        continue;
      }
      if (text[at] === '"' || text[at] === "'") {
        const string = referenceCssString(text, at);
        if (string == null) return unknown("unreadable font value string");
        out += text.slice(at, string.end);
        at = string.end;
        continue;
      }
      const ident = referenceCssIdentifier(text, at);
      if (ident == null) {
        out += text[at++];
        continue;
      }
      if (text[ident.end] !== "(") {
        out += text.slice(at, ident.end);
        at = ident.end;
        continue;
      }
      const functionName = ident.value.toLowerCase();
      // env/attr/if and arbitrary function contexts need their own native
      // authority; do not turn an unsupported resolver result into unset.
      if (functionName !== "var") return unknown("font value contains an unsupported function");
      const start = ident.end + 1;
      let end = start,
        nesting = 1,
        comma = -1;
      for (; end < text.length && nesting > 0; end++) {
        if (text.startsWith("/*", end)) {
          const close = text.indexOf("*/", end + 2);
          if (close < 0) return unknown("unterminated variable comment");
          end = close + 1;
          continue;
        }
        if (text[end] === '"' || text[end] === "'") {
          const string = referenceCssString(text, end);
          if (string == null) return unknown("unreadable variable string");
          end = string.end - 1;
          continue;
        }
        const token = referenceCssIdentifier(text, end);
        if (token != null) {
          end = token.end - 1;
          continue;
        }
        if (text[end] === "(") nesting++;
        else if (text[end] === ")") nesting--;
        else if (text[end] === "," && nesting === 1 && comma < 0) comma = end;
      }
      if (nesting !== 0) return unknown("unbalanced font variable");
      const nameText = text
        .slice(start, comma < 0 ? end - 1 : comma)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .trim();
      const name = referenceCssIdentifier(nameText, 0);
      if (name == null || name.end !== nameText.length || !name.value.startsWith("--"))
        return unknown("unreadable custom property name");
      const computed = variables.get(name.value);
      let replacement: FamilyValue;
      if (computed == null)
        replacement = comma < 0 ? { kind: "invalid" } : expand(text.slice(comma + 1, end - 1), depth + 1);
      else {
        // Native computed data has already resolved references/cycles. A var()
        // reference here is incomplete evidence; never re-run another cascade.
        replacement = expand(computed, depth + 1);
      }
      if (replacement.kind !== "value") return replacement;
      out += `/**/${replacement.value}/**/`;
      at = end;
    }
    return out.length > 65536 ? unknown("font substitution output exceeded budget") : { kind: "value", value: out };
  };
  return expand(value, 0);
}
