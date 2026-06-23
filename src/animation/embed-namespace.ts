/**
 * DM-1287 (doc 73): namespace a self-contained animated SVG so it can be nested
 * INSIDE another animated SVG without its document-global names colliding.
 *
 * A template frame embeds a complete `generateAnimatedSvg` document as one
 * frame's content. SVG/CSS names are document-global — they do NOT scope to a
 * nested `<svg>` subtree — so the inner document's generated names clash with the
 * outer animation's identical names (and with sibling template frames):
 *
 *  - **element ids** — `id="viewport-clip"`, `id="f0-bg0"`, glyph defs, gradients,
 *    clips, filters (referenced via `url(#…)` / `href="#…"`).
 *  - **embedded-font families** — `font-family:"dmf0"` in `@font-face` + the
 *    `<text font-family="dmf0">` attrs. A duplicate family name makes a later
 *    `@font-face` win, so text in OTHER frames reshapes to the wrong glyphs.
 *  - **frame / animation classes** — `class="f f-0"`, `class="anim-…"` and their
 *    `.f` / `.f-0` / `.anim-…` style selectors.
 *  - **`@keyframes` names** — `fv-0`, the intra-frame `f0-…` names — and the
 *    `animation:` references to them. A duplicate `@keyframes` wins globally, so
 *    the outer frame-visibility timing gets the inner timeline.
 *  - **the `--scene-dur` custom property** on `:root`.
 *
 * The fix: rewrite every such name with a per-frame token. The vocabulary is
 * fully controlled (domotion's own renderer/animator emits it), so the rewrite is
 * precise. The token must be a valid CSS-ident prefix (start with a letter).
 *
 * This is the same class of problem the `cast` frame sidesteps by sharing the
 * outer embedded-font builder (`manageFonts: false`); a template runs a fully
 * independent `composeAnimateConfig`, so it can't share that state and is
 * namespaced after the fact instead.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const byLengthDesc = (a: string, b: string): number => b.length - a.length;

/** Options for {@link namespaceEmbeddedAnimatedSvg}. */
export interface NamespaceEmbedOptions {
  /**
   * Prefix embedded-font family names (`dmfN`) too. Default `true` — correct when
   * the nested document carries its own `@font-face` rules (a template frame).
   *
   * Pass `false` when the nested document's fonts are DEFERRED to the host
   * pipeline's shared embedded-font builder (a `cast` frame composed with
   * `manageFonts: false`): its `font-family="dmfN"` attrs reference an
   * `@font-face` emitted ONCE at the outer top level, where the names are already
   * globally unique — prefixing them here would dangle the reference. The class /
   * keyframe / id / `--scene-dur` collisions still need fixing, so the rest of the
   * pass runs unchanged.
   */
  namespaceFonts?: boolean;
}

/**
 * Prefix every document-global name in a complete animated-SVG document with
 * `token` (e.g. `"e1_"`). Returns the rewritten SVG string; the input is assumed
 * to be a single `<svg>…</svg>` document as produced by `generateAnimatedSvg`.
 */
export function namespaceEmbeddedAnimatedSvg(svg: string, token: string, opts: NamespaceEmbedOptions = {}): string {
  let out = svg;

  // 1. Element ids + every reference (url(#id) / (xlink:)href="#id"). Longest
  //    name first so an id that is a textual prefix of another can't partial-match.
  const ids = new Set<string>();
  for (const m of out.matchAll(/\sid="([^"]+)"/g)) ids.add(m[1]);
  for (const id of [...ids].sort(byLengthDesc)) {
    const e = escapeRe(id);
    out = out
      .replace(new RegExp(`(\\sid=")${e}(")`, "g"), `$1${token}${id}$2`)
      .replace(new RegExp(`url\\(#${e}\\)`, "g"), `url(#${token}${id})`)
      .replace(new RegExp(`((?:xlink:)?href=")#${e}(")`, "g"), `$1#${token}${id}$2`);
  }

  // 2. Embedded-font families (`dmfN`). Only the `@font-face` declaration and the
  //    `font-family` attr/decl contexts — never a bare global replace, since the
  //    base64 `src` payload could contain the same byte sequence. Skipped when the
  //    fonts are deferred to a shared outer builder (see NamespaceEmbedOptions).
  if (opts.namespaceFonts !== false) {
    out = out
      .replace(/(font-family:\s*")(dmf\d+)(")/g, `$1${token}$2$3`)
      .replace(/(font-family=")(dmf\d+)(")/g, `$1${token}$2$3`);
  }

  // 3. `@keyframes` names + their `animation:` references. A keyframe name is a
  //    domotion-generated token (`fv-0`, `f0-f0a0-0`, …) that never appears as an
  //    id, class, or inside the (hyphen-free) base64 font data, so a word-boundary
  //    replace across the whole doc is safe. Longest-first for prefix safety.
  const keyframes = new Set<string>();
  for (const m of out.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)) keyframes.add(m[1]);
  for (const name of [...keyframes].sort(byLengthDesc)) {
    out = out.replace(new RegExp(`\\b${escapeRe(name)}\\b`, "g"), `${token}${name}`);
  }

  // 4. Classes. Collect the names from `class="…"` attrs (every token is renderer-
  //    generated), then (a) prefix each token in every class attr, and (b) prefix
  //    each known name where it appears as a `.name` selector. The selector pass is
  //    boundary-guarded (`(?![\w-])`) and limited to the collected names so it can
  //    never touch a decimal like `0.22` / `22.500%` in the CSS.
  const classes = new Set<string>();
  for (const m of out.matchAll(/\sclass="([^"]+)"/g)) {
    for (const t of m[1].split(/\s+/)) if (t !== "") classes.add(t);
  }
  out = out.replace(/(\sclass=")([^"]+)(")/g, (_full, a: string, cls: string, c: string) =>
    a + cls.split(/\s+/).map((t) => (t !== "" ? token + t : t)).join(" ") + c,
  );
  for (const name of [...classes].sort(byLengthDesc)) {
    out = out.replace(new RegExp(`\\.${escapeRe(name)}(?![\\w-])`, "g"), `.${token}${name}`);
  }

  // 5. The `--scene-dur` custom property (declaration on `:root` + any `var()`).
  out = out.replace(/--scene-dur\b/g, `--scene-dur-${token}`);

  return out;
}
