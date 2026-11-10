import { randomUUID } from "node:crypto";

import type { CDPSession, Frame, Page } from "@playwright/test";

import { isSameProcessFrameError } from "../src/capture/cdp-lifecycle.js";
import { evaluateInFrame } from "../src/capture/evaluate-in-frame.js";
import {
  contentQuad,
  intersectPolygons,
  mapPolygon,
  rectangleHomography,
  rectPolygon,
  type Polygon,
} from "./real-world-webgl-geometry.js";

interface ClipFact {
  id: number;
  kind: "content" | "padding" | "border";
}
interface ElementFacts {
  id: number;
  width: number;
  height: number;
  clips: ClipFact[];
  supported: boolean;
}
interface BrowserRegistry {
  token: string;
  nodes: Element[];
  collect: (element: Element) => ElementFacts;
}
interface PreparedFrame {
  token: string;
  canvases: ElementFacts[];
}
interface GeometryRoot {
  frame: Frame;
  session: CDPSession;
  contexts: Set<number>;
}
export interface ProjectedCanvas {
  polygon: Polygon;
  clips: Polygon[];
}

/** Scoped public-CDP registry; no attributes, styles, scroll, animation or WebGL state are changed. */
export class PreflightFrameGeometry {
  private key = `__domotionPreflightGeometry_${randomUUID().replaceAll("-", "")}`;
  private prepared = new Map<Frame, Promise<PreparedFrame>>();
  private roots = new Map<Frame, Promise<GeometryRoot>>();
  private contexts = new Map<Frame, Promise<{ root: GeometryRoot; id: number }>>();
  private quads = new Map<Frame, Map<string, Promise<{ root: GeometryRoot; quad: Polygon } | null>>>();
  private owners = new Map<Frame, Promise<{ root: GeometryRoot; facts: ElementFacts; quad: Polygon } | null>>();
  private sessions = new Set<CDPSession>();
  private tokens = new Map<Frame, string>();
  private disposed = false;
  constructor(
    private page: Page,
    private deadline: number,
  ) {}

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) {
      void operation.catch(() => undefined);
      throw new Error("preflight geometry discovery deadline");
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("preflight geometry discovery deadline")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private prepare(frame: Frame): Promise<PreparedFrame> {
    const existing = this.prepared.get(frame);
    if (existing) return existing;
    const token = randomUUID();
    this.tokens.set(frame, token);
    const pending = this.bounded(
      evaluateInFrame(
        frame,
        ({ key, token }) => {
          const globals = globalThis as unknown as Record<string, unknown>;
          if (Object.hasOwn(globals, key)) throw new Error("preflight registry collision");
          const nodes: Element[] = [];
          const ids = new Map<Element, number>();
          const add = (element: Element) => {
            let id = ids.get(element);
            if (id == null) {
              id = nodes.length;
              nodes.push(element);
              ids.set(element, id);
            }
            return id;
          };
          const parent = (element: Element): Element | null =>
            element.parentElement ??
            (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
          const collect = (element: Element): ElementFacts => {
            const style = getComputedStyle(element);
            const left = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
              top = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
            const right = parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight),
              bottom = parseFloat(style.borderBottomWidth) + parseFloat(style.paddingBottom);
            const width = parseFloat(style.width) - (style.boxSizing === "border-box" ? left + right : 0),
              height = parseFloat(style.height) - (style.boxSizing === "border-box" ? top + bottom : 0);
            const clips: ClipFact[] = [];
            let supported = [width, height, left, top, right, bottom].every(Number.isFinite) && width > 0 && height > 0;
            const visual = window.visualViewport;
            if (visual && (visual.scale !== 1 || visual.offsetLeft !== 0 || visual.offsetTop !== 0)) supported = false;
            const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
            const directParent = parent(element);
            const parentStyle = directParent ? getComputedStyle(directParent) : null;
            const perspective =
              parentStyle?.perspective !== "none" && parentStyle?.perspective != null
                ? parseFloat(parentStyle.perspective)
                : null;
            if (perspective != null && !(perspective > 0)) supported = false;
            const projective = matrix.m14 !== 0 || matrix.m24 !== 0 || matrix.m34 !== 0 || perspective != null;
            if (projective && !["view-box", "border-box"].includes(style.transformBox)) supported = false;
            // Independent 2D properties preserve Z and W; independent 3D under a parent camera is unproved (DM-GQNPEN).
            if (perspective != null) {
              const rotate = style.rotate.split(/\s+/),
                translate = style.translate.split(/\s+/),
                scale = style.scale.split(/\s+/);
              if (
                (rotate.length > 1 && rotate[0] !== "z") ||
                (translate.length > 2 && parseFloat(translate[2]) !== 0) ||
                (scale.length > 2 && Number(scale[2]) !== 1)
              )
                supported = false;
            }
            const origin = style.transformOrigin.split(/\s+/).map(parseFloat);
            const ox = origin[0],
              oy = origin[1],
              oz = origin[2] ?? 0;
            for (const [x, y] of [
              [left, top],
              [left + width, top],
              [left + width, top + height],
              [left, top + height],
            ]) {
              const local = new DOMPoint(x - ox, y - oy, -oz, 1).matrixTransform(matrix);
              const w = perspective == null ? local.w : local.w - (local.z + oz * local.w) / perspective;
              if (!Number.isFinite(w) || w <= 1e-8) supported = false;
            }
            for (let ancestor: Element | null = element; ancestor; ancestor = parent(ancestor)) {
              const s = getComputedStyle(ancestor);
              if (projective && !["1", "normal"].includes(s.zoom)) supported = false;
              if (
                s.display === "none" ||
                s.visibility !== "visible" ||
                Number(s.opacity) === 0 ||
                s.contentVisibility !== "visible"
              )
                supported = false;
              if (
                s.clipPath !== "none" ||
                s.maskImage !== "none" ||
                s.clip !== "auto" ||
                s.backfaceVisibility === "hidden" ||
                /(?:^|\s)(?:paint|strict|content)(?:\s|$)/.test(s.contain)
              )
                supported = false;
              const extended = s as CSSStyleDeclaration & { webkitMaskBoxImageSource?: string };
              if (extended.webkitMaskBoxImageSource != null && extended.webkitMaskBoxImageSource !== "none")
                supported = false;
              if (ancestor !== element) {
                const m = new DOMMatrixReadOnly(s.transform === "none" ? undefined : s.transform);
                if (m.m14 !== 0 || m.m24 !== 0 || m.m34 !== 0 || !(m.m44 > 0)) supported = false;
                if (s.perspective !== "none" && ancestor !== directParent) supported = false;
              }
              const viewportRoot =
                ancestor === document.documentElement ||
                (ancestor === document.body &&
                  getComputedStyle(document.documentElement).overflowX === "visible" &&
                  getComputedStyle(document.documentElement).overflowY === "visible");
              if (!viewportRoot && (s.overflowX !== "visible" || s.overflowY !== "visible")) {
                const margin = /^(?:(content-box|padding-box|border-box)(?: 0px)?|0px)$/.exec(s.overflowClipMargin);
                if (
                  !["hidden", "clip"].includes(s.overflowX) ||
                  s.overflowX !== s.overflowY ||
                  !margin ||
                  s.transformStyle === "preserve-3d"
                )
                  supported = false;
                else
                  clips.push({
                    id: add(ancestor),
                    kind:
                      s.overflowX === "hidden"
                        ? "padding"
                        : margin[1] === "content-box"
                          ? "content"
                          : margin[1] === "border-box"
                            ? "border"
                            : "padding",
                  });
              }
              if (
                (ancestor === element || clips.some((clip) => clip.id === (ids.get(ancestor) ?? -1))) &&
                [
                  s.borderTopLeftRadius,
                  s.borderTopRightRadius,
                  s.borderBottomLeftRadius,
                  s.borderBottomRightRadius,
                ].some((value) => value.split(/\s+/).some((n) => parseFloat(n) !== 0))
              )
                supported = false;
            }
            return { id: add(element), width, height, clips, supported };
          };
          const registry: BrowserRegistry = { token, nodes, collect };
          Object.defineProperty(globals, key, { value: registry, configurable: true });
          return {
            token,
            canvases: Array.from(document.querySelectorAll("canvas"))
              .filter((canvas) => {
                const s = getComputedStyle(canvas),
                  r = canvas.getBoundingClientRect();
                return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
              })
              .map(collect),
          };
        },
        { key: this.key, token },
      ),
    );
    this.prepared.set(frame, pending);
    return pending;
  }

  private root(frame: Frame): Promise<GeometryRoot> {
    const existing = this.roots.get(frame);
    if (existing) return existing;
    const pending = (async () => {
      let session: CDPSession;
      try {
        const created = this.page.context().newCDPSession(frame === this.page.mainFrame() ? this.page : frame);
        void created.then(
          (session) => {
            if (this.disposed || Date.now() >= this.deadline) void session.detach().catch(() => undefined);
            else this.sessions.add(session);
          },
          () => undefined,
        );
        session = await this.bounded(created);
      } catch (error) {
        if (frame.parentFrame() && isSameProcessFrameError(error)) return await this.root(frame.parentFrame()!);
        throw error;
      }
      this.sessions.add(session);
      const contexts = new Set<number>();
      session.on(
        "Runtime.executionContextCreated",
        (event: { context: { id: number; auxData?: Record<string, unknown> } }) => {
          if (event.context.auxData?.isDefault === true) contexts.add(event.context.id);
        },
      );
      await this.bounded(session.send("Runtime.enable"));
      return { frame, session, contexts };
    })();
    this.roots.set(frame, pending);
    return pending;
  }

  private context(frame: Frame): Promise<{ root: GeometryRoot; id: number }> {
    const existing = this.contexts.get(frame);
    if (existing) return existing;
    const pending = (async () => {
      const [prepared, root] = await Promise.all([this.prepare(frame), this.root(frame)]);
      const matches: number[] = [];
      for (const id of root.contexts) {
        const response = await this.bounded(
          root.session.send("Runtime.evaluate", {
            expression: `globalThis[${JSON.stringify(this.key)}]?.token===${JSON.stringify(prepared.token)}`,
            contextId: id,
            returnByValue: true,
            silent: true,
          }),
        );
        if (response.result.value === true) matches.push(id);
      }
      if (matches.length !== 1) throw new Error("preflight frame execution-context ownership unavailable");
      return { root, id: matches[0] };
    })();
    this.contexts.set(frame, pending);
    return pending;
  }

  private quad(
    frame: Frame,
    id: number,
    kind: "content" | "padding" | "border" = "content",
  ): Promise<{ root: GeometryRoot; quad: Polygon } | null> {
    let entries = this.quads.get(frame);
    if (!entries) {
      entries = new Map();
      this.quads.set(frame, entries);
    }
    const key = `${id}:${kind}`;
    const existing = entries.get(key);
    if (existing) return existing;
    const pending = this.measureQuad(frame, id, kind);
    entries.set(key, pending);
    return pending;
  }

  private async measureQuad(
    frame: Frame,
    id: number,
    kind: "content" | "padding" | "border" = "content",
  ): Promise<{ root: GeometryRoot; quad: Polygon } | null> {
    const context = await this.context(frame);
    const response = await this.bounded(
      context.root.session.send("Runtime.evaluate", {
        expression: `globalThis[${JSON.stringify(this.key)}]?.nodes[${id}]`,
        contextId: context.id,
        objectGroup: this.key,
        silent: true,
      }),
    );
    const objectId = response.result.objectId;
    if (!objectId) throw new Error("preflight source node departed");
    const box = await this.bounded(context.root.session.send("DOM.getBoxModel", { objectId }));
    const quad = contentQuad(box.model[kind]);
    return quad ? { root: context.root, quad } : null;
  }

  private owner(frame: Frame): Promise<{ root: GeometryRoot; facts: ElementFacts; quad: Polygon } | null> {
    const existing = this.owners.get(frame);
    if (existing) return existing;
    const pending = (async () => {
      const parent = frame.parentFrame();
      if (!parent) return null;
      const prepared = await this.prepare(parent);
      const requested = frame.frameElement();
      void requested.then(
        (element) => {
          if (this.disposed || Date.now() >= this.deadline) void element.dispose().catch(() => undefined);
        },
        () => undefined,
      );
      const element = await this.bounded(requested);
      let facts: ElementFacts | null;
      try {
        facts = await this.bounded(
          element.evaluate(
            (element, { key, token }) => {
              if (!["iframe", "frame"].includes((element as Element).localName)) return null;
              const globals = (element as Element).ownerDocument.defaultView as unknown as Record<
                string,
                BrowserRegistry | undefined
              >;
              const registry = globals[key];
              return registry?.token === token ? registry.collect(element as Element) : null;
            },
            { key: this.key, token: prepared.token },
          ),
        );
      } finally {
        await this.bounded(element.dispose()).catch(() => undefined);
      }
      if (!facts?.supported) return null;
      const measured = await this.quad(parent, facts.id);
      return measured ? { ...measured, facts } : null;
    })();
    this.owners.set(frame, pending);
    return pending;
  }

  private async toMain(polygon: Polygon, root: GeometryRoot): Promise<Polygon | null> {
    if (root.frame === this.page.mainFrame()) return polygon;
    const owner = await this.owner(root.frame);
    if (!owner) return null;
    const clipped = intersectPolygons(
      polygon,
      rectPolygon({ x: 0, y: 0, width: owner.facts.width, height: owner.facts.height }),
    );
    if (clipped.length === 0) return [];
    const mapping = rectangleHomography(owner.facts.width, owner.facts.height, owner.quad);
    const mapped = mapping ? mapPolygon(mapping, clipped) : null;
    return mapped ? await this.toMain(mapped, owner.root) : null;
  }

  async canvases(frame: Frame): Promise<{ candidates: ProjectedCanvas[]; skipped: number }> {
    const own = await this.prepare(frame);
    const candidates: ProjectedCanvas[] = [];
    let skipped = 0;
    for (const facts of own.canvases) {
      if (!facts.supported) {
        skipped++;
        continue;
      }
      const measured = await this.quad(frame, facts.id);
      if (!measured) {
        skipped++;
        continue;
      }
      const polygon = await this.toMain(measured.quad, measured.root);
      if (!polygon || polygon.length < 3) {
        skipped++;
        continue;
      }
      const clips: Polygon[] = [];
      let supported = true;
      const addClips = async (source: Frame, ids: ClipFact[]) => {
        for (const { id, kind } of ids) {
          const clip = await this.quad(source, id, kind);
          const projected = clip ? await this.toMain(clip.quad, clip.root) : null;
          if (!projected || projected.length < 3) {
            supported = false;
            return;
          }
          clips.push(projected);
        }
      };
      await addClips(frame, facts.clips);
      for (
        let ancestor: Frame | null = frame;
        supported && ancestor?.parentFrame();
        ancestor = ancestor.parentFrame()
      ) {
        const owner = await this.owner(ancestor);
        if (!owner) {
          supported = false;
          break;
        }
        const projected = await this.toMain(owner.quad, owner.root);
        if (!projected || projected.length < 3) {
          supported = false;
          break;
        }
        clips.push(projected);
        await addClips(ancestor.parentFrame()!, owner.facts.clips);
      }
      if (supported) candidates.push({ polygon, clips });
      else skipped++;
    }
    return { candidates, skipped };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const cleanup = [...this.sessions].map((session) => {
      // A stalled release must not prevent detaching the session we own.
      void session.send("Runtime.releaseObjectGroup", { objectGroup: this.key }).catch(() => undefined);
      return session.detach().catch(() => undefined);
    });
    for (const [frame, token] of this.tokens)
      cleanup.push(
        evaluateInFrame(
          frame,
          ({ key, token }) => {
            const globals = globalThis as unknown as Record<string, BrowserRegistry | undefined>;
            if (globals[key]?.token === token) delete globals[key];
          },
          { key: this.key, token },
        ).catch(() => undefined),
      );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(cleanup),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 100);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
