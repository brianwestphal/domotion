/** Bounded var() substitution for a known isolated root cascade; names are case-sensitive. */
export function resolveImageCssVariables(
  value: string,
  get: (name: string) => string | null | undefined,
): string | null {
  if (value.length > 65536) return null;
  const invalid = new Set<string>();
  const dependencies = (text: string): string[] => {
    const names: string[] = [];
    let quote = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quote !== "") {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      const match = /^var\(\s*(--[-\w]+)/i.exec(text.slice(i));
      if (match != null && (i === 0 || !/[-\w]/.test(text[i - 1]))) names.push(match[1]);
    }
    return names;
  };
  const visited = new Set<string>();
  let graphBudget = 256;
  let unknown = false;
  const inspect = (name: string, stack: string[]): void => {
    const cycle = stack.indexOf(name);
    if (cycle >= 0) {
      for (const member of stack.slice(cycle)) invalid.add(member);
      return;
    }
    if (visited.has(name)) return;
    if (--graphBudget < 0 || stack.length > 32) {
      unknown = true;
      return;
    }
    const raw = get(name);
    if (raw === undefined || (raw != null && (raw.length > 65536 || /^(?:revert|revert-layer)$/i.test(raw.trim())))) {
      unknown = true;
      return;
    }
    if (raw != null) for (const dependency of dependencies(raw)) inspect(dependency, [...stack, name]);
    visited.add(name);
  };
  for (const name of dependencies(value)) inspect(name, []);
  if (unknown) return null;
  let budget = 256;
  const expand = (text: string, stack: string[]): string | null => {
    if (--budget < 0 || text.length > 65536 || stack.length > 32) return null;
    let out = "",
      quote = "";
    for (let i = 0; i < text.length;) {
      const ch = text[i];
      if (quote !== "") {
        out += ch;
        if (ch === "\\" && i + 1 < text.length) out += text[++i];
        else if (ch === quote) quote = "";
        i++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
        i++;
        continue;
      }
      if (text.startsWith("/*", i)) {
        const end = text.indexOf("*/", i + 2);
        if (end < 0) return null;
        out += text.slice(i, end + 2);
        i = end + 2;
        continue;
      }
      if (!/^var\(/i.test(text.slice(i)) || (i > 0 && /[-\w]/.test(text[i - 1]))) {
        out += ch;
        i++;
        continue;
      }
      let depth = 1,
        innerQuote = "",
        comma = -1,
        end = i + 4;
      for (; end < text.length && depth > 0; end++) {
        const c = text[end];
        if (innerQuote !== "") {
          if (c === "\\") end++;
          else if (c === innerQuote) innerQuote = "";
        } else if (c === '"' || c === "'") innerQuote = c;
        else if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "," && depth === 1 && comma < 0) comma = end;
      }
      if (depth !== 0) return null;
      const name = text.slice(i + 4, comma < 0 ? end - 1 : comma).trim();
      if (!/^--[-\w]+$/.test(name)) return null;
      let replacement: string | null = null;
      const cycle = stack.indexOf(name);
      if (cycle >= 0) for (const member of stack.slice(cycle)) invalid.add(member);
      else if (!invalid.has(name)) {
        const raw = get(name);
        if (raw != null && /^(?:revert|revert-layer)$/i.test(raw.trim())) return null;
        if (raw != null && !/^(?:initial|inherit|unset|revert|revert-layer)$/i.test(raw.trim()))
          replacement = expand(raw, [...stack, name]);
        if (invalid.has(name)) replacement = null;
      }
      if (replacement == null && comma >= 0) replacement = expand(text.slice(comma + 1, end - 1), stack);
      if (replacement == null) return null;
      // Token boundaries must survive substitution (e.g. var(--n)px is not 12px).
      out += ` ${replacement} `;
      i = end;
    }
    return out;
  };
  return expand(value, []);
}
