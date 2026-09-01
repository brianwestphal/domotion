/**
 * Authoritative Chromium-resolved styles for WebKit control pseudos.
 *
 * Blink represents most legacy control pseudos as elements in a closed UA
 * shadow tree. `getComputedStyle(host, pseudo)` consequently returns the host
 * style for those pseudos, while walking CSSOM rules loses the browser's real
 * cascade (specificity, importance, origins, layers, scopes, conditional
 * rules, and tree scopes). The DevTools DOM/CSS agents expose the actual UA
 * shadow nodes and their final ComputedStyle, so capture those facts before
 * the serialized page walk and attach a collision-resistant, non-selector
 * expando to each originating host.
 *
 * Pinned Chromium ownership:
 * - StyleResolver::UAShadowPseudoCascading and MatchOuterScopeRules:
 *   third_party/blink/renderer/core/css/resolver/style_resolver.cc:679-710,
 *   915-1025 (rev 7d859f271cbda744098ac69f44978d4edfa62be3)
 * - StyleCascade::CollectFromMatchResult expands declarations into
 *   CascadePriority before applying them:
 *   third_party/blink/renderer/core/css/resolver/style_cascade.cc
 * - PaintLayerScrollableArea::UpdateResizerStyle resolves `kPseudoIdResizer`
 *   into an anonymous LayoutCustomScrollbarPart rather than a DOM node:
 *   third_party/blink/renderer/core/paint/paint_layer_scrollable_area.cc:
 *   2304-2334.
 */

import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";
import {
  authorControlStyleFactsFromMatchedStyles,
  effectiveAppearanceForControl,
  type CdpMatchedStylesLike,
} from "./effective-appearance.js";
import {
  capturedInputValueTextGeometry,
  type CapturedInputValueTextGeometry,
} from "./input-value-geometry.js";
import type { CapturedScrollbarPseudoStyle } from "./types.js";

export const CONTROL_PSEUDO_KINDS = [
  "track",
  "thumb",
  "progress-bar",
  "progress-value",
  "meter-bar",
  "meter-optimum",
  "meter-suboptimum",
  "meter-even-less-good",
  "color-swatch",
  "color-swatch-wrapper",
  "inner-spin-button",
  "search-cancel-button",
  "calendar-picker-indicator",
  "select-inner",
  "file-selector-button",
  "file-selector-status",
  "resizer",
  "scrollbar",
  "scrollbar-button",
  "scrollbar-thumb",
  "scrollbar-track",
  "scrollbar-track-piece",
  "scrollbar-corner",
] as const;

export type ControlPseudoKind = typeof CONTROL_PSEUDO_KINDS[number];

export interface ResolvedControlPseudoStyle extends CapturedScrollbarPseudoStyle {}

export type ResolvedControlPseudoStyles = Record<
  string,
  Partial<Record<ControlPseudoKind, ResolvedControlPseudoStyle>>
>;

interface CdpNode {
  nodeId: number;
  backendNodeId: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  shadowRootType?: string;
  pseudoElements?: CdpNode[];
  contentDocument?: CdpNode;
}

interface ComputedProperty {
  name: string;
  value: string;
}

const PSEUDO_ID_TO_KIND: Readonly<Record<string, ControlPseudoKind>> = {
  "-webkit-slider-runnable-track": "track",
  "-webkit-slider-thumb": "thumb",
  "-webkit-progress-bar": "progress-bar",
  "-webkit-progress-value": "progress-value",
  "-webkit-meter-bar": "meter-bar",
  "-webkit-meter-optimum-value": "meter-optimum",
  "-webkit-meter-suboptimum-value": "meter-suboptimum",
  "-webkit-meter-even-less-good-value": "meter-even-less-good",
  "-webkit-color-swatch": "color-swatch",
  "-webkit-color-swatch-wrapper": "color-swatch-wrapper",
  "-webkit-inner-spin-button": "inner-spin-button",
  "-webkit-search-cancel-button": "search-cancel-button",
  "-webkit-calendar-picker-indicator": "calendar-picker-indicator",
  "-internal-select-inner-element": "select-inner",
  "-webkit-file-upload-button": "file-selector-button",
};

const SCROLLBAR_PSEUDO_TYPE_TO_KIND: Readonly<Record<string, ControlPseudoKind>> = {
  scrollbar: "scrollbar",
  "scrollbar-button": "scrollbar-button",
  "scrollbar-thumb": "scrollbar-thumb",
  "scrollbar-track": "scrollbar-track",
  "scrollbar-track-piece": "scrollbar-track-piece",
  "scrollbar-corner": "scrollbar-corner",
};

const SCROLLBAR_KIND_TO_SELECTOR: Readonly<Partial<Record<ControlPseudoKind, string>>> = {
  scrollbar: "::-webkit-scrollbar",
  "scrollbar-button": "::-webkit-scrollbar-button",
  "scrollbar-thumb": "::-webkit-scrollbar-thumb",
  "scrollbar-track": "::-webkit-scrollbar-track",
  "scrollbar-track-piece": "::-webkit-scrollbar-track-piece",
  "scrollbar-corner": "::-webkit-scrollbar-corner",
};

const DYNAMIC_SCROLLBAR_STATE = /:(?:horizontal|vertical|decrement|increment|start|end|double-button|single-button|no-button|corner-present|window-inactive|hover|active|enabled|disabled)\b/i;

/**
 * Identify scrollbar pseudo kinds whose final style depends on an anonymous
 * instance state that stable CDP cannot query. This is detection only: the
 * capture path never tries to replay the author cascade. A matching part is
 * retained as a same-frame owner-only crop instead.
 */
export function dynamicScrollbarPseudoKindsFromCss(
  styleSheetTexts: readonly string[],
): Set<ControlPseudoKind> {
  const result = new Set<ControlPseudoKind>();
  const pseudo = /::-webkit-scrollbar(?:-track-piece|-button|-thumb|-track|-corner)?/gi;
  for (const rawText of styleSheetTexts) {
    const text = rawText.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const block of text.matchAll(/([^{}]+)\{/g)) {
      const selectorText = block[1] ?? "";
      for (const match of selectorText.matchAll(pseudo)) {
        const suffix = selectorText.slice((match.index ?? 0) + match[0].length);
        if (!DYNAMIC_SCROLLBAR_STATE.test(suffix)) continue;
        const normalized = match[0].toLowerCase();
        const kind = normalized.endsWith("-track-piece") ? "scrollbar-track-piece"
          : normalized.endsWith("-button") ? "scrollbar-button"
            : normalized.endsWith("-thumb") ? "scrollbar-thumb"
              : normalized.endsWith("-track") ? "scrollbar-track"
                : normalized.endsWith("-corner") ? "scrollbar-corner"
                  : "scrollbar";
        result.add(kind);
      }
    }
  }
  return result;
}

function attributesOf(node: CdpNode): Record<string, string> {
  const result: Record<string, string> = {};
  const attributes = node.attributes ?? [];
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    result[attributes[index]] = attributes[index + 1];
  }
  return result;
}

/** Map a pierced UA-shadow node to the renderer's stable pseudo kind. */
export function controlPseudoKindForNode(
  attributes: Readonly<Record<string, string>>,
  hostNodeName: string,
  hostAttributes: Readonly<Record<string, string>>,
  nodeName = "",
): ControlPseudoKind | null {
  const pseudoId = attributes.pseudo ?? attributes["-webkit-pseudo"];
  if (pseudoId != null && PSEUDO_ID_TO_KIND[pseudoId] != null) {
    return PSEUDO_ID_TO_KIND[pseudoId];
  }

  // The slider thumb is the one relevant UA-shadow node whose DOM-agent
  // record has only Blink's stable internal id. The track retains its
  // `pseudo=-webkit-slider-runnable-track` attribute. This id is
  // shadow_element_names::kIdSliderThumb in Blink's form-control sources.
  if (
    attributes.id === "thumb"
    && hostNodeName === "INPUT"
    && (hostAttributes.type ?? "text").toLowerCase() === "range"
  ) {
    return "thumb";
  }
  // FileInputType::CreateShadowSubtree appends exactly one status <span>
  // after the pseudo-addressable upload button. It has no pseudo id, so the
  // pierced node name plus the source host type is its stable ownership key.
  if (
    nodeName === "SPAN"
    && hostNodeName === "INPUT"
    && (hostAttributes.type ?? "text").toLowerCase() === "file"
    && attributes["aria-hidden"] === "true"
  ) {
    return "file-selector-status";
  }
  return null;
}

/** UA rules establish the native baseline; any other direct origin is customization. */
export function hasAuthorPseudoOrigin(origins: readonly string[]): boolean {
  return origins.some((origin) => origin !== "user-agent");
}

function compressQuad(values: readonly [string, string, string, string]): string {
  const [top, right, bottom, left] = values;
  if (top === right && top === bottom && top === left) return top;
  if (top === bottom && right === left) return `${top} ${right}`;
  if (right === left) return `${top} ${right} ${bottom}`;
  return values.join(" ");
}

function computedMap(properties: readonly ComputedProperty[]): ReadonlyMap<string, string> {
  return new Map(properties.map(({ name, value }) => [name, value]));
}

function propertyValue(properties: ReadonlyMap<string, string>, name: string): string {
  return properties.get(name) ?? "";
}

function resolvedBorder(properties: ReadonlyMap<string, string>): string {
  const sides = ["top", "right", "bottom", "left"] as const;
  const triples = sides.map((side) => ({
    width: propertyValue(properties, `border-${side}-width`),
    style: propertyValue(properties, `border-${side}-style`),
    color: propertyValue(properties, `border-${side}-color`),
  }));
  const first = triples[0];
  if (
    first.width === "" || first.width === "0px" || first.style === "none"
    || triples.some((side) => side.width !== first.width || side.style !== first.style || side.color !== first.color)
  ) {
    return "";
  }
  return `${first.width} ${first.style} ${first.color}`;
}

function resolvedNonUniformBorderSides(
  properties: ReadonlyMap<string, string>,
): CapturedScrollbarPseudoStyle["borderSides"] {
  const side = (name: "top" | "right" | "bottom" | "left") => ({
    width: propertyValue(properties, `border-${name}-width`),
    style: propertyValue(properties, `border-${name}-style`),
    color: propertyValue(properties, `border-${name}-color`),
  });
  const result = {
    top: side("top"),
    right: side("right"),
    bottom: side("bottom"),
    left: side("left"),
  };
  const sides = [result.top, result.right, result.bottom, result.left];
  const first = result.top;
  const uniform = sides.every((candidate) => (
    candidate.width === first.width
    && candidate.style === first.style
    && candidate.color === first.color
  ));
  const hasPaint = sides.some((candidate) => (
    candidate.width !== ""
    && candidate.width !== "0px"
    && candidate.style !== ""
    && candidate.style !== "none"
    && candidate.style !== "hidden"
  ));
  return !uniform && hasPaint ? result : undefined;
}

function resolvedBorderRadius(properties: ReadonlyMap<string, string>): string {
  const rawCorners = [
    propertyValue(properties, "border-top-left-radius"),
    propertyValue(properties, "border-top-right-radius"),
    propertyValue(properties, "border-bottom-right-radius"),
    propertyValue(properties, "border-bottom-left-radius"),
  ] as const;
  if (rawCorners.every((corner) => corner === "")) return "";
  const horizontal = rawCorners.map((corner) => corner.trim().split(/\s+/)[0] || "0px") as unknown as [string, string, string, string];
  const vertical = rawCorners.map((corner) => {
    const parts = corner.trim().split(/\s+/);
    return parts[1] || parts[0] || "0px";
  }) as unknown as [string, string, string, string];
  const horizontalText = compressQuad(horizontal);
  const verticalText = compressQuad(vertical);
  return horizontalText === verticalText ? horizontalText : `${horizontalText} / ${verticalText}`;
}

/** Serialize Blink's final longhands into the capture schema's compact fields. */
export function resolvedControlPseudoStyle(
  properties: readonly ComputedProperty[],
): ResolvedControlPseudoStyle {
  const computed = computedMap(properties);
  const backgroundImage = propertyValue(computed, "background-image");
  const boxShadow = propertyValue(computed, "box-shadow");
  const padding = compressQuad([
    propertyValue(computed, "padding-top"),
    propertyValue(computed, "padding-right"),
    propertyValue(computed, "padding-bottom"),
    propertyValue(computed, "padding-left"),
  ]);
  return {
    matched: true,
    display: propertyValue(computed, "display"),
    visibility: propertyValue(computed, "visibility"),
    opacity: propertyValue(computed, "opacity"),
    width: propertyValue(computed, "width"),
    height: propertyValue(computed, "height"),
    minWidth: propertyValue(computed, "min-width"),
    minHeight: propertyValue(computed, "min-height"),
    maxWidth: propertyValue(computed, "max-width"),
    maxHeight: propertyValue(computed, "max-height"),
    marginTop: propertyValue(computed, "margin-top"),
    marginRight: propertyValue(computed, "margin-right"),
    marginBottom: propertyValue(computed, "margin-bottom"),
    marginLeft: propertyValue(computed, "margin-left"),
    backgroundColor: propertyValue(computed, "background-color"),
    backgroundImage: backgroundImage === "none" ? "" : backgroundImage,
    borderRadius: resolvedBorderRadius(computed),
    border: resolvedBorder(computed),
    borderSides: resolvedNonUniformBorderSides(computed),
    padding,
    boxShadow: boxShadow === "none" ? "" : boxShadow,
    filter: propertyValue(computed, "filter"),
  };
}

function directMatchedOrigins(matched: unknown): string[] {
  // Keep the DevTools protocol boundary structural and runtime-checked rather
  // than leaking an untyped response into the capture model.
  if (matched == null || typeof matched !== "object" || !("matchedCSSRules" in matched)) return [];
  const rules = (matched as { matchedCSSRules?: Array<{ rule?: { origin?: string } }> }).matchedCSSRules;
  return (rules ?? []).map(({ rule }) => rule?.origin).filter((origin): origin is string => typeof origin === "string");
}

function resizerMatchedOrigins(matched: unknown): string[] {
  if (matched == null || typeof matched !== "object" || !("pseudoElements" in matched)) return [];
  const pseudos = (matched as {
    pseudoElements?: Array<{
      pseudoType?: string;
      matches?: Array<{ rule?: { origin?: string } }>;
    }>;
  }).pseudoElements ?? [];
  return pseudos
    .filter(({ pseudoType }) => pseudoType === "resizer")
    .flatMap(({ matches }) => (matches ?? []).map(({ rule }) => rule?.origin))
    .filter((origin): origin is string => typeof origin === "string");
}

function scrollbarPseudoEntries(matched: unknown): Array<{ kind: ControlPseudoKind; origins: string[] }> {
  if (matched == null || typeof matched !== "object" || !("pseudoElements" in matched)) return [];
  const pseudos = (matched as {
    pseudoElements?: Array<{
      pseudoType?: string;
      matches?: Array<{ rule?: { origin?: string } }>;
    }>;
  }).pseudoElements ?? [];
  return pseudos.flatMap(({ pseudoType, matches }) => {
    const kind = pseudoType == null ? undefined : SCROLLBAR_PSEUDO_TYPE_TO_KIND[pseudoType];
    if (kind == null) return [];
    const origins = (matches ?? [])
      .map(({ rule }) => rule?.origin)
      .filter((origin): origin is string => typeof origin === "string");
    return [{ kind, origins }];
  });
}

async function collectResizableRemoteObjects(session: CDPSession, objectGroup: string): Promise<string[]> {
  const evaluated = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const result = [];
      const seen = new Set();
      const walk = (root) => {
        if (root == null || seen.has(root)) return;
        seen.add(root);
        const elements = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const element of elements) {
          try {
            if (getComputedStyle(element).resize !== 'none') result.push(element);
          } catch (_error) {}
          if (element.shadowRoot != null) walk(element.shadowRoot);
          if (element.tagName === 'IFRAME') {
            try { if (element.contentDocument != null) walk(element.contentDocument); } catch (_error) {}
          }
        }
      };
      walk(document);
      return result;
    })()`,
    objectGroup,
    returnByValue: false,
  });
  if (evaluated.result.objectId == null) return [];
  const properties = await session.send("Runtime.getProperties", {
    objectId: evaluated.result.objectId,
    ownProperties: true,
  });
  return properties.result
    .filter(({ name, value }) => /^\d+$/.test(name) && value?.objectId != null)
    .map(({ value }) => value!.objectId!);
}

async function collectScrollbarRemoteObjects(session: CDPSession, objectGroup: string): Promise<string[]> {
  const evaluated = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const result = [];
      const seen = new Set();
      const walk = (root) => {
        if (root == null || seen.has(root)) return;
        seen.add(root);
        const elements = [];
        if (root instanceof Element) elements.push(root);
        if (root.querySelectorAll) elements.push(...root.querySelectorAll('*'));
        for (const element of elements) {
          try {
            const style = getComputedStyle(element);
            const rootScroller = element === document.scrollingElement;
            const rootRange = rootScroller && (
              (style.overflowX !== 'hidden' && style.overflowX !== 'clip' && element.scrollWidth > element.clientWidth)
              || (style.overflowY !== 'hidden' && style.overflowY !== 'clip' && element.scrollHeight > element.clientHeight)
              || style.scrollbarGutter !== 'auto'
            );
            const candidate = ['auto', 'scroll'].includes(style.overflowX)
              || ['auto', 'scroll'].includes(style.overflowY)
              || rootRange;
            if (candidate) result.push(element);
          } catch (_error) {}
          if (element.shadowRoot != null) walk(element.shadowRoot);
          if (element.tagName === 'IFRAME') {
            try { if (element.contentDocument != null) walk(element.contentDocument); } catch (_error) {}
          }
        }
      };
      walk(document.documentElement);
      return result;
    })()`,
    objectGroup,
    returnByValue: false,
  });
  if (evaluated.result.objectId == null) return [];
  const properties = await session.send("Runtime.getProperties", {
    objectId: evaluated.result.objectId,
    ownProperties: true,
  });
  return properties.result
    .filter(({ name, value }) => /^\d+$/.test(name) && value?.objectId != null)
    .map(({ value }) => value!.objectId!);
}

async function computedScrollbarProperties(
  session: CDPSession,
  objectId: string,
  kind: ControlPseudoKind,
): Promise<ComputedProperty[]> {
  const selector = SCROLLBAR_KIND_TO_SELECTOR[kind];
  if (selector == null) return [];
  const response = await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(selector) {
      const style = getComputedStyle(this, selector);
      const names = [
        'display', 'visibility', 'opacity',
        'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'background-color', 'background-image',
        'border-top-width', 'border-top-style', 'border-top-color',
        'border-right-width', 'border-right-style', 'border-right-color',
        'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
        'border-left-width', 'border-left-style', 'border-left-color',
        'border-top-left-radius', 'border-top-right-radius',
        'border-bottom-right-radius', 'border-bottom-left-radius',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'box-shadow', 'filter'
      ];
      return names.map((name) => ({ name, value: style.getPropertyValue(name) }));
    }`,
    arguments: [{ value: selector }],
    returnByValue: true,
  });
  return Array.isArray(response.result.value)
    ? response.result.value.filter((entry): entry is ComputedProperty => (
        entry != null && typeof entry === "object"
        && typeof (entry as { name?: unknown }).name === "string"
        && typeof (entry as { value?: unknown }).value === "string"
      ))
    : [];
}

async function computedResizerProperties(session: CDPSession, objectId: string): Promise<ComputedProperty[]> {
  const response = await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      const style = getComputedStyle(this, '::-webkit-resizer');
      const names = [
        'width', 'height', 'background-color', 'background-image',
        'border-top-width', 'border-top-style', 'border-top-color',
        'border-right-width', 'border-right-style', 'border-right-color',
        'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
        'border-left-width', 'border-left-style', 'border-left-color',
        'border-top-left-radius', 'border-top-right-radius',
        'border-bottom-right-radius', 'border-bottom-left-radius',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'box-shadow'
      ];
      return names.map((name) => ({ name, value: style.getPropertyValue(name) }));
    }`,
    returnByValue: true,
  });
  return Array.isArray(response.result.value)
    ? response.result.value.filter((entry): entry is ComputedProperty => (
        entry != null && typeof entry === "object"
        && typeof (entry as { name?: unknown }).name === "string"
        && typeof (entry as { value?: unknown }).value === "string"
      ))
    : [];
}

export interface ResolvedPseudoStyleCapture {
  propertyKey: string;
  /** Expando whose entries retain pierced closed-UA-shadow decoration nodes. */
  decorationPropertyKey: string;
  /** Expando carrying the input inner editor's used text FragmentItem top. */
  inputValuePropertyKey: string;
  stylesByHost: ResolvedControlPseudoStyles;
  /** Author scrollbar pseudos with anonymous state-dependent final winners. */
  dynamicScrollbarKinds: ReadonlySet<ControlPseudoKind>;
  dispose(): Promise<void>;
}

/**
 * Read final pseudo styles from the current Chromium frame tree.
 *
 * There is deliberately no CSSOM/source-order fallback. If the authoritative
 * browser surface is unavailable, capture fails visibly instead of silently
 * returning a cascade answer known to be wrong.
 */
export async function captureResolvedControlPseudoStyles(page: Page): Promise<ResolvedPseudoStyleCapture> {
  const session = await page.context().newCDPSession(page);
  const propertyKey = `__domotionResolvedPseudos_${randomUUID().replaceAll("-", "")}`;
  const decorationPropertyKey = `${propertyKey}_decorations`;
  const inputValuePropertyKey = `${propertyKey}_inputValue`;
  const objectGroup = `${propertyKey}_objects`;
  const stylesByHost: ResolvedControlPseudoStyles = {};
  const hostIdsByNode = new Map<number, string>();
  const hostObjectIdsByNode = new Map<number, string>();
  const hostObjectIds = new Set<string>();
  const authorStyleSheetIds = new Set<string>();
  const inputValueTextQuads = new Map<number, number[][][]>();
  const inputValueHosts = new Map<number, CdpNode>();
  let nextHostId = 1;

  session.on("CSS.styleSheetAdded", (event: unknown) => {
    if (event == null || typeof event !== "object" || !("header" in event)) return;
    const header = (event as { header?: { styleSheetId?: string; origin?: string } }).header;
    if (header?.styleSheetId != null && header.origin !== "user-agent") {
      authorStyleSheetIds.add(header.styleSheetId);
    }
  });

  const ensureHost = async (nodeId: number, knownObjectId?: string): Promise<string> => {
    const existing = hostIdsByNode.get(nodeId);
    if (existing != null) return existing;
    const objectId = knownObjectId ?? (await session.send("DOM.resolveNode", { nodeId, objectGroup })).object.objectId;
    if (objectId == null) throw new Error(`Chromium did not expose pseudo host node ${nodeId}`);
    const hostId = String(nextHostId++);
    await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(key, value) {
        Object.defineProperty(this, key, { value, configurable: true });
      }`,
      arguments: [{ value: propertyKey }, { value: hostId }],
    });
    hostIdsByNode.set(nodeId, hostId);
    hostObjectIdsByNode.set(nodeId, objectId);
    hostObjectIds.add(objectId);
    return hostId;
  };

  const retainDecorationNode = async (
    hostNodeId: number,
    nodeId: number,
    kind: ControlPseudoKind,
    ownership?: { effectiveAppearance: string | null; reason?: string },
  ): Promise<void> => {
    await ensureHost(hostNodeId);
    const hostObjectId = hostObjectIdsByNode.get(hostNodeId);
    const partObjectId = (await session.send("DOM.resolveNode", { nodeId, objectGroup })).object.objectId;
    if (hostObjectId == null || partObjectId == null) {
      throw new Error(`Chromium did not expose ${kind} decoration ownership`);
    }
    await session.send("Runtime.callFunctionOn", {
      objectId: hostObjectId,
      functionDeclaration: `function(key, kind, node, ownership) {
        let parts = this[key];
        if (!Array.isArray(parts)) {
          parts = [];
          Object.defineProperty(this, key, { value: parts, configurable: true });
        }
        parts.push({ kind, node, ownership });
      }`,
      arguments: [
        { value: decorationPropertyKey },
        { value: kind },
        { objectId: partObjectId },
        { value: ownership },
      ],
    });
  };

  const storeInputValueGeometry = async (
    hostNodeId: number,
    geometry: CapturedInputValueTextGeometry,
  ): Promise<void> => {
    await ensureHost(hostNodeId);
    const hostObjectId = hostObjectIdsByNode.get(hostNodeId);
    if (hostObjectId == null) throw new Error("Chromium did not expose input value host ownership");
    await session.send("Runtime.callFunctionOn", {
      objectId: hostObjectId,
      functionDeclaration: `function(key, geometry) {
        Object.defineProperty(this, key, { value: geometry, configurable: true });
      }`,
      arguments: [{ value: inputValuePropertyKey }, { value: geometry }],
    });
  };

  const store = async (
    hostNodeId: number,
    kind: ControlPseudoKind,
    properties: readonly ComputedProperty[],
    knownHostObjectId?: string,
  ): Promise<void> => {
    const hostId = await ensureHost(hostNodeId, knownHostObjectId);
    const hostStyles = stylesByHost[hostId] ?? (stylesByHost[hostId] = {});
    hostStyles[kind] = resolvedControlPseudoStyle(properties);
  };

  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const documentResult = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const visited = new Set<number>();

    const visit = async (node: CdpNode, uaHost: CdpNode | null): Promise<void> => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      if (uaHost != null) {
        // Blink centers single-line input content with the private
        // `-internal-align-content-block` path. Host CSSOM exposes neither the
        // inner editor nor its final FragmentItem top, so retain the one
        // pierced visible text node and consume its used content quad below.
        // `AlignBlockContent` performs this in LayoutUnit (`free_space / 2`),
        // which cannot be recovered from a 1.2em `line-height: normal`
        // estimate without half-pixel drift.
        if (uaHost.nodeName === "INPUT" && node.nodeName === "#text" && node.nodeValue !== "") {
          const measured = await session.send("DOM.getContentQuads", {
            backendNodeId: node.backendNodeId,
          }).catch(() => null);
          if (measured?.quads != null) {
            const candidates = inputValueTextQuads.get(uaHost.nodeId) ?? [];
            candidates.push(measured.quads);
            inputValueTextQuads.set(uaHost.nodeId, candidates);
            inputValueHosts.set(uaHost.nodeId, uaHost);
          }
        }
        const kind = controlPseudoKindForNode(
          attributesOf(node), uaHost.nodeName, attributesOf(uaHost), node.nodeName,
        );
        if (kind != null) {
          let matched: CdpMatchedStylesLike | undefined;
          let computed: { computedStyle: ComputedProperty[] } | undefined;
          let fileOwnership: { effectiveAppearance: string | null; reason?: string } | undefined;
          if (kind === "file-selector-button") {
            try {
              const responses = await Promise.all([
                session.send("CSS.getMatchedStylesForNode", { nodeId: node.nodeId }),
                session.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId }),
                session.send("CSS.getAnimatedStylesForNode", { nodeId: node.nodeId }),
              ]);
              matched = responses[0] as CdpMatchedStylesLike;
              computed = responses[1] as { computedStyle: ComputedProperty[] };
              const animated = responses[2] as {
                animationStyles?: CdpMatchedStylesLike["animationStyles"];
                transitionsStyle?: CdpMatchedStylesLike["transitionsStyle"];
              };
              const properties = computedMap(computed.computedStyle);
              const facts = authorControlStyleFactsFromMatchedStyles({
                ...matched,
                animationStyles: animated.animationStyles,
                transitionsStyle: animated.transitionsStyle,
              }, {
                direction: properties.get("direction"),
                writingMode: properties.get("writing-mode"),
              });
              fileOwnership = {
                effectiveAppearance: effectiveAppearanceForControl(
                  properties.get("appearance") ?? properties.get("-webkit-appearance"),
                  { tag: "input", type: "button" },
                  facts,
                  (properties.get("box-shadow") ?? "none") !== "none",
                ),
                reason: facts.available ? undefined : facts.reason,
              };
            } catch (error) {
              fileOwnership = {
                effectiveAppearance: null,
                reason: `file-selector matched styles unavailable: ${error instanceof Error ? error.message : String(error)}`,
              };
            }
          }
          if (kind === "inner-spin-button" || kind === "search-cancel-button"
              || kind === "calendar-picker-indicator" || kind === "select-inner"
              || kind === "file-selector-button" || kind === "file-selector-status") {
            // Retain the actual closed-shadow Element, not just its computed
            // style. The later isolation pass needs Chromium's used rect and
            // paint owner; recreating either from pseudo CSS would be a second
            // layout engine.
            await retainDecorationNode(uaHost.nodeId, node.nodeId, kind, fileOwnership);
          }
          // The source status span has no pseudo style. Its live used style,
          // text, and shaped fragments are read from the retained node by the
          // capture script; querying matched pseudo rules here only adds an
          // avoidable protocol failure surface.
          if (kind === "file-selector-status") return;
          matched ??= await session.send("CSS.getMatchedStylesForNode", { nodeId: node.nodeId }) as CdpMatchedStylesLike;
          if (hasAuthorPseudoOrigin(directMatchedOrigins(matched))) {
            computed ??= await session.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId }) as { computedStyle: ComputedProperty[] };
            await store(uaHost.nodeId, kind, computed.computedStyle);
          }
        }
      }

      for (const pseudo of node.pseudoElements ?? []) await visit(pseudo, uaHost);
      for (const child of node.children ?? []) await visit(child, uaHost);
      if (node.contentDocument != null) await visit(node.contentDocument, null);
      for (const shadow of node.shadowRoots ?? []) {
        await visit(shadow, shadow.shadowRootType === "user-agent" ? node : null);
      }
    };
    await visit(documentResult.root as CdpNode, null);

    for (const [hostNodeId, candidates] of inputValueTextQuads) {
      // File/temporal controls can expose multiple independent labels. The
      // input-value walker does not own those surfaces; fail closed instead of
      // guessing which text row is the editing value.
      if (candidates.length !== 1) continue;
      const host = inputValueHosts.get(hostNodeId);
      if (host == null) continue;
      const hostMeasured = await session.send("DOM.getContentQuads", {
        backendNodeId: host.backendNodeId,
      }).catch(() => null);
      if (hostMeasured?.quads == null) continue;
      const geometry = capturedInputValueTextGeometry(hostMeasured.quads, candidates[0]);
      if (geometry != null) await storeInputValueGeometry(hostNodeId, geometry);
    }

    // `::-webkit-resizer` has no UA-shadow DOM node: Blink resolves its style
    // on demand and assigns it to an anonymous LayoutCustomScrollbarPart.
    // Query only hosts whose computed `resize` is active, then combine the
    // host's CDP pseudo-match metadata with the browser's native pseudo
    // getComputedStyle surface.
    const resizableObjectIds = await collectResizableRemoteObjects(session, objectGroup);
    for (const objectId of resizableObjectIds) {
      const requested = await session.send("DOM.requestNode", { objectId });
      if (requested.nodeId === 0) continue;
      const matched = await session.send("CSS.getMatchedStylesForNode", { nodeId: requested.nodeId });
      if (!hasAuthorPseudoOrigin(resizerMatchedOrigins(matched))) continue;
      await store(
        requested.nodeId,
        "resizer",
        await computedResizerProperties(session, objectId),
        objectId,
      );
    }

    // Scrollbar parts are anonymous Blink layout objects rather than UA-shadow
    // DOM nodes. CDP exposes their matched pseudo metadata on the scroll host;
    // getComputedStyle(host, unqualified-pseudo) then returns Blink's final
    // computed longhands. Orientation/start/end-only instances are not exposed
    // by this protocol and are intentionally left for the marker probe to flag.
    const scrollbarObjectIds = await collectScrollbarRemoteObjects(session, objectGroup);
    for (const objectId of scrollbarObjectIds) {
      // One detached/cross-document host must not erase authoritative styles
      // already captured for the rest of the live frame.
      try {
        const requested = await session.send("DOM.requestNode", { objectId });
        if (requested.nodeId === 0) continue;
        const matched = await session.send("CSS.getMatchedStylesForNode", { nodeId: requested.nodeId });
        for (const { kind, origins } of scrollbarPseudoEntries(matched)) {
          if (!hasAuthorPseudoOrigin(origins)) continue;
          await store(
            requested.nodeId,
            kind,
            await computedScrollbarProperties(session, objectId, kind),
            objectId,
          );
        }
      } catch {
        continue;
      }
    }
  } catch (error) {
    await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    await session.detach().catch(() => undefined);
    throw error;
  }

  const authorStyleSheetTexts = await Promise.all([...authorStyleSheetIds].map(async (styleSheetId) => {
    try {
      return (await session.send("CSS.getStyleSheetText", { styleSheetId })).text;
    } catch {
      return "";
    }
  }));
  const dynamicScrollbarKinds = dynamicScrollbarPseudoKindsFromCss(authorStyleSheetTexts);

  return {
    propertyKey,
    decorationPropertyKey,
    inputValuePropertyKey,
    stylesByHost,
    dynamicScrollbarKinds,
    async dispose(): Promise<void> {
      await Promise.all([...hostObjectIds].map(async (objectId) => {
        await session.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(styleKey, decorationKey, inputValueKey) { delete this[styleKey]; delete this[decorationKey]; delete this[inputValueKey]; }",
          arguments: [{ value: propertyKey }, { value: decorationPropertyKey }, { value: inputValuePropertyKey }],
        }).catch(() => undefined);
      }));
      await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}
