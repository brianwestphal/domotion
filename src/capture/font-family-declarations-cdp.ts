import type { CDPSession, Page } from "@playwright/test";
import { detachQuietly, isSameProcessFrameError } from "./cdp-lifecycle.js";
import { privateCaptureKey } from "./private-key.js";
import { probeFailureWarning } from "./probe-failure.js";
import { matchedFamilyIsUnambiguouslyAuthored, type MatchedFamilyDeclarations } from "./font-family-declarations.js";
import { familyDomRecords, nativeFontFamilyType, type FamilyDomNode } from "./font-family-cascade-cdp.js";
import { computedFontLocaleLanguage } from "./font-locale.js";
import { fontLocaleMatchesCapturedLanguage, type ProvenFamilyType } from "./font-family-cascade.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { CaptureWarning } from "./types.js";

interface CdpNode extends FamilyDomNode {
  nodeId: number;
  nodeType: number;
  children?: CdpNode[];
  contentDocument?: CdpNode;
  shadowRoots?: CdpNode[];
}

// Inspector object references avoid author-visible selector/attribute markers.
// This function runs against a Document or ShadowRoot, including a closed root
// obtained through DOM.resolveNode. Its only DOM change is the removed initial
// value probe, matching the capture walk's existing browser-settings probe.
const collectCandidates = String.raw`function(literalOnly) {
  var root = this;
  var doc = root.nodeType === 9 ? root : root.ownerDocument;
  var view = doc.defaultView;
  if (!view || !doc.documentElement) return [];
  var seen = new Set();
  function opaque(sheet) {
    if (!sheet || seen.has(sheet)) return false;
    seen.add(sheet);
    try {
      var rules = sheet.cssRules;
      for (var i = 0; i < rules.length; i++) {
        if (rules[i].styleSheet && opaque(rules[i].styleSheet)) return true;
      }
      return false;
    } catch (error) { return true; }
  }
  var sheets = Array.from(doc.styleSheets || []);
  if (root !== doc) sheets = sheets.concat(Array.from(root.styleSheets || []));
  var hasOpaque = false;
  for (var i = 0; i < sheets.length; i++) if (opaque(sheets[i])) hasOpaque = true;
  if (!hasOpaque && literalOnly) return [];
  var probe = doc.createElement('span');
  probe.style.setProperty('all', 'initial', 'important');
  probe.style.setProperty('display', 'none', 'important');
  var initial;
  try {
    doc.documentElement.appendChild(probe);
    initial = view.getComputedStyle(probe).fontFamily.toLowerCase();
  } finally { probe.remove(); }
  var candidates = [];
  var elements = root.querySelectorAll('*');
  for (var i = 0; i < elements.length; i++) {
    var el = elements[i];
    var candidate = view.getComputedStyle(el).fontFamily.toLowerCase() === initial;
    if (!literalOnly && !candidate) {
      candidate = ['before', 'after', 'first-letter', 'first-line', 'placeholder', 'file-selector-button'].some(function(pseudo) {
        return view.getComputedStyle(el, '::' + pseudo).fontFamily.toLowerCase() === initial;
      });
    }
    if (candidate) candidates.push(el);
  }
  return candidates;
}`;

/** Supplement known CSSOM author facts only for opaque-sheet initial-name candidates. */
export async function captureFontFamilyDeclarationFacts(
  page: Page,
  options: { literalOnly?: boolean } = {},
): Promise<{
  propertyKey: string;
  warnings: CaptureWarning[];
  dispose(): Promise<void>;
}> {
  const propertyKey = privateCaptureKey("FontFamilyDeclarations");
  let capturedFallbackLanguage: string | undefined;
  if (!options.literalOnly) {
    try {
      capturedFallbackLanguage = await withTimeout(
        page.evaluate(() => document.documentElement.lang || ""),
        500,
      );
    } catch {
      /* Unavailable language cannot authorize a standard-family fact. */
    }
  }
  const warnings: CaptureWarning[] = [];
  const reported = new Set<string>();
  const retained: Array<{ session: CDPSession; objects: Set<string>; group: string }> = [];
  const report = (error: unknown): void => {
    const warning = probeFailureWarning({
      selector: "document",
      feature: "font-family provenance",
      probe: options.literalOnly
        ? "opaque stylesheet matched-family declarations"
        : "native matched-family cascade and value provenance",
      cause: error,
      effect: "the affected nodes retain the prior CSSOM declaration route",
    });
    if (!reported.has(warning.detail)) {
      reported.add(warning.detail);
      warnings.push(warning);
    }
  };
  for (const target of [page, ...page.frames().filter((frame) => frame !== page.mainFrame())]) {
    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(target);
    } catch (error) {
      if (target !== page && isSameProcessFrameError(error)) continue;
      report(error);
      continue;
    }
    const objects = new Set<string>();
    const group = `${propertyKey}_${retained.length}`;
    retained.push({ session, objects, group });
    try {
      await session.send("DOM.enable");
      await session.send("CSS.enable");
      const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
      const records = familyDomRecords(root);
      const roots: number[] = [];
      const visit = (node: CdpNode): void => {
        if (node.nodeType === 9 || node.nodeType === 11) roots.push(node.nodeId);
        for (const child of node.children ?? []) visit(child);
        if (node.contentDocument != null) visit(node.contentDocument);
        for (const shadow of node.shadowRoots ?? []) visit(shadow);
      };
      visit(root);
      const candidates: string[] = [];
      for (const nodeId of roots) {
        const resolved = await session.send("DOM.resolveNode", { nodeId, objectGroup: group });
        if (resolved.object.objectId == null) throw new Error("Chromium did not expose the stylesheet root object");
        const result = await session.send("Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: collectCandidates,
          arguments: [{ value: options.literalOnly === true }],
          objectGroup: group,
        });
        if (result.exceptionDetails != null) throw new Error(result.exceptionDetails.text);
        if (result.result.objectId == null) throw new Error("Chromium did not expose the font candidate array");
        const properties = await session.send("Runtime.getProperties", {
          objectId: result.result.objectId,
          ownProperties: true,
        });
        for (const property of properties.result) {
          if (/^\d+$/.test(property.name) && property.value?.objectId != null) candidates.push(property.value.objectId);
        }
      }
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, candidates.length) }, async () => {
          while (next < candidates.length) {
            const objectId = candidates[next++];
            try {
              const { nodeId } = await session.send("DOM.requestNode", { objectId });
              const matched = await session.send("CSS.getMatchedStylesForNode", { nodeId });
              const animated = await session.send("CSS.getAnimatedStylesForNode", { nodeId });
              const evidence: MatchedFamilyDeclarations = {
                ...matched,
                animationStyles: animated.animationStyles,
                transitionsStyle: animated.transitionsStyle,
                inherited: matched.inherited?.map((scope, index) => ({
                  ...scope,
                  animationStyles: animated.inherited?.[index]?.animationStyles,
                  transitionsStyle: animated.inherited?.[index]?.transitionsStyle,
                })),
              };
              const authored = matchedFamilyIsUnambiguouslyAuthored(evidence);
              let authoredPseudos = (evidence.pseudoElements ?? [])
                .filter((pseudo) => matchedFamilyIsUnambiguouslyAuthored({ matchedCSSRules: pseudo.matches }))
                .map((pseudo) => pseudo.pseudoType);
              if (authoredPseudos.length > 0) {
                const animations = await session.send("Runtime.callFunctionOn", {
                  objectId,
                  returnByValue: true,
                  functionDeclaration: `function() {
                    return this.getAnimations({ subtree: true }).some(function(animation) {
                      return animation.effect && animation.effect.getKeyframes().some(function(frame) {
                        return Object.hasOwn(frame, 'fontFamily') || Object.hasOwn(frame, 'font') || Object.hasOwn(frame, 'all');
                      });
                    });
                  }`,
                });
                if (animations.exceptionDetails != null) throw new Error(animations.exceptionDetails.text);
                if (animations.result.value !== false) authoredPseudos = [];
              }
              let provenance:
                | {
                    family: string;
                    type?: ProvenFamilyType;
                    usable?: boolean;
                    fontLocale?: string;
                    language?: string;
                    pseudos: Record<
                      string,
                      {
                        family: string;
                        type?: ProvenFamilyType;
                        usable: boolean;
                        fontLocale?: string;
                        language?: string;
                      }
                    >;
                  }
                | undefined;
              if (!options.literalOnly) {
                try {
                  const languageReply = await withTimeout(
                    session.send("Runtime.callFunctionOn", {
                      objectId,
                      returnByValue: true,
                      functionDeclaration: `function(fallback) { /* font provenance language */
                      var n=this;while(n&&n.nodeType===1){if(typeof n.lang==='string'&&n.lang)return n.lang;n=n.parentElement;}
                      return fallback;
                    }`,
                      arguments: [{ value: capturedFallbackLanguage ?? null }],
                    }),
                    500,
                  );
                  const language =
                    typeof languageReply?.result.value === "string" ? languageReply.result.value : undefined;
                  const native = await withTimeout(nativeFontFamilyType(session, nodeId, evidence, records), 1500);
                  provenance = {
                    family: native?.family ?? "",
                    fontLocale: native?.fontLocale,
                    language,
                    pseudos: Object.fromEntries(
                      (records.get(nodeId)?.node.pseudoElements ?? [])
                        .filter((p) => p.pseudoType != null)
                        .map((p) => [p.pseudoType!, { family: "", usable: false }]),
                    ),
                  };
                  if (native != null && "type" in native.resolution) {
                    provenance.type = native.resolution.type;
                    provenance.usable =
                      provenance.type !== "standard" ||
                      computedFontLocaleLanguage(native.fontLocale) !== undefined ||
                      fontLocaleMatchesCapturedLanguage(native.fontLocale, language);
                    if (!provenance.usable)
                      report(
                        new Error(
                          "standard family type cannot use the captured DOM language for this computed font locale (DM-PJG8E9)",
                        ),
                      );
                  } else if (!authored)
                    report(
                      new Error(
                        native == null
                          ? "native font provenance exceeded Node deadline"
                          : "reason" in native.resolution
                            ? native.resolution.reason
                            : "native family type is unavailable",
                      ),
                    );
                  for (const pseudo of records.get(nodeId)?.node.pseudoElements ?? []) {
                    if (pseudo.pseudoType == null) continue;
                    const pseudoReplies = await withTimeout(
                      Promise.all([
                        session.send("CSS.getMatchedStylesForNode", { nodeId: pseudo.nodeId }),
                        session.send("CSS.getAnimatedStylesForNode", { nodeId: pseudo.nodeId }),
                      ]),
                      1500,
                    );
                    if (pseudoReplies == null) {
                      report(new Error("native pseudo font input exceeded Node deadline"));
                      continue;
                    }
                    const [pseudoMatched, pseudoAnimated] = pseudoReplies;
                    const pseudoEvidence: MatchedFamilyDeclarations = {
                      ...pseudoMatched,
                      animationStyles: pseudoAnimated.animationStyles,
                      transitionsStyle: pseudoAnimated.transitionsStyle,
                      inherited: pseudoMatched.inherited?.map((scope, index) => ({
                        ...scope,
                        animationStyles: pseudoAnimated.inherited?.[index]?.animationStyles,
                        transitionsStyle: pseudoAnimated.inherited?.[index]?.transitionsStyle,
                      })),
                    };
                    const nativePseudo = await withTimeout(
                      nativeFontFamilyType(session, pseudo.nodeId, pseudoEvidence, records),
                      1500,
                    );
                    if (nativePseudo != null && "type" in nativePseudo.resolution)
                      provenance.pseudos[pseudo.pseudoType] = {
                        family: nativePseudo.family,
                        type: nativePseudo.resolution.type,
                        fontLocale: nativePseudo.fontLocale,
                        language,
                        usable:
                          nativePseudo.resolution.type !== "standard" ||
                          computedFontLocaleLanguage(nativePseudo.fontLocale) !== undefined ||
                          fontLocaleMatchesCapturedLanguage(nativePseudo.fontLocale, language),
                      };
                    else if (!authoredPseudos.includes(pseudo.pseudoType))
                      report(
                        new Error(
                          nativePseudo == null
                            ? "native pseudo font provenance exceeded Node deadline"
                            : "reason" in nativePseudo.resolution
                              ? nativePseudo.resolution.reason
                              : "native pseudo family type is unavailable",
                        ),
                      );
                  }
                } catch (error) {
                  // The optional extension cannot erase a valid ZZR literal
                  // witness when a new native query is unavailable.
                  report(error);
                  // Retain independently completed host/pseudo proofs; the failing field stays absent.
                }
              }
              if (
                !authored &&
                authoredPseudos.length === 0 &&
                provenance?.type == null &&
                Object.keys(provenance?.pseudos ?? {}).length === 0
              )
                continue;
              // Track before evaluation: a protocol timeout can follow a completed
              // definition, and cleanup must still attempt to remove that key.
              objects.add(objectId);
              const attached = await session.send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: `function(key, authored, authoredPseudos, provenance) {
                Object.defineProperty(this, key, { configurable: true, value: {
                  family: this.ownerDocument.defaultView.getComputedStyle(this).fontFamily,
                  authored: authored, authoredPseudos: authoredPseudos,
                  familyType: provenance && provenance.family === this.ownerDocument.defaultView.getComputedStyle(this).fontFamily ? provenance.type : undefined,
                  familyTypeUsable: provenance && provenance.usable,
                  familyTypeLocale: provenance && provenance.fontLocale,
                  familyTypeLanguage: provenance && provenance.language,
                  pseudoFamilyTypes: provenance ? Object.fromEntries(Object.entries(provenance.pseudos).map(([pseudo,fact])=>[pseudo,{...fact,family:fact.family || this.ownerDocument.defaultView.getComputedStyle(this, '::' + pseudo).fontFamily}]).filter(([pseudo,fact]) => this.ownerDocument.defaultView.getComputedStyle(this, '::' + pseudo).fontFamily === fact.family)) : undefined
                }});
              }`,
                arguments: [
                  { value: propertyKey },
                  { value: authored },
                  { value: authoredPseudos },
                  { value: provenance ?? null },
                ],
              });
              if (attached.exceptionDetails != null) throw new Error(attached.exceptionDetails.text);
            } catch (error) {
              report(error);
            }
          }
        }),
      );
    } catch (error) {
      report(error);
    }
  }
  let disposed = false;
  return {
    propertyKey,
    warnings,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const { session, objects, group } of retained) {
        try {
          await Promise.all(
            [...objects].map((objectId) =>
              session
                .send("Runtime.callFunctionOn", {
                  objectId,
                  functionDeclaration: "function(key) { delete this[key]; }",
                  arguments: [{ value: propertyKey }],
                })
                .catch(() => undefined),
            ),
          );
          await session.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
        } finally {
          await detachQuietly(session);
        }
      }
    },
  };
}
