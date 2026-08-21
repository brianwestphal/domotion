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
  "resizer",
] as const;

export type ControlPseudoKind = typeof CONTROL_PSEUDO_KINDS[number];

export interface ResolvedControlPseudoStyle {
  matched: true;
  width: string;
  height: string;
  backgroundColor: string;
  backgroundImage: string;
  borderRadius: string;
  border: string;
  padding: string;
  boxShadow: string;
}

export type ResolvedControlPseudoStyles = Record<
  string,
  Partial<Record<ControlPseudoKind, ResolvedControlPseudoStyle>>
>;

interface CdpNode {
  nodeId: number;
  nodeName: string;
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
};

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
    width: propertyValue(computed, "width"),
    height: propertyValue(computed, "height"),
    backgroundColor: propertyValue(computed, "background-color"),
    backgroundImage: backgroundImage === "none" ? "" : backgroundImage,
    borderRadius: resolvedBorderRadius(computed),
    border: resolvedBorder(computed),
    padding,
    boxShadow: boxShadow === "none" ? "" : boxShadow,
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
  stylesByHost: ResolvedControlPseudoStyles;
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
  const objectGroup = `${propertyKey}_objects`;
  const stylesByHost: ResolvedControlPseudoStyles = {};
  const hostIdsByNode = new Map<number, string>();
  const hostObjectIds = new Set<string>();
  let nextHostId = 1;

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
    hostObjectIds.add(objectId);
    return hostId;
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
        const kind = controlPseudoKindForNode(attributesOf(node), uaHost.nodeName, attributesOf(uaHost));
        if (kind != null) {
          const matched = await session.send("CSS.getMatchedStylesForNode", { nodeId: node.nodeId });
          if (hasAuthorPseudoOrigin(directMatchedOrigins(matched))) {
            const computed = await session.send("CSS.getComputedStyleForNode", { nodeId: node.nodeId });
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
  } catch (error) {
    await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    await session.detach().catch(() => undefined);
    throw error;
  }

  return {
    propertyKey,
    stylesByHost,
    async dispose(): Promise<void> {
      await Promise.all([...hostObjectIds].map(async (objectId) => {
        await session.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: "function(key) { delete this[key]; }",
          arguments: [{ value: propertyKey }],
        }).catch(() => undefined);
      }));
      await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}
