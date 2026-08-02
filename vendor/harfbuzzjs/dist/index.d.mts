//#region src/helpers.d.ts
type ValueOf<T> = T[keyof T];
//#endregion
//#region src/types.d.ts
interface FontExtents {
  ascender: number;
  descender: number;
  lineGap: number;
}
interface GlyphExtents {
  xBearing: number;
  yBearing: number;
  width: number;
  height: number;
}
interface GlyphInfo {
  /** Either a Unicode code point (before shaping) or a glyph index (after shaping). */
  codepoint: number;
  /** The cluster index of the glyph. */
  cluster: number;
  /** Glyph flags, a combination of {@link GlyphFlag} values. */
  flags: number;
}
interface GlyphPosition {
  /** The x advance of the glyph. */
  xAdvance: number;
  /** The y advance of the glyph. */
  yAdvance: number;
  /** The x offset of the glyph. */
  xOffset: number;
  /** The y offset of the glyph. */
  yOffset: number;
}
interface SvgPathCommand {
  type: string;
  values: number[];
}
interface AxisInfo {
  min: number;
  default: number;
  max: number;
}
interface NameEntry {
  nameId: number;
  language: string;
}
interface FeatureNameIds {
  uiLabelNameId?: number;
  uiTooltipTextNameId?: number;
  sampleTextNameId?: number;
  paramUiLabelNameIds: number[];
}
interface TraceEntry {
  m: string;
  t: unknown[];
  glyphs: boolean;
}
/** EmscriptenModule extended with MODULARIZE runtime methods. */
interface HarfBuzzModule extends EmscriptenModule {
  wasmExports: Record<string, (...args: any[]) => any>;
  addFunction(func: (...args: any[]) => any, signature: string): number;
  removeFunction(funcPtr: number): void;
  stackSave(): number;
  stackAlloc(size: number): number;
  stackRestore(ptr: number): void;
}
declare const GlyphFlag: {
  readonly UNSAFE_TO_BREAK: 1;
  readonly UNSAFE_TO_CONCAT: 2;
  readonly SAFE_TO_INSERT_TATWEEL: 4;
  readonly DEFINED: 7;
};
type GlyphFlag = ValueOf<typeof GlyphFlag>;
//#endregion
//#region src/blob.d.ts
/**
 * An object representing a {@link https://harfbuzz.github.io/harfbuzz-hb-blob.html | HarfBuzz blob}.
 * A blob wraps a chunk of binary data, typically the contents of a font file.
 */
declare class Blob {
  readonly ptr: number;
  /**
   * @param data Binary font data.
   */
  constructor(data: ArrayBuffer);
}
//#endregion
//#region src/face.d.ts
declare const GlyphClass: {
  readonly UNCLASSIFIED: 0;
  readonly BASE_GLYPH: 1;
  readonly LIGATURE: 2;
  readonly MARK: 3;
  readonly COMPONENT: 4;
};
type GlyphClass = ValueOf<typeof GlyphClass>;
/**
 * An object representing a {@link https://harfbuzz.github.io/harfbuzz-hb-face.html | HarfBuzz face}.
 * A face represents a single face in a binary font file and is the
 * foundation for creating Font objects used in text shaping.
 */
declare class Face {
  readonly ptr: number;
  readonly upem: number;
  /**
   * @param blob A Blob containing font data.
   * @param index The index of the font in the blob. (0 for most files,
   *  or a 0-indexed font number if the `blob` came from a font collection file.)
   */
  constructor(blob: Blob, index?: number);
  /** @internal Wrap an existing face pointer. */
  constructor(existingPtr: number);
  /**
   * Return the binary contents of an OpenType table.
   * @param table Table name
   * @returns A Uint8Array of the table data, or undefined if the table is not found.
   */
  referenceTable(table: string): Uint8Array | undefined;
  /**
   * Return variation axis infos.
   * @returns A dictionary mapping axis tags to {min, default, max} values.
   */
  getAxisInfos(): Record<string, AxisInfo>;
  /**
   * Return unicodes the face supports.
   * @returns A Uint32Array of supported Unicode code points.
   */
  collectUnicodes(): Uint32Array;
  /**
   * Return all scripts enumerated in the specified face's
   * GSUB table or GPOS table.
   * @param table The table to query, either "GSUB" or "GPOS".
   * @returns An array of 4-character script tag strings.
   */
  getTableScriptTags(table: "GSUB" | "GPOS"): string[];
  /**
   * Return all features enumerated in the specified face's
   * GSUB table or GPOS table.
   * @param table The table to query, either "GSUB" or "GPOS".
   * @returns An array of 4-character feature tag strings.
   */
  getTableFeatureTags(table: "GSUB" | "GPOS"): string[];
  /**
   * Return language tags in the given face's GSUB or GPOS table, underneath
   * the specified script index.
   * @param table The table to query, either "GSUB" or "GPOS".
   * @param scriptIndex The index of the script to query.
   * @returns An array of 4-character language tag strings.
   */
  getScriptLanguageTags(table: "GSUB" | "GPOS", scriptIndex: number): string[];
  /**
   * Return all features in the specified face's GSUB table or GPOS table,
   * underneath the specified script and language.
   * @param table The table to query, either "GSUB" or "GPOS".
   * @param scriptIndex The index of the script to query.
   * @param languageIndex The index of the language to query.
   * @returns An array of 4-character feature tag strings.
   */
  getLanguageFeatureTags(table: "GSUB" | "GPOS", scriptIndex: number, languageIndex: number): string[];
  /**
   * Fetches a list of all lookups enumerated for the specified feature, in
   * the specified face's GSUB table or GPOS table.
   * @param table The table to query, either "GSUB" or "GPOS".
   * @param featureIndex The index of the requested feature.
   * @returns An array of lookup indexes.
   */
  getFeatureLookups(table: "GSUB" | "GPOS", featureIndex: number): number[];
  /**
   * Get the GDEF class of the requested glyph.
   * @param glyph The glyph to get the class of.
   * @returns The {@link GlyphClass} of the glyph.
   */
  getGlyphClass(glyph: number): GlyphClass;
  /**
   * Return all names in the specified face's name table.
   * @returns An array of {nameId, language} entries.
   */
  listNames(): NameEntry[];
  /**
   * Get the name of the specified face.
   * @param nameId The ID of the name to get.
   * @param language The language of the name to get.
   * @returns The name string.
   */
  getName(nameId: number, language: string): string;
  /**
   * Get the name IDs of the specified feature.
   * @param table The table to query, either "GSUB" or "GPOS".
   * @param featureIndex The index of the feature to query.
   * @returns An object with name IDs, or undefined if not found.
   */
  getFeatureNameIds(table: "GSUB" | "GPOS", featureIndex: number): FeatureNameIds | undefined;
}
//#endregion
//#region src/buffer.d.ts
declare const BufferContentType: {
  readonly INVALID: 0;
  readonly UNICODE: 1;
  readonly GLYPHS: 2;
};
type BufferContentType = ValueOf<typeof BufferContentType>;
declare const BufferSerializeFlag: {
  readonly DEFAULT: 0;
  readonly NO_CLUSTERS: 1;
  readonly NO_POSITIONS: 2;
  readonly NO_GLYPH_NAMES: 4;
  readonly GLYPH_EXTENTS: 8;
  readonly GLYPH_FLAGS: 16;
  readonly NO_ADVANCES: 32;
  readonly DEFINED: 63;
};
type BufferSerializeFlag = ValueOf<typeof BufferSerializeFlag>;
declare const BufferFlag: {
  readonly DEFAULT: 0;
  readonly BOT: 1;
  readonly EOT: 2;
  readonly PRESERVE_DEFAULT_IGNORABLES: 4;
  readonly REMOVE_DEFAULT_IGNORABLES: 8;
  readonly DO_NOT_INSERT_DOTTED_CIRCLE: 16;
  readonly VERIFY: 32;
  readonly PRODUCE_UNSAFE_TO_CONCAT: 64;
  readonly PRODUCE_SAFE_TO_INSERT_TATWEEL: 128;
  readonly DEFINED: 255;
};
type BufferFlag = ValueOf<typeof BufferFlag>;
declare const Direction: {
  readonly INVALID: 0;
  readonly LTR: 4;
  readonly RTL: 5;
  readonly TTB: 6;
  readonly BTT: 7;
};
type Direction = ValueOf<typeof Direction>;
declare const ClusterLevel: {
  readonly MONOTONE_GRAPHEMES: 0;
  readonly MONOTONE_CHARACTERS: 1;
  readonly CHARACTERS: 2;
  readonly GRAPHEMES: 3;
  readonly DEFAULT: 0;
};
type ClusterLevel = ValueOf<typeof ClusterLevel>;
declare const BufferSerializeFormat: {
  readonly INVALID: 0;
  readonly TEXT: number;
  readonly JSON: number;
};
type BufferSerializeFormat = ValueOf<typeof BufferSerializeFormat>;
/**
 * An object representing a {@link https://harfbuzz.github.io/harfbuzz-hb-buffer.html | HarfBuzz buffer}.
 * A buffer holds the input text and its properties before shaping, and the
 * output glyphs and their information after shaping.
 */
declare class Buffer {
  readonly ptr: number;
  /**
   * @param existingPtr @internal Wrap an existing buffer pointer.
   */
  constructor(existingPtr?: number);
  /**
   * Appends a character with the Unicode value of `codePoint` to the buffer,
   * and gives it the initial cluster value of `cluster`. Clusters can be any
   * thing the client wants, they are usually used to refer to the index of the
   * character in the input text stream and are output in the `cluster` field
   * of {@link GlyphInfo}.
   *
   * This function does not check the validity of `codePoint`, it is up to the
   * caller to ensure it is a valid Unicode code point.
   * @param codePoint A Unicode code point.
   * @param cluster The cluster value of `codePoint`.
   */
  add(codePoint: number, cluster: number): void;
  /**
   * Add text to the buffer.
   * @param text Text to be added to the buffer.
   * @param itemOffset The offset of the first character to add to the buffer.
   * @param itemLength The number of characters to add to the buffer, or omit for the end of text.
   */
  addText(text: string, itemOffset?: number, itemLength?: number): void;
  /**
   * Add code points to the buffer.
   * @param codePoints Array of code points to be added to the buffer.
   * @param itemOffset The offset of the first code point to add to the buffer.
   * @param itemLength The number of code points to add to the buffer, or omit for the end of the array.
   */
  addCodePoints(codePoints: number[], itemOffset?: number, itemLength?: number): void;
  /**
   * Set buffer script, language and direction.
   *
   * This needs to be done before shaping.
   */
  guessSegmentProperties(): void;
  /**
   * Set buffer direction explicitly.
   * @param dir A {@link Direction} value.
   */
  setDirection(dir: Direction): void;
  /**
   * Set buffer flags explicitly.
   * @param flags A combination of {@link BufferFlag} values (OR them together).
   */
  setFlags(flags: number): void;
  /**
   * Set buffer language explicitly.
   * @param language The buffer language
   */
  setLanguage(language: string): void;
  /**
   * Set buffer script explicitly.
   * @param script The buffer script
   */
  setScript(script: string): void;
  /**
   * Set the HarfBuzz clustering level.
   *
   * Affects the cluster values returned from shaping.
   * @param level A {@link ClusterLevel} value. See the HarfBuzz manual chapter on Clusters.
   */
  setClusterLevel(level: ClusterLevel): void;
  /** Reset the buffer to its initial status. */
  reset(): void;
  /**
   * Similar to reset(), but does not clear the Unicode functions and the
   * replacement code point.
   */
  clearContents(): void;
  /**
   * Set message func.
   * @param func The function to set. It receives the buffer, font, and message
   * string as arguments. Returning false will skip this shaping step and move
   * to the next one.
   */
  setMessageFunc(func: (buffer: Buffer, font: Font, message: string) => boolean): void;
  /**
   * Get the the number of items in the buffer.
   * @returns The buffer length.
   */
  getLength(): number;
  /**
   * Get the glyph information from the buffer.
   * @returns An array of {@link GlyphInfo} objects.
   */
  getGlyphInfos(): GlyphInfo[];
  /**
   * Get the glyph positions from the buffer.
   * @returns An array of {@link GlyphPosition} objects.
   */
  getGlyphPositions(): GlyphPosition[];
  /**
   * Get the glyph information and positions from the buffer.
   * @returns The glyph information and positions.
   *
   * The glyph information is returned as an array of objects with the
   * properties from getGlyphInfos and getGlyphPositions combined.
   */
  getGlyphInfosAndPositions(): (GlyphInfo & Partial<GlyphPosition>)[];
  /**
   * Update the glyph positions in the buffer.
   * WARNING: Do not use unless you know what you are doing.
   */
  updateGlyphPositions(positions: GlyphPosition[]): void;
  /**
   * Serialize the buffer contents to a string.
   * @param options Serialization options:
   *  - `font`: the font to use for serialization;
   *  - `start`: the starting index of the glyphs (default `0`);
   *  - `end`: the ending index of the glyphs (default end of buffer);
   *  - `format`: a {@link BufferSerializeFormat} value (default `TEXT`);
   *  - `flags`: a combination of {@link BufferSerializeFlag} values (default `0`).
   * @returns The serialized buffer contents.
   */
  serialize(options?: {
    font?: Font;
    start?: number;
    end?: number;
    format?: BufferSerializeFormat;
    flags?: number;
  }): string;
  /**
   * Return the buffer content type.
   *
   * @returns The buffer content type as a {@link BufferContentType} value.
   */
  getContentType(): BufferContentType;
}
//#endregion
//#region src/font-funcs.d.ts
/**
 * An object representing {@link https://harfbuzz.github.io/harfbuzz-hb-font.html | HarfBuzz font functions}.
 * Font functions define the methods used by a Font for lower-level queries
 * like glyph advances and extents. HarfBuzz provides built-in default
 * implementations which can be selectively overridden.
 */
declare class FontFuncs {
  readonly ptr: number;
  constructor();
  /**
   * Set the font's glyph extents function.
   * @param func The callback receives a Font and glyph ID. It should return
   * an object with xBearing, yBearing, width, and height, or undefined on failure.
   */
  setGlyphExtentsFunc(func: (font: Font, glyph: number) => GlyphExtents | undefined): void;
  /**
   * Set the font's glyph from name function.
   * @param func The callback receives a Font and glyph name. It should return
   * the glyph ID, or undefined on failure.
   */
  setGlyphFromNameFunc(func: (font: Font, name: string) => number | undefined): void;
  /**
   * Set the font's glyph horizontal advance function.
   * @param func The callback receives a Font and glyph ID. It should return
   * the horizontal advance of the glyph.
   */
  setGlyphHAdvanceFunc(func: (font: Font, glyph: number) => number): void;
  /**
   * Set the font's glyph vertical advance function.
   * @param func The callback receives a Font and glyph ID. It should return
   * the vertical advance of the glyph.
   */
  setGlyphVAdvanceFunc(func: (font: Font, glyph: number) => number): void;
  /**
   * Set the font's glyph horizontal origin function.
   * @param func The callback receives a Font and glyph ID. It should return
   * the [x, y] horizontal origin of the glyph, or undefined on failure.
   */
  setGlyphHOriginFunc(func: (font: Font, glyph: number) => [number, number] | undefined): void;
  /**
   * Set the font's glyph vertical origin function.
   * @param func The callback receives a Font and glyph ID. It should return
   * the [x, y] vertical origin of the glyph, or undefined on failure.
   */
  setGlyphVOriginFunc(func: (font: Font, glyph: number) => [number, number] | undefined): void;
  /**
   * Set the font's glyph horizontal kerning function.
   * @param func The callback receives a Font, first glyph ID, and second glyph ID.
   * It should return the horizontal kerning of the glyphs.
   */
  setGlyphHKerningFunc(func: (font: Font, firstGlyph: number, secondGlyph: number) => number): void;
  /**
   * Set the font's glyph name function.
   * @param func The callback receives a Font and glyph ID. It should return
   * the name of the glyph, or undefined on failure.
   */
  setGlyphNameFunc(func: (font: Font, glyph: number) => string | undefined): void;
  /**
   * Set the font's nominal glyph function.
   * @param func The callback receives a Font and unicode code point. It should
   * return the nominal glyph of the unicode, or undefined on failure.
   */
  setNominalGlyphFunc(func: (font: Font, unicode: number) => number | undefined): void;
  /**
   * Set the font's variation glyph function.
   * @param func The callback receives a Font, unicode code point, and variation
   * selector. It should return the variation glyph, or undefined on failure.
   */
  setVariationGlyphFunc(func: (font: Font, unicode: number, variationSelector: number) => number | undefined): void;
  /**
   * Set the font's horizontal extents function.
   * @param func The callback receives a Font. It should return an object with
   * ascender, descender, and lineGap, or undefined on failure.
   */
  setFontHExtentsFunc(func: (font: Font) => FontExtents | undefined): void;
  /**
   * Set the font's vertical extents function.
   * @param func The callback receives a Font. It should return an object with
   * ascender, descender, and lineGap, or undefined on failure.
   */
  setFontVExtentsFunc(func: (font: Font) => FontExtents | undefined): void;
}
//#endregion
//#region src/variation.d.ts
/**
 * A {@link https://harfbuzz.github.io/harfbuzz-hb-common.html#hb-variation-t | HarfBuzz variation}.
 *
 * Data type for holding variation data. Registered OpenType variation-axis
 * tags are listed in
 * {@link https://docs.microsoft.com/en-us/typography/opentype/spec/dvaraxisreg | OpenType Axis Tag Registry}.
 */
declare class Variation {
  /** The tag of the variation-axis name. */
  tag: string;
  /** The value of the variation axis. */
  value: number;
  constructor(tag: string, value?: number);
  /**
   * Parses a string into a Variation.
   *
   * The format for specifying variation settings follows. All valid CSS
   * font-variation-settings values other than `normal` and `inherited` are
   * also accepted, though, not documented below.
   *
   * The format is a tag, optionally followed by an equals sign, followed by a
   * number. For example `wght=500`, or `slnt=-7.5`.
   *
   * @param str The string to parse.
   * @returns A Variation, or undefined if the string is not a valid variation.
   */
  static fromString(str: string): Variation | undefined;
  /**
   * Converts the variation to a string in the format understood by
   * {@link Variation.fromString}.
   *
   * Note that the string won't include any whitespace.
   *
   * @returns The variation string.
   */
  toString(): string;
  /** @internal Write this variation into the given hb_variation_t pointer. */
  writeTo(ptr: number): void;
}
//#endregion
//#region src/font.d.ts
/**
 * Metric tags corresponding to [MVAR Value
 * Tags](https://docs.microsoft.com/en-us/typography/opentype/spec/mvar#value-tags).
 */
declare const MetricsTag: {
  /** horizontal ascender. */readonly HORIZONTAL_ASCENDER: number; /** horizontal descender. */
  readonly HORIZONTAL_DESCENDER: number; /** horizontal line gap. */
  readonly HORIZONTAL_LINE_GAP: number; /** horizontal clipping ascent. */
  readonly HORIZONTAL_CLIPPING_ASCENT: number; /** horizontal clipping descent. */
  readonly HORIZONTAL_CLIPPING_DESCENT: number; /** vertical ascender. */
  readonly VERTICAL_ASCENDER: number; /** vertical descender. */
  readonly VERTICAL_DESCENDER: number; /** vertical line gap. */
  readonly VERTICAL_LINE_GAP: number; /** horizontal caret rise. */
  readonly HORIZONTAL_CARET_RISE: number; /** horizontal caret run. */
  readonly HORIZONTAL_CARET_RUN: number; /** horizontal caret offset. */
  readonly HORIZONTAL_CARET_OFFSET: number; /** vertical caret rise. */
  readonly VERTICAL_CARET_RISE: number; /** vertical caret run. */
  readonly VERTICAL_CARET_RUN: number; /** vertical caret offset. */
  readonly VERTICAL_CARET_OFFSET: number; /** x height. */
  readonly X_HEIGHT: number; /** cap height. */
  readonly CAP_HEIGHT: number; /** subscript em x size. */
  readonly SUBSCRIPT_EM_X_SIZE: number; /** subscript em y size. */
  readonly SUBSCRIPT_EM_Y_SIZE: number; /** subscript em x offset. */
  readonly SUBSCRIPT_EM_X_OFFSET: number; /** subscript em y offset. */
  readonly SUBSCRIPT_EM_Y_OFFSET: number; /** superscript em x size. */
  readonly SUPERSCRIPT_EM_X_SIZE: number; /** superscript em y size. */
  readonly SUPERSCRIPT_EM_Y_SIZE: number; /** superscript em x offset. */
  readonly SUPERSCRIPT_EM_X_OFFSET: number; /** superscript em y offset. */
  readonly SUPERSCRIPT_EM_Y_OFFSET: number; /** strikeout size. */
  readonly STRIKEOUT_SIZE: number; /** strikeout offset. */
  readonly STRIKEOUT_OFFSET: number; /** underline size. */
  readonly UNDERLINE_SIZE: number; /** underline offset. */
  readonly UNDERLINE_OFFSET: number;
};
type MetricsTag = ValueOf<typeof MetricsTag>;
/**
 * An object representing a {@link https://harfbuzz.github.io/harfbuzz-hb-font.html | HarfBuzz font}.
 * A font represents a face at a specific size and with certain other
 * parameters (pixels-per-em, variation settings) specified. Fonts are the
 * primary input to the shaping process.
 */
declare class Font {
  readonly ptr: number;
  private _face?;
  private drawPtrs;
  /**
   * @param face A Face to create the font from.
   */
  constructor(face: Face);
  /** @internal Wrap an existing font pointer. */
  constructor(existingPtr: number);
  /** The {@link Face} associated with this font. */
  get face(): Face;
  /**
   * Create a sub font that inherits this font's properties.
   * @returns A new Font object representing the sub font.
   */
  subFont(): Font;
  /**
   * Return font horizontal extents.
   * @returns Object with ascender, descender, and lineGap properties.
   */
  hExtents(): FontExtents;
  /**
   * Return font vertical extents.
   * @returns Object with ascender, descender, and lineGap properties.
   */
  vExtents(): FontExtents;
  /**
   * Return glyph name.
   * @param glyphId ID of the requested glyph in the font.
   * @returns The glyph name string.
   */
  glyphName(glyphId: number): string;
  /**
   * Return a glyph as an SVG path string.
   * @param glyphId ID of the requested glyph in the font.
   * @returns SVG path data string.
   */
  glyphToPath(glyphId: number): string;
  /**
   * Return glyph horizontal advance.
   * @param glyphId ID of the requested glyph in the font.
   * @returns The horizontal advance width.
   */
  glyphHAdvance(glyphId: number): number;
  /**
   * Return glyph vertical advance.
   * @param glyphId ID of the requested glyph in the font.
   * @returns The vertical advance height.
   */
  glyphVAdvance(glyphId: number): number;
  /**
   * Return glyph horizontal origin.
   * @param glyphId ID of the requested glyph in the font.
   * @returns [x, y] origin coordinates, or undefined if not available.
   */
  glyphHOrigin(glyphId: number): [number, number] | undefined;
  /**
   * Return glyph vertical origin.
   * @param glyphId ID of the requested glyph in the font.
   * @returns [x, y] origin coordinates, or undefined if not available.
   */
  glyphVOrigin(glyphId: number): [number, number] | undefined;
  /**
   * Return glyph extents.
   * @param glyphId ID of the requested glyph in the font.
   * @returns An object with xBearing, yBearing, width, and height, or undefined.
   */
  glyphExtents(glyphId: number): GlyphExtents | undefined;
  /**
   * Fetches the glyph ID for a Unicode code point in the specified
   * font, with an optional variation selector.
   *
   * If `variationSelector` is 0, it is equivalent to
   * {@link Font.nominalGlyph}; otherwise it is equivalent to
   * {@link Font.variationGlyph}.
   *
   * @param unicode The Unicode code point to query.
   * @param variationSelector A variation-selector code point.
   * @returns The glyph ID, or undefined if not found.
   */
  glyph(unicode: number, variationSelector?: number): number | undefined;
  /**
   * Fetches the nominal glyph ID for a Unicode code point in the
   * specified font.
   *
   * This version of the function should not be used to fetch glyph IDs
   * for code points modified by variation selectors. For variation-selector
   * support, use {@link Font.variationGlyph} or {@link Font.glyph}.
   *
   * @param unicode The Unicode code point to query.
   * @returns The glyph ID, or undefined if not found.
   */
  nominalGlyph(unicode: number): number | undefined;
  /**
   * Fetches the glyph ID for a Unicode code point when followed by
   * by the specified variation-selector code point, in the specified
   * font.
   *
   * @param unicode The Unicode code point to query.
   * @param variationSelector The variation-selector code point to query.
   * @returns The glyph ID, or undefined if not found.
   */
  variationGlyph(unicode: number, variationSelector: number): number | undefined;
  /**
   * Return glyph ID from name.
   * @param name Name of the requested glyph in the font.
   * @returns The glyph ID, or undefined if not found.
   */
  glyphFromName(name: string): number | undefined;
  /**
   * Return a glyph as a JSON path string
   * based on format described on https://svgwg.org/specs/paths/#InterfaceSVGPathSegment
   * @param glyphId ID of the requested glyph in the font.
   * @returns An array of path segment objects with type and values.
   */
  glyphToJson(glyphId: number): SvgPathCommand[];
  /**
   * Set the font's scale factor, affecting the position values returned from
   * shaping.
   * @param xScale Units to scale in the X dimension.
   * @param yScale Units to scale in the Y dimension.
   */
  setScale(xScale: number, yScale: number): void;
  /**
   * LOCAL ADDITION (not upstream harfbuzzjs) — see ../README.md.
   * Sets the nominal point size HarfBuzz uses to look up AAT `trak` tracking.
   * Blink passes the CSS pixel size; leaving it 0 applies no tracking.
   */
  setPtem(ptem: number): void;
  /**
   * Applies a list of font-variation settings to a font.
   *
   * Note that this overrides all existing variations set on the font.
   * Axes not included in `variations` will be effectively set to their
   * default values.
   *
   * @param variations Array of variation settings to apply.
   */
  setVariations(variations: Variation[]): void;
  /** Set the font's font functions. */
  setFuncs(fontFuncs: FontFuncs): void;
  /**
   * Fetches the optical bound of a glyph positioned at the margin of text.
   * The direction identifies which edge of the glyph to query.
   * @param lookupIndex Index of the feature lookup to query.
   * @param direction Edge of the glyph to query.
   * @param glyph A glyph id.
   * @returns Adjustment value. Negative values mean the glyph will stick out of the margin.
   */
  getLookupOpticalBound(lookupIndex: number, direction: Direction, glyph: number): number;
  /**
   * Fetches a list of the caret positions defined for a ligature glyph in the
   * GDEF table of the font.
   *
   * Note that a ligature that is formed from n characters will have n-1
   * caret positions. The first character is not represented in the array,
   * since its caret position is the glyph position.
   *
   * The positions returned by this function are 'unshaped', and will have to
   * be fixed up for kerning that may be applied to the ligature glyph.
   *
   * @param direction The text direction to use.
   * @param glyph The glyph to query.
   * @returns An array of caret positions.
   */
  getLigatureCarets(direction: Direction, glyph: number): number[];
  /**
   * Fetches metrics value corresponding to `metricsTag` from the font.
   *
   * @param metricsTag {@link MetricsTag} of metrics value you like to fetch.
   * @returns The metrics value, or undefined if not found in the font.
   */
  getMetricPosition(metricsTag: MetricsTag): number | undefined;
  /**
   * Fetches metrics value corresponding to `metricsTag` from the font, and
   * synthesizes a value if the value is missing in the font.
   *
   * @param metricsTag {@link MetricsTag} of metrics value you like to fetch.
   * @returns The metrics value.
   */
  getMetricPositionWithFallback(metricsTag: MetricsTag): number;
  /**
   * Fetches metrics value corresponding to `metricsTag` from the font with the
   * current font variation settings applied.
   *
   * @param metricsTag {@link MetricsTag} of metrics value you like to fetch.
   * @returns The requested metric value.
   */
  getMetricVariation(metricsTag: MetricsTag): number;
  /**
   * Fetches horizontal metrics value corresponding to `metricsTag` from the
   * font with the current font variation settings applied.
   *
   * @param metricsTag {@link MetricsTag} of metrics value you like to fetch.
   * @returns The requested metric value.
   */
  getMetricXVariation(metricsTag: MetricsTag): number;
  /**
   * Fetches vertical metrics value corresponding to `metricsTag` from the font
   * with the current font variation settings applied.
   *
   * @param metricsTag {@link MetricsTag} of metrics value you like to fetch.
   * @returns The requested metric value.
   */
  getMetricYVariation(metricsTag: MetricsTag): number;
}
//#endregion
//#region src/feature.d.ts
/**
 * A {@link https://harfbuzz.github.io/harfbuzz-hb-common.html#hb-feature-t | HarfBuzz feature}.
 *
 * The structure that holds information about requested feature application.
 * The feature will be applied with the given value to all glyphs which are in
 * clusters between {@link Feature.start} (inclusive) and {@link Feature.end}
 * (exclusive). Setting `start` to `0` and `end` to `0xffffffff` specifies that
 * the feature always applies to the entire buffer.
 */
declare class Feature {
  /**
   * Special setting for {@link Feature.start} to apply the feature from the
   * start of the buffer.
   */
  static readonly GLOBAL_START = 0;
  /**
   * Special setting for {@link Feature.end} to apply the feature from to the
   * end of the buffer.
   */
  static readonly GLOBAL_END = 4294967295;
  /** The tag of the feature. */
  tag: string;
  /**
   * The value of the feature. `0` disables the feature, non-zero (usually `1`)
   * enables the feature. For features implemented as lookup type 3 (like
   * `salt`) the value is a one-based index into the alternates.
   */
  value: number;
  /** The cluster to start applying this feature setting (inclusive). */
  start: number;
  /** The cluster to end applying this feature setting (exclusive). */
  end: number;
  constructor(tag: string, value?: number, start?: number, end?: number);
  /**
   * Parses a string into a Feature.
   *
   * The format for specifying feature strings follows. All valid CSS
   * font-feature-settings values other than `normal` and the global values are
   * also accepted, though not documented below. CSS string escapes are not
   * supported.
   *
   * The range indices refer to the positions between Unicode characters. The
   * position before the first character is always 0.
   *
   * The format is Python-esque. Here is how it all works:
   *
   * | Syntax        | Value | Start | End | Meaning                          |
   * | ------------- | ----- | ----- | --- | -------------------------------- |
   * | `kern`        | 1     | 0     | ∞   | Turn feature on                  |
   * | `+kern`       | 1     | 0     | ∞   | Turn feature on                  |
   * | `-kern`       | 0     | 0     | ∞   | Turn feature off                 |
   * | `kern=0`      | 0     | 0     | ∞   | Turn feature off                 |
   * | `kern=1`      | 1     | 0     | ∞   | Turn feature on                  |
   * | `aalt=2`      | 2     | 0     | ∞   | Choose 2nd alternate             |
   * | `kern[]`      | 1     | 0     | ∞   | Turn feature on                  |
   * | `kern[:]`     | 1     | 0     | ∞   | Turn feature on                  |
   * | `kern[5:]`    | 1     | 5     | ∞   | Turn feature on, partial         |
   * | `kern[:5]`    | 1     | 0     | 5   | Turn feature on, partial         |
   * | `kern[3:5]`   | 1     | 3     | 5   | Turn feature on, range           |
   * | `kern[3]`     | 1     | 3     | 3+1 | Turn feature on, single char     |
   * | `aalt[3:5]=2` | 2     | 3     | 5   | Turn 2nd alternate on for range  |
   *
   * @param str The string to parse.
   * @returns A Feature, or undefined if the string is not a valid feature.
   */
  static fromString(str: string): Feature | undefined;
  /**
   * Converts the feature to a string in the format understood by
   * {@link Feature.fromString}.
   *
   * Note that the feature value will be omitted if it is `1`, but the string
   * won't include any whitespace.
   *
   * @returns The feature string.
   */
  toString(): string;
  /** @internal Write this feature into the given hb_feature_t pointer. */
  writeTo(ptr: number): void;
}
//#endregion
//#region src/shape.d.ts
declare const TracePhase: {
  readonly DONT_STOP: 0;
  readonly GSUB: 1;
  readonly GPOS: 2;
};
type TracePhase = ValueOf<typeof TracePhase>;
/**
 * Shape a buffer with a given font.
 *
 * Converts the Unicode text in the buffer into positioned glyphs.
 * The buffer is modified in place.
 *
 * @param font The Font to shape with.
 * @param buffer The Buffer containing text to shape, suitably prepared
 *   (text added, segment properties set).
 * @param features An array of {@link Feature} values to apply.
 */
declare function shape(font: Font, buffer: Buffer, features?: Feature[]): void;
/**
 * Shape a buffer with a given font, returning a JSON trace of the shaping process.
 *
 * This function supports "partial shaping", where the shaping process is
 * terminated after a given lookup ID is reached.
 *
 * @param font The Font to shape with.
 * @param buffer The Buffer containing text to shape, suitably prepared.
 * @param features An array of {@link Feature} values to apply.
 * @param stop_at A lookup ID at which to terminate shaping.
 * @param stop_phase The {@link TracePhase} at which to stop shaping.
 * @returns An array of trace entries, each with a message, serialized glyphs, and phase info.
 */
declare function shapeWithTrace(font: Font, buffer: Buffer, features: Feature[], stop_at: number, stop_phase: TracePhase): TraceEntry[];
/**
 * Return the HarfBuzz version.
 * @returns An object with major, minor, and micro version numbers.
 */
declare function version(): {
  major: number;
  minor: number;
  micro: number;
};
/**
 * Return the HarfBuzz version as a string.
 * @returns A version string in the form "major.minor.micro".
 */
declare function versionString(): string;
/**
 * Convert an OpenType script tag to HarfBuzz script.
 * @param tag The tag to convert.
 * @returns The script.
 */
declare function otTagToScript(tag: string): string;
/**
 * Convert an OpenType language tag to HarfBuzz language.
 * @param tag The tag to convert.
 * @returns The language.
 */
declare function otTagToLanguage(tag: string): string;
//#endregion
export { AxisInfo, Blob, Buffer, BufferContentType, BufferFlag, BufferSerializeFlag, BufferSerializeFormat, ClusterLevel, Direction, Face, Feature, FeatureNameIds, Font, FontExtents, FontFuncs, GlyphClass, GlyphExtents, GlyphFlag, GlyphInfo, GlyphPosition, HarfBuzzModule, MetricsTag, NameEntry, SvgPathCommand, TraceEntry, TracePhase, Variation, otTagToLanguage, otTagToScript, shape, shapeWithTrace, version, versionString };