/**
 * The typed fontkit boundary.
 *
 * fontkit ships no typings that cover what this package reads (collections,
 * variation instancing, raw `fvar` / `name` / `OS/2` records), so `globals.d.ts`
 * declares the module untyped and every value read from it is implicitly `any`.
 * This module is the one place that untyped module is imported for face access:
 * it names the subset of fontkit's runtime object model the renderer actually
 * reads, so the rest of the code works against these shapes instead of `any`.
 *
 * The shapes describe fontkit's runtime objects as they are (fontkit 2.x
 * `TTFFont` / `TrueTypeCollection` / `DFont`); a field is optional wherever
 * fontkit leaves it undefined for some face (a static face has no `fvar`, a
 * collection has no `postscriptName`). Glyph outlines, shaping and metrics keep
 * the `FontInstance` contract, which fontkit faces satisfy and the native
 * helpers implement too.
 */
import * as fontkitModule from "fontkit";

import type { FontInstance } from "./font-instance.js";

/** One entry of fontkit's `variationAxes` getter (axis tag → range). */
export interface FontkitVariationAxis {
  name?: string;
  min: number;
  default: number;
  max: number;
}

/** A raw `fvar` axis record. */
export interface FontkitFvarAxis {
  axisTag?: string;
  minValue?: number;
  defaultValue?: number;
  maxValue?: number;
}

/** A raw `fvar` named-instance record; `coord` is in `fvar.axis` order. */
export interface FontkitFvarInstance {
  nameID?: number;
  postscriptNameID?: number;
  coord?: number[];
}

/** A `name`-table entry: a plain string or a language-keyed map. */
export type FontkitNameRecord = string | Record<string, string | undefined>;

/** The `OS/2` fields read here. fontkit parses `fsSelection` as a bitfield object (older builds: a number). */
export interface FontkitOs2Table {
  usWeightClass?: number;
  fsSelection?: number | { bold?: boolean; italic?: boolean; regular?: boolean };
  yStrikeoutPosition?: number;
  yStrikeoutSize?: number;
  typoAscender?: number;
  typoDescender?: number;
}

/** Fields fontkit's single-face `Font` exposes beyond the `FontInstance` contract. */
export interface FontkitFontFields {
  postscriptName?: string;
  familyName?: string;
  subfamilyName?: string;
  /** `post.italicAngle`, in degrees. */
  italicAngle?: number;
  characterSet?: number[];
  /** Empty object for a static face. */
  variationAxes?: Record<string, FontkitVariationAxis>;
  /** Instance the face at an axis location. */
  getVariation?(axes: Record<string, number>): FontkitFont;
  "OS/2"?: FontkitOs2Table;
  fvar?: { instance?: FontkitFvarInstance[]; axis?: FontkitFvarAxis[] };
  name?: {
    records?: {
      postscriptName?: FontkitNameRecord;
      /** fontkit files name IDs >= 256 under `fontFeatures`, keyed by the stringified ID. */
      fontFeatures?: Record<string, Record<string, string> | undefined>;
      [record: string]: unknown;
    };
  };
  /** Physical sfnt table directory. */
  directory?: { tables?: Record<string, unknown> };
  /** Absent on a single face; discriminates it from a collection. */
  fonts?: undefined;
}

/** A single fontkit face: the shared `FontInstance` contract plus fontkit's own fields. */
export type FontkitFont = FontInstance & FontkitFontFields;

/** A TrueType / OpenType collection (`.ttc`, `.otc`) or a DFont. */
export interface FontkitCollection {
  fonts: FontkitFont[];
  /** A NEW face object for the named member, or null when no member has that name. */
  getFont?(postscriptName: string): FontkitFont | null;
  postscriptName?: undefined;
}

/** What `openSync` / `create` return. */
export type FontkitContainer = FontkitFont | FontkitCollection;

/** The fontkit entry points this package calls. */
export interface FontkitModule {
  openSync(path: string, postscriptName?: string): FontkitContainer;
  create(buffer: Uint8Array, postscriptName?: string): FontkitContainer;
}

/** fontkit, typed to the subset above. */
export const fontkit: FontkitModule = fontkitModule;

/** True when `container` is a collection rather than a single face (false for a missing one). */
export function isFontkitCollection(container: FontkitContainer | null | undefined): container is FontkitCollection {
  return Array.isArray(container?.fonts);
}
