/** Public-CDP ownership proof for native CSS paint isolation, not a rendering probe. */
import type { CDPSession, Page } from "@playwright/test";
import { type PiercedNode as TreeNode, visitPiercedNodes } from "./pierced-dom-tree.js";
export type { PiercedNode as TreeNode } from "./pierced-dom-tree.js";
import { browserCallbackExpression } from "./evaluate-in-frame.js";
import type { ExternalCssSvgJournal } from "./external-css-svg.js";

type Identity = { key: string; token: string; ownerToken: string };
async function bounded<T>(work: Promise<T>, timeout = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("external CSS shadow ownership query timed out")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** At most this many author roots are registered for one isolation. */
const AUTHOR_ROOT_BUDGET = 256;

/** The owner's occurrence count and the main document's author roots, in tree order.
 * Author roots inside embedded documents refuse: this fallback has no authenticated
 * foreign-frame visibility isolation contract. */
export function authorTopology(root: TreeNode, ownerBackend: number | undefined): { owners: number; roots: number[] } {
  let owners = 0;
  const roots: number[] = [];
  visitPiercedNodes(root, ({ node, document, shadow }) => {
    if (node.backendNodeId === ownerBackend) owners++;
    if (node === shadow && node.shadowRootType !== "user-agent") {
      if (document !== root)
        throw new Error("external CSS native isolation has unsupported author-shadow paint in an embedded document");
      roots.push(node.backendNodeId);
    }
  });
  return { owners, roots };
}

/** Collect actual CSS owners in main-document author scopes which a document
 * selector cannot reach. Resolve only this document's backend roots in their
 * own page world. Embedded documents retain the existing raster boundary. */
export async function discoverExternalCssShadowTargets(page: Page, identity: { key: string; token: string }) {
  let session: CDPSession | undefined;
  let closed = false;
  const discover = async () => {
    const active = await page.context().newCDPSession(page);
    if (closed) {
      await active.detach();
      return;
    }
    session = active;
    const { root } = await active.send("DOM.getDocument", { depth: -1, pierce: true });
    const roots: number[] = [];
    visitPiercedNodes(root, ({ node, document, shadow }) => {
      if (document !== root || node !== shadow || node.shadowRootType === "user-agent") return;
      if (node.shadowRootType !== "open" && node.shadowRootType !== "closed")
        throw new Error("external CSS shadow discovery has an unsupported tree scope");
      roots.push(node.backendNodeId);
    });
    if (!roots.length) return;
    const resolve = async (backendNodeId: number) => {
      const { object } = await active.send("DOM.resolveNode", { backendNodeId });
      if (object.objectId == null) throw new Error("external CSS shadow discovery identity unavailable");
      return object.objectId;
    };
    const documentId = await resolve(root.backendNodeId);
    const collect = function (this: Document, { key, token }: { key: string; token: string }, ...roots: ShadowRoot[]) {
      const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined;
      if (this !== document || state?.token !== token || new Set(roots).size !== roots.length)
        throw new Error("external CSS shadow candidate document identity changed");
      for (const root of roots) {
        if (
          !(root instanceof ShadowRoot) ||
          root.ownerDocument !== this ||
          root.host.getRootNode({ composed: true }) !== this
        )
          throw new Error("external CSS shadow candidate root identity changed");
        for (const element of root.querySelectorAll("*")) {
          if (!(element instanceof HTMLElement || element instanceof SVGElement)) continue;
          const style = getComputedStyle(element);
          for (const property of ["clip-path", "mask-image"] as const) {
            const computed = style.getPropertyValue(property);
            if (!/url\(/i.test(computed)) continue;
            const shadowPath: Node[] = [];
            for (
              let node: Node | null = element;
              node != null;
              node = node instanceof ShadowRoot ? node.host : node.parentNode
            )
              shadowPath.push(node);
            state.targets.push({ element, property, computed, references: [], shadowPath });
          }
        }
      }
      return true;
    };
    // Discovery also runs on pages without resource paint. Batch remote handles
    // so a document with many idle custom elements can take its ordinary path.
    for (let i = 0; i < roots.length; i += AUTHOR_ROOT_BUDGET) {
      const ids = await Promise.all(roots.slice(i, i + AUTHOR_ROOT_BUDGET).map(resolve));
      const result = await active.send("Runtime.callFunctionOn", {
        objectId: documentId,
        functionDeclaration: collect.toString(),
        arguments: [{ value: identity }, ...ids.map((objectId) => ({ objectId }))],
        returnByValue: true,
        silent: true,
      });
      if (result.exceptionDetails || result.result.value !== true)
        throw new Error("external CSS shadow candidate discovery failed");
    }
  };
  try {
    await bounded(discover(), 5000);
  } finally {
    closed = true;
    if (session) await bounded(session.detach());
  }
}

/** Registers the actual author roots in the private journal. `this` is the bound owner;
 * every argument after the identity is a ShadowRoot resolved from a backend node. */
const registerAuthorRoots = `function(key, token, ownerToken, ...roots) {
  const state = globalThis[key];
  if (state == null || state.token !== token || state.isolation != null) throw new Error("journal");
  const selected = [...state.rasterOwners].filter(([, value]) => value.token === ownerToken);
  if (selected.length !== 1 || selected[0][0] !== this) throw new Error("owner");
  if (
    new Set(roots).size !== roots.length ||
    roots.some((root) => !(root instanceof ShadowRoot) || root.host.getRootNode({ composed: true }) !== document)
  )
    throw new Error("root");
  state.authorShadowRoots = roots;
  return roots.length;
}`;

/** A retained remote owner and original document, never a transferable topology boolean.
 * InspectorDOMAgent's pierced tree includes empty/open/closed author roots
 * (`BuildObjectForNode` pushes every `GetShadowRoot()`, inspector_dom_agent.cc:2375-2381
 * at Chromium 7d859f27). The main document's author roots are resolved by backend node
 * into the journal's own default context (`resolveNode`, :1886-1917) and registered so
 * isolation can reach closed trees.
 *
 * Open the guard before isolation and `arm()` it after: arming re-verifies the owner,
 * the document and the exact author-root set, and DOM topology events from then on
 * invalidate the lease even if a late root is removed before the final tree query.
 * UA trees are browser-owned and do not grant author paint a separate CSS scope. */
export async function openCssSvgShadowGuard(
  page: Page,
  identity: Identity,
): Promise<{
  /** Re-verifies topology and starts invalidating on DOM topology events. */
  arm(): Promise<void>;
  verify(): Promise<void>;
  dispose(): Promise<void>;
}> {
  let session: CDPSession | undefined;
  let disposed = false;
  let objectId: string | undefined;
  let ownerBackend: number | undefined;
  let documentBackend: number | undefined;
  /** Backend IDs of the registered main-document author roots. */
  let registered: Set<number> | undefined;
  let context: { id: number; uniqueId: string } | undefined;
  let armed = false;
  let changed = false;
  let deadline = Date.now() + 5000;
  const query = <T>(work: Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void work.catch(() => undefined);
      return Promise.reject(new Error("external CSS shadow ownership query timed out"));
    }
    return bounded(work, Math.min(1000, remaining));
  };
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (session == null) return;
    // Detach releases this session's remote objects and DOM subscriptions together.
    try {
      await bounded(session.detach());
    } catch (error) {
      if (!page.isClosed())
        throw new Error("external CSS shadow ownership session cleanup unconfirmed", { cause: error });
    }
  };
  const verify = async (): Promise<void> => {
    if (armed) deadline = Date.now() + 5000;
    if (disposed || session == null || objectId == null || context == null || changed)
      throw new Error("external CSS shadow ownership changed or unavailable");
    const selected = await query(
      session.send("Runtime.evaluate", {
        uniqueContextId: context.uniqueId,
        expression: browserCallbackExpression(({ key, token, ownerToken }) => {
          const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined;
          if (state?.token !== token) throw new Error("external CSS shadow source document changed");
          const selected = [...state.rasterOwners].filter(([, value]) => value.token === ownerToken);
          if (selected.length !== 1 || !selected[0][0].isConnected || selected[0][0].ownerDocument !== document)
            throw new Error("external CSS shadow source owner changed");
          return selected[0][0];
        }, identity),
        silent: true,
      }),
    );
    const candidateId = selected.result.objectId;
    if (selected.exceptionDetails != null || candidateId == null)
      throw new Error("external CSS shadow source owner/document identity unavailable");
    {
      const same = await query(
        session.send("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration:
            "function(candidate) { return this === candidate && this.isConnected && this.ownerDocument === document; }",
          arguments: [{ objectId: candidateId }],
          returnByValue: true,
          silent: true,
        }),
      );
      const described = await query(session.send("DOM.describeNode", { objectId: candidateId }));
      const tree = await query(session.send("DOM.getDocument", { depth: -1, pierce: true }));
      if (
        same.exceptionDetails != null ||
        same.result.value !== true ||
        described.node.backendNodeId !== ownerBackend ||
        tree.root.backendNodeId !== documentBackend
      )
        throw new Error("external CSS shadow source owner/document changed");
      const { owners, roots } = authorTopology(tree.root, ownerBackend);
      const expected = registered;
      if (
        owners !== 1 ||
        changed ||
        expected == null ||
        roots.length !== expected.size ||
        roots.some((root) => !expected.has(root))
      )
        throw new Error("external CSS shadow ownership changed or unavailable");
    }
    // Candidate remote handles remain owned by this session until detach. A
    // separate release failure must not replace the original proof error.
  };
  try {
    const creating = page.context().newCDPSession(page);
    void creating.then(
      (created) => {
        if (disposed) void created.detach().catch(() => undefined);
      },
      () => undefined,
    );
    session = await query(creating);
    const defaults: Array<{ id: number; uniqueId: string }> = [];
    session.on("Runtime.executionContextCreated", ({ context }) => {
      const isDefault: unknown = context.auxData?.["isDefault"];
      if (isDefault === true) defaults.push({ id: context.id, uniqueId: context.uniqueId });
    });
    session.on("Runtime.executionContextDestroyed", (event) => {
      if (event.executionContextId === context?.id) changed = true;
    });
    session.on("Runtime.executionContextsCleared", () => {
      changed = true;
    });
    const topologyChanged = (): void => {
      if (armed) changed = true;
    };
    session.on("DOM.documentUpdated", topologyChanged);
    session.on("DOM.shadowRootPushed", topologyChanged);
    session.on("DOM.shadowRootPopped", topologyChanged);
    session.on("DOM.childNodeInserted", topologyChanged);
    session.on("DOM.childNodeRemoved", topologyChanged);
    session.on("DOM.distributedNodesUpdated", topologyChanged);
    await query(session.send("Runtime.enable"));
    await query(session.send("DOM.enable"));
    for (const candidate of defaults) {
      const result = await query(
        session.send("Runtime.evaluate", {
          uniqueContextId: candidate.uniqueId,
          expression: browserCallbackExpression(
            ({ key, token }) =>
              (globalThis as unknown as Record<string, { token?: string } | undefined>)[key]?.token === token,
            identity,
          ),
          returnByValue: true,
          silent: true,
        }),
      );
      if (result.exceptionDetails == null && result.result.value === true) {
        if (context != null) throw new Error("external CSS shadow source document identity ambiguous");
        context = candidate;
      }
    }
    if (context == null) throw new Error("external CSS shadow source document identity unavailable");
    const selected = await query(
      session.send("Runtime.evaluate", {
        uniqueContextId: context.uniqueId,
        expression: browserCallbackExpression(({ key, token, ownerToken }) => {
          const state = (globalThis as Record<string, unknown>)[key] as ExternalCssSvgJournal | undefined;
          if (state?.token !== token) return null;
          const selected = [...state.rasterOwners].filter(([, value]) => value.token === ownerToken);
          return selected.length === 1 && selected[0][0].ownerDocument === document ? selected[0][0] : null;
        }, identity),
        silent: true,
      }),
    );
    objectId = selected.result.objectId;
    if (selected.exceptionDetails != null || objectId == null)
      throw new Error("external CSS shadow source owner identity unavailable");
    ownerBackend = (await query(session.send("DOM.describeNode", { objectId }))).node.backendNodeId;
    const tree = await query(session.send("DOM.getDocument", { depth: -1, pierce: true }));
    documentBackend = tree.root.backendNodeId;
    const roots = authorTopology(tree.root, ownerBackend).roots;
    if (roots.length > AUTHOR_ROOT_BUDGET)
      throw new Error("external CSS native isolation author-shadow budget exceeded");
    const resolved: string[] = [];
    for (const backendNodeId of roots) {
      const remote = await query(session.send("DOM.resolveNode", { backendNodeId, executionContextId: context.id }));
      if (remote.object.objectId == null) throw new Error("external CSS shadow author root identity unavailable");
      resolved.push(remote.object.objectId);
    }
    const registration = await query(
      session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: registerAuthorRoots,
        arguments: [
          { value: identity.key },
          { value: identity.token },
          { value: identity.ownerToken },
          ...resolved.map((root) => ({ objectId: root })),
        ],
        returnByValue: true,
        silent: true,
      }),
    );
    if (registration.exceptionDetails != null || registration.result.value !== roots.length)
      throw new Error("external CSS shadow author root registration unavailable");
    registered = new Set(roots);
    await verify();
    const arm = async (): Promise<void> => {
      if (armed) throw new Error("external CSS shadow ownership guard already armed");
      // Arming is its own five-second phase, after the caller's isolation work.
      deadline = Date.now() + 5000;
      await verify();
      armed = true;
    };
    return { arm, verify, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "external CSS shadow ownership and cleanup failed");
    }
    throw error;
  }
}
