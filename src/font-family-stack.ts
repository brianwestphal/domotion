/**
 * Serializable form of Blink's `FontFamily` linked list plus the independent
 * `FontDescription::GenericFamily` value selected while that list is built.
 *
 * Chromium source pins (rev 7d859f271cbda744098ac69f44978d4edfa62be3):
 *
 * - `platform/fonts/font_family.h` stores `kFamilyName` / `kGenericFamily` on
 *   every list node and keeps the decoded (never quoted or escaped) name.
 * - `core/css/resolver/style_builder_converter.cc::ConvertFontFamily` walks
 *   the CSS list in reverse and records the first enum-bearing legacy generic.
 *   Therefore the rightmost legacy generic wins; `system-ui` and `math` are
 *   generic list nodes but do not occupy the legacy descriptor enum.
 * - `core/css/properties/computed_style_utils.cc::ValueForFamily` serializes
 *   generic nodes as identifiers and literal nodes as CSS font-family values.
 *
 * Keep this module browser-safe: it is bundled into CAPTURE_SCRIPT and is also
 * the renderer's sole CSS-aware family-list parser.
 */

export type BlinkGenericFamily =
  | "none"
  | "standard"
  | "webkit-body"
  | "serif"
  | "sans-serif"
  | "monospace"
  | "cursive"
  | "fantasy";

export interface CapturedFontFamilyEntry {
  /** Decoded family name, matching Blink `FontFamily::FamilyName()`. */
  name: string;
  /** Whether Blink stores this node as `FontFamily::Type::kGenericFamily`. */
  type: "family-name" | "generic-family";
}

export interface CapturedFontFamilyStack {
  source: "blink-font-family-stack-v1";
  entries: CapturedFontFamilyEntry[];
  /** Blink's descriptor-wide legacy GenericFamily, independent of the face. */
  genericFamily: BlinkGenericFamily;
}

export interface ParsedFontFamilyEntry extends CapturedFontFamilyEntry {
  /** Whether the CSS token was a quoted string rather than an ident sequence. */
  quoted: boolean;
}

const LIST_GENERIC_NAMES = new Set([
  "cursive",
  "fantasy",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "math",
  "-webkit-standard",
  "-webkit-body",
]);

const LEGACY_GENERIC_NAMES: Readonly<Record<string, BlinkGenericFamily>> = {
  serif: "serif",
  "sans-serif": "sans-serif",
  monospace: "monospace",
  cursive: "cursive",
  fantasy: "fantasy",
  "-webkit-standard": "standard",
  "-webkit-body": "webkit-body",
};

function replacementCodePoint(value: number): string {
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "\ufffd";
  }
  return String.fromCodePoint(value);
}

/** Decode CSS escapes in an identifier sequence or string token. */
export function decodeCssFontFamilyName(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const ch = value[index];
    if (ch !== "\\") {
      output += ch;
      index++;
      continue;
    }
    index++;
    if (index >= value.length) break;
    // Escaped newlines are consumed without contributing a character.
    if (value[index] === "\r") {
      index += value[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (value[index] === "\n" || value[index] === "\f") {
      index++;
      continue;
    }
    let hex = "";
    while (index < value.length && hex.length < 6 && /[0-9a-f]/i.test(value[index])) {
      hex += value[index++];
    }
    if (hex !== "") {
      output += replacementCodePoint(Number.parseInt(hex, 16));
      if (index < value.length && /[\t\n\f\r ]/.test(value[index])) {
        if (value[index] === "\r" && value[index + 1] === "\n") index++;
        index++;
      }
      continue;
    }
    output += value[index++];
  }
  return output;
}

function splitCssFamilyTokens(value: string): string[] {
  const output: string[] = [];
  let token = "";
  let quote = "";
  for (let index = 0; index < value.length; index++) {
    const ch = value[index];
    if (ch === "\\") {
      token += ch;
      if (index + 1 < value.length) token += value[++index];
      continue;
    }
    if (quote !== "") {
      token += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      token += ch;
      continue;
    }
    if (ch === ",") {
      if (token.trim() !== "") output.push(token.trim());
      token = "";
      continue;
    }
    token += ch;
  }
  if (token.trim() !== "") output.push(token.trim());
  return output;
}

/** Parse CSSOM `font-family` without splitting quoted or escaped commas. */
export function parseCssFontFamilyEntries(value: string): ParsedFontFamilyEntry[] {
  return splitCssFamilyTokens(value).map((token): ParsedFontFamilyEntry => {
    const quote = token[0];
    const quoted = token.length >= 2
      && (quote === '"' || quote === "'")
      && token[token.length - 1] === quote;
    const encoded = quoted ? token.slice(1, -1) : token;
    const name = decodeCssFontFamilyName(encoded).trim();
    const generic = !quoted && name === name.toLowerCase() && LIST_GENERIC_NAMES.has(name);
    return { name, type: generic ? "generic-family" : "family-name", quoted };
  }).filter((entry) => entry.name !== "");
}

export function blinkGenericFamilyFromEntries(
  entries: ReadonlyArray<Pick<CapturedFontFamilyEntry, "name" | "type">>,
): BlinkGenericFamily {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "generic-family") continue;
    const generic = LEGACY_GENERIC_NAMES[entry.name];
    if (generic != null) return generic;
  }
  return "none";
}

/** Build the capture record. `uaStandard` represents Blink kStandardFamily. */
export function captureFontFamilyStack(
  cssText: string,
  uaStandard = false,
): CapturedFontFamilyStack {
  const entries: CapturedFontFamilyEntry[] = uaStandard
    ? [{ name: "-webkit-standard", type: "generic-family" }]
    : parseCssFontFamilyEntries(cssText).map(({ name, type }) => ({ name, type }));
  return {
    source: "blink-font-family-stack-v1",
    entries,
    genericFamily: uaStandard ? "standard" : blinkGenericFamilyFromEntries(entries),
  };
}

function serializeCssString(value: string): string {
  let output = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") output += `\\${ch}`;
    else if (cp <= 0x1f || cp === 0x7f) output += `\\${cp.toString(16)} `;
    else output += ch;
  }
  return `${output}"`;
}

/**
 * Produce an unambiguous CSS spelling from the structured record. Literal
 * names are always quoted; genuine generics are the only bare identifiers.
 */
export function serializeCapturedFontFamilyStack(stack: CapturedFontFamilyStack): string {
  return stack.entries.map((entry) => entry.type === "generic-family"
    ? entry.name
    : serializeCssString(entry.name)).join(", ");
}

/** Structured capture wins; the raw string is only a legacy-tree fallback. */
export function capturedFontFamilyCss(
  legacy: string,
  stack?: CapturedFontFamilyStack,
): string {
  if (stack == null || stack.source !== "blink-font-family-stack-v1" || stack.entries.length === 0) {
    return legacy;
  }
  return serializeCapturedFontFamilyStack(stack);
}

/** Stable cache identity for the first captured list node. */
export function capturedFontFamilyHeadIdentity(stack: CapturedFontFamilyStack): string {
  const head = stack.entries[0];
  if (head == null) return "missing:";
  const kind = head.type === "generic-family" ? "generic" : "name";
  return `${kind}:${head.name.toLowerCase()}`;
}
