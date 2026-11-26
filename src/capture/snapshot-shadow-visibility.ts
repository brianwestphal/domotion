import type { CDPSession, Frame, Page } from "@playwright/test";
import { withTimeout } from "../utils/with-timeout.js";
import { detachQuietly, isSameProcessFrameError } from "./cdp-lifecycle.js";
import { type PiercedNode, visitPiercedNodes } from "./pierced-dom-tree.js";
import { privateCaptureKey } from "./private-key.js";

// DocumentAnimations::getAnimations(TreeScope) enumerates exactly one scope.
// InspectorDOMAgent's pierced tree includes open and closed author roots. For
// each actual backend root, read ShadowRoot.getAnimations in its document's
// isolated world. No author getter, DOM write or animation mutation is needed.
const readRoots = `function(...roots) {
  if (this !== document) return "wrong document";
  for (const root of roots) {
    if (!(root instanceof ShadowRoot) || root.ownerDocument !== this || !root.isConnected ||
        root.host.getRootNode({composed:true}) !== this || (root.mode !== "open" && root.mode !== "closed"))
      return "wrong author root";
    for (const animation of ShadowRoot.prototype.getAnimations.call(root)) {
      if (animation instanceof CSSTransition && animation.transitionProperty === "visibility" &&
          animation.playState !== "idle" && animation.playState !== "finished") return "active";
    }
  }
  return "clear";
}`;
const worldName = privateCaptureKey("SnapshotShadowVisibility");
type DocumentRoots = { document: number; frameId: string; roots: number[] };

function inventory(root: PiercedNode, frameId: string) {
  const documents: DocumentRoots[] = [];
  const frontends = new Set<number>();
  const backends = new Set<number>();
  let count = 0,
    roots = 0;
  const byDocument = new Map<PiercedNode, DocumentRoots>();
  visitPiercedNodes(
    root,
    ({ node, document: doc, frameId: frame, shadow }) => {
      if (++count > 20_000) throw new Error("snapshot visibility pierced-node budget exceeded");
      if (node === doc) {
        if (!frame) throw new Error("snapshot visibility frame/document identity unavailable");
        const scope = { document: doc.backendNodeId, frameId: frame, roots: [] };
        documents.push(scope);
        byDocument.set(doc, scope);
      }
      if (shadow != null && shadow.shadowRootType !== "user-agent") {
        if (node.nodeId != null) frontends.add(node.nodeId);
        backends.add(node.backendNodeId);
      }
      if (shadow === node && shadow.shadowRootType !== "user-agent") {
        if (shadow.shadowRootType !== "open" && shadow.shadowRootType !== "closed")
          throw new Error("snapshot visibility author-shadow scope is unrecognized");
        if (++roots > 256) throw new Error("snapshot visibility author-shadow root budget exceeded");
        byDocument.get(doc)!.roots.push(shadow.backendNodeId);
      }
    },
    { frameId, includePseudoElements: true },
  );
  return { documents, frontends, backends };
}

async function checkRoots(session: CDPSession, documents: DocumentRoots[]): Promise<void> {
  await Promise.all(
    documents
      .filter((doc) => doc.roots.length > 0)
      .map(async (doc) => {
        const { executionContextId } = await session.send("Page.createIsolatedWorld", {
          frameId: doc.frameId,
          worldName,
        });
        const ids = await Promise.all(
          [doc.document, ...doc.roots].map(async (backendNodeId) => {
            const { object } = await session.send("DOM.resolveNode", { backendNodeId, executionContextId });
            if (!object.objectId) throw new Error("snapshot visibility author-shadow backend unavailable");
            return object.objectId;
          }),
        );
        const reply = await session.send("Runtime.callFunctionOn", {
          objectId: ids[0],
          functionDeclaration: readRoots,
          arguments: ids.slice(1).map((objectId) => ({ objectId })),
          returnByValue: true,
          silent: true,
        });
        if (reply.result.value === "active")
          throw new Error("snapshot visibility transition in an author shadow root is unsupported");
        if (reply.exceptionDetails || reply.result.value !== "clear")
          throw new Error("snapshot visibility author-shadow transition authority unavailable");
      }),
  );
}

/** One bounded, observation-only lease for a raster. Same-process child
 * documents appear in their parent's pierced tree. OOPIFs have their own
 * Playwright CDP sessions, including when their URL is cross-origin. */
export async function openSnapshotShadowVisibilityGuard(page: Page) {
  const frames = page.frames();
  if (frames.length === 0 || !frames.includes(page.mainFrame()))
    throw new Error("snapshot visibility source frame unavailable");
  if (frames.length > 64) throw new Error("snapshot visibility frame budget exceeded");
  const sessions: CDPSession[] = [];
  const observedFrames = new Set<string>();
  const checks: Array<() => Promise<void>> = [];
  let closed = false,
    changed = false;
  const invalidate = () => {
    changed = true;
  };
  const check = () => {
    if (closed || changed) throw new Error("snapshot visibility author-shadow ownership changed during isolation");
  };
  const bounded = async (operation: Promise<void>) => {
    const finished = await withTimeout(
      operation.then(() => true),
      2_000,
      false,
    );
    if (!finished) throw new Error("snapshot visibility author-shadow check exceeded 2000ms");
    check();
  };
  const dispose = async () => {
    closed = true;
    page.off("frameattached", invalidate).off("framedetached", invalidate).off("framenavigated", invalidate);
    const detached = await withTimeout(Promise.all(sessions.map(detachQuietly)), 1_000);
    if (!detached) throw new Error("snapshot visibility author-shadow session cleanup exceeded 1000ms");
  };
  const open = async (frame: Frame) => {
    let session: CDPSession;
    try {
      session = await page.context().newCDPSession(frame);
    } catch (error) {
      if (frame !== page.mainFrame() && isSameProcessFrameError(error)) return;
      throw error;
    }
    if (closed) {
      await detachQuietly(session);
      return;
    }
    sessions.push(session);
    await session.send("DOM.enable");
    const [tree, frames] = await Promise.all([
      session.send("DOM.getDocument", { depth: -1, pierce: true }),
      session.send("Page.getFrameTree"),
    ]);
    const frameId = frames.frameTree.frame.id;
    const original = inventory(tree.root, frameId);
    for (const doc of original.documents) {
      if (observedFrames.has(doc.frameId)) throw new Error("snapshot visibility frame/document identity unavailable");
      observedFrames.add(doc.frameId);
    }
    const snapshot = JSON.stringify(original.documents);
    session.on("DOM.documentUpdated", invalidate);
    session.on("DOM.shadowRootPushed", ({ root }) => {
      if (root.shadowRootType !== "user-agent") invalidate();
    });
    session.on("DOM.shadowRootPopped", ({ rootId }) => {
      if (original.frontends.has(rootId)) invalidate();
    });
    session.on("DOM.childNodeInserted", ({ parentNodeId, node }) => {
      // An inserted, previously detached branch can already contain a closed
      // root. CDP can omit its descendants from this incremental event.
      if (
        original.frontends.has(parentNodeId) ||
        node.shadowRoots?.some((root) => root.shadowRootType !== "user-agent") ||
        (node.childNodeCount ?? 0) > (node.children?.length ?? 0) ||
        node.children?.some((child) => child.nodeType === 1)
      )
        invalidate();
    });
    session.on("DOM.childNodeCountUpdated", invalidate);
    let armed = false;
    session.on("DOM.pseudoElementAdded", ({ parentId, pseudoElement }) => {
      if (!original.frontends.has(parentId)) return;
      // The first native getAnimations() can commit style and materialize an
      // existing ::before. Its Animation backend is the pseudo, not its host.
      original.frontends.add(pseudoElement.nodeId);
      original.backends.add(pseudoElement.backendNodeId);
      if (armed) invalidate();
    });
    session.on("DOM.pseudoElementRemoved", ({ parentId }) => {
      if (armed && original.frontends.has(parentId)) invalidate();
    });
    session.on("DOM.childNodeRemoved", ({ parentNodeId }) => {
      if (original.frontends.has(parentNodeId)) invalidate();
    });
    if (original.backends.size > 0) {
      session.on("Animation.animationStarted", ({ animation }) => {
        if (
          animation.type === "CSSTransition" &&
          animation.name === "visibility" &&
          (animation.source?.backendNodeId == null || original.backends.has(animation.source.backendNodeId))
        )
          invalidate();
      });
      await session.send("Animation.enable");
    }
    await checkRoots(session, original.documents);
    armed = true;
    checks.push(async () => {
      const { node } = await session.send("DOM.describeNode", {
        backendNodeId: tree.root.backendNodeId,
        depth: -1,
        pierce: true,
      });
      const current = inventory(node, frameId);
      if (JSON.stringify(current.documents) !== snapshot) invalidate();
      check();
      await checkRoots(session, current.documents);
    });
  };
  page.on("frameattached", invalidate).on("framedetached", invalidate).on("framenavigated", invalidate);
  try {
    await bounded(Promise.all(frames.map(open)).then(() => undefined));
    if (observedFrames.size !== frames.length)
      throw new Error("snapshot visibility frame/document coverage is incomplete");
  } catch (error) {
    await dispose();
    throw error;
  }
  let releasing: Promise<void> | undefined;
  const verifyAndDispose = async () => {
    try {
      await bounded(Promise.all(checks.map((verify) => verify())).then(() => undefined));
    } finally {
      await dispose();
    }
  };
  return { dispose: () => (releasing ??= verifyAndDispose()) };
}
