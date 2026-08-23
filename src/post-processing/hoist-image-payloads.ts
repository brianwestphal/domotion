/**
 * Hoist duplicated raster payloads out of an assembled SVG document.
 *
 * Every `<image href="data:…">` the renderer emits carries its bytes inline, and
 * the emit is per-element — so an image that appears in N places is serialized N
 * times. In a multi-frame animated SVG that N is the frame count: three static
 * plates across 26 frames measured 137.3 KB raw, 47.5 KB once shared, the same
 * three payloads having been re-encoded 26 times each. Compressed, the
 * duplication was always cheap (10.8 → 10.1 KB gzip), which is why it survived
 * unnoticed — the cost is raw size, parse time, and viewer memory.
 *
 * Cross-frame asset sharing already exists for the other asset classes: the
 * embedded-font builder emits one `@font-face` block for the whole document and
 * the paths-mode glyph registry emits each glyph once as a `<path id="gN">` that
 * frames reference with `<use>`. This pass gives images the same treatment, as a
 * post-pass over the finished document rather than at the ~20 `<image>` emit
 * sites: each distinct payload becomes one `<image id="dmiN">` in a top-level
 * `<defs>`, and every occurrence becomes a `<use href="#dmiN">`.
 *
 * Two things about `<use>` geometry drive the shape of the rewrite. Both were
 * measured against Chromium (rasterize-and-pixel-compare, not read off a spec):
 *
 *  1. **`width` / `height` on a `<use>` do NOT override the referenced
 *     `<image>`.** They only apply when the referent is a `<symbol>` or `<svg>`.
 *     So the def has to carry the size, and the dedupe key is
 *     `href + width + height + preserveAspectRatio` — not the payload alone.
 *     That still collapses the case that matters (one plate at one size across N
 *     frames) and stays correct when a payload appears at two sizes, which then
 *     gets one def each. (A `<symbol>` wrapper WOULD let one def serve every
 *     size, and was verified to work; it isn't used because the resize-on-embed
 *     pre-pass already makes distinct sizes distinct payloads, so the extra
 *     indirection would buy almost nothing.)
 *
 *  2. **`x` / `y` on a `<use>` are a translate, and a translate moves the
 *     element's own `clip-path` with it** — whereas `x`/`y` on an `<image>` are
 *     geometry and leave its clip where the author put it. Every clip we emit is
 *     in absolute page coordinates, so moving a clipped `<image>`'s `x`/`y` onto
 *     the `<use>` shifts the clip by that same offset and cuts the wrong region.
 *     Coordinate-sensitive attributes therefore move to a wrapping `<g>` (which
 *     has no transform of its own) and only the untranslated `<use>` sits inside
 *     it. The naive version — clip-path left on the translated `<use>` — renders
 *     visibly wrong, which is why the wrapper is not optional.
 *
 * The pass is conservative by construction: it rewrites nothing unless a payload
 * appears at least twice at identical geometry, it skips any `<image>` tag whose
 * attributes don't parse as plain double-quoted pairs (e.g. verbatim inline SVG
 * captured from the page), and it leaves payloads below `minPayloadChars` alone
 * since a `<use>` costs ~35 bytes of its own. A document with nothing to share
 * comes back byte-identical.
 *
 * Applying it twice is safe. A nested animated SVG (a storyboard scene, a
 * typing-resample flipbook) is hoisted when it is composed and then hoisted
 * again as part of the outer document; the second pass recognizes the inner
 * `<image id="…">` def as a def and reuses it as the canonical one rather than
 * building a chain of indirection.
 */

/** Attributes the `<defs>` `<image>` carries, so they must not be re-emitted on the `<use>`. */
const DEF_ATTRS = new Set(["href", "width", "height", "preserveAspectRatio"]);

/**
 * Attributes that resolve against the element's own user space, so they must NOT
 * ride the `<use>` whose `x`/`y` translate that space. They move to a wrapping
 * `<g>` instead. `style` / `class` are included because either can carry a
 * `transform` via CSS.
 */
const COORD_SENSITIVE_ATTRS = new Set(["clip-path", "mask", "filter", "transform", "style", "class"]);

/** One `<image>` element located in the source, with its attributes parsed. */
interface ParsedImage {
  /** Index of `<` in the source. */
  start: number;
  /** Index just past the element (past `/>` or `</image>`). */
  end: number;
  attrs: Array<{ name: string; value: string }>;
  /** Inner markup for the paired form (`<image …><title>…</title></image>`), else "". */
  children: string;
}

export interface HoistImagePayloadsOptions {
  /**
   * Minimum `href` length (characters) for a payload to be worth hoisting.
   * A `<use>` replacement costs ~35 bytes, so hoisting a tiny data URI can grow
   * the file. Default 256 (≈192 bytes of image data) — well above the ~90-char
   * 1×1 placeholder PNGs that fixtures use, well below any real asset.
   */
  minPayloadChars?: number;
}

/**
 * Parse a tag's attribute text into ordered name/value pairs. Returns null when
 * anything doesn't fit `name="value"` with a double-quoted value — a signal to
 * leave the element completely alone rather than guess. The renderer always
 * emits that shape (values run through `esc()`, which escapes `"` and `>`), so
 * a rejection means the markup came from somewhere else, e.g. inline SVG copied
 * verbatim out of the captured page.
 */
function parseAttrs(text: string): Array<{ name: string; value: string }> | null {
  const attrs: Array<{ name: string; value: string }> = [];
  const re = /\s*([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) != null) {
    if (m.index !== pos) return null; // unparsed junk between attributes
    attrs.push({ name: m[1], value: m[2] });
    pos = m.index + m[0].length;
  }
  if (text.slice(pos).trim() !== "") return null; // trailing junk
  return attrs;
}

/** Locate every `<image>` element in `svg`, skipping any whose markup we can't parse. */
function findImages(svg: string): ParsedImage[] {
  const out: ParsedImage[] = [];
  const re = /<image\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) != null) {
    let attrText = m[1];
    const selfClosing = attrText.trimEnd().endsWith("/");
    if (selfClosing) attrText = attrText.trimEnd().slice(0, -1);
    const attrs = parseAttrs(attrText);
    let end = m.index + m[0].length;
    let children = "";
    if (!selfClosing) {
      // `<image>` can't nest, so the next close tag is ours.
      const close = svg.indexOf("</image>", end);
      if (close === -1) continue; // malformed; leave it alone
      children = svg.slice(end, close);
      end = close + "</image>".length;
      re.lastIndex = end;
    }
    if (attrs == null) continue;
    out.push({ start: m.index, end, attrs, children });
  }
  return out;
}

function attrValue(img: ParsedImage, name: string): string | null {
  for (let i = img.attrs.length - 1; i >= 0; i--) {
    if (img.attrs[i].name === name) return img.attrs[i].value;
  }
  return null;
}

/**
 * True when this `<image>` is already a hoisted def — an id'd, unpositioned
 * element carrying nothing but its geometry — so a later pass over a document
 * that embeds it can point at it instead of introducing another level of
 * indirection.
 */
function isPureDef(img: ParsedImage): boolean {
  if (img.children !== "") return false;
  if (attrValue(img, "id") == null) return false;
  return img.attrs.every((a) => a.name === "id" || DEF_ATTRS.has(a.name));
}

const fmtAttrs = (attrs: Array<{ name: string; value: string }>): string =>
  attrs.map((a) => ` ${a.name}="${a.value}"`).join("");

/**
 * Rewrite `svg` so each raster payload that appears more than once at identical
 * geometry is serialized exactly once, in a top-level `<defs>`, and referenced
 * from every occurrence with `<use>`. Returns the input unchanged when there is
 * nothing to share.
 */
export function hoistDuplicateImagePayloads(svg: string, opts: HoistImagePayloadsOptions = {}): string {
  const minPayloadChars = opts.minPayloadChars ?? 256;
  const images = findImages(svg);
  if (images.length < 2) return svg;

  // Group by everything the def owns: `<use>` can't override any of it.
  const groups = new Map<string, ParsedImage[]>();
  for (const img of images) {
    if (attrValue(img, "xlink:href") != null) continue; // legacy ref form; not ours
    // Effect-space rasters must remain concrete <image> nodes: Chromium does
    // not apply SVG mix-blend-mode equivalently when the same bitmap is moved
    // behind a translated <use> reference (DM-2495).
    if (attrValue(img, "data-domotion-no-hoist") != null) continue;
    const href = attrValue(img, "href");
    if (href == null || !href.startsWith("data:") || href.length < minPayloadChars) continue;
    const width = attrValue(img, "width");
    const height = attrValue(img, "height");
    if (width == null || height == null) continue; // intrinsically-sized; rare and not worth the risk
    const key = `${width}|${height}|${attrValue(img, "preserveAspectRatio") ?? ""}|${href}`;
    const bucket = groups.get(key);
    if (bucket == null) groups.set(key, [img]);
    else bucket.push(img);
  }

  // Ids must not collide with anything already in the document (a nested
  // animated SVG arrives with its own namespaced ids).
  const takenIds = new Set<string>();
  for (const m of svg.matchAll(/\sid="([^"]+)"/g)) takenIds.add(m[1]);
  let idCounter = 0;
  const nextId = (): string => {
    let id = `dmi${idCounter++}`;
    while (takenIds.has(id)) id = `dmi${idCounter++}`;
    takenIds.add(id);
    return id;
  };

  /** start → replacement markup, for the occurrences being rewritten. */
  const replacements = new Map<number, string>();
  const newDefs: string[] = [];

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // Reuse an existing def as the canonical one when the document already has
    // one (a hoisted nested SVG); otherwise mint a fresh def.
    const existing = members.find(isPureDef);
    let defId: string;
    let toRewrite: ParsedImage[];
    if (existing != null) {
      defId = attrValue(existing, "id")!;
      toRewrite = members.filter((m) => m !== existing);
    } else {
      const first = members[0];
      defId = nextId();
      const par = attrValue(first, "preserveAspectRatio");
      newDefs.push(
        `<image id="${defId}" width="${attrValue(first, "width")!}" height="${attrValue(first, "height")!}"`
        + (par != null ? ` preserveAspectRatio="${par}"` : "")
        + ` href="${attrValue(first, "href")!}"/>`,
      );
      toRewrite = members;
    }
    for (const img of toRewrite) {
      const coordAttrs = img.attrs.filter((a) => COORD_SENSITIVE_ATTRS.has(a.name));
      const useAttrs = img.attrs.filter(
        (a) => !COORD_SENSITIVE_ATTRS.has(a.name) && !DEF_ATTRS.has(a.name) && a.name !== "x" && a.name !== "y",
      );
      const x = attrValue(img, "x");
      const y = attrValue(img, "y");
      const useTag = `<use href="#${defId}"`
        + (x != null ? ` x="${x}"` : "")
        + (y != null ? ` y="${y}"` : "")
        + fmtAttrs(useAttrs)
        + `/>`;
      replacements.set(
        img.start,
        coordAttrs.length === 0 && img.children === ""
          ? useTag
          // The `<g>` holds the clip/mask/filter so it resolves in the ORIGINAL
          // user space; the `<use>` inside carries only the translate.
          : `<g${fmtAttrs(coordAttrs)}>${img.children}${useTag}</g>`,
      );
    }
  }

  if (replacements.size === 0) return svg;

  // Splice the rewrites in source order.
  const parts: string[] = [];
  let cursor = 0;
  for (const img of images) {
    const rep = replacements.get(img.start);
    if (rep == null) continue;
    parts.push(svg.slice(cursor, img.start), rep);
    cursor = img.end;
  }
  parts.push(svg.slice(cursor));
  let out = parts.join("");

  if (newDefs.length > 0) {
    // Insert AFTER any leading `<title>` / `<desc>`: an accessible name has to
    // stay the root's first child, so a `<defs>` in front of it would silently
    // cost the document its name.
    const head = /(<svg\b[^>]*>)((?:\s*<title>[\s\S]*?<\/title>|\s*<desc>[\s\S]*?<\/desc>)*)/.exec(out);
    if (head == null) return svg; // no root <svg> to hang defs off; leave untouched
    const at = head.index + head[0].length;
    out = `${out.slice(0, at)}<defs>${newDefs.join("")}</defs>${out.slice(at)}`;
  }
  return out;
}
