/** Public-CDP ownership proof for native CSS paint isolation, not a rendering probe. */
import type { CDPSession, Page } from "@playwright/test";
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

/** A retained remote owner and original document, never a transferable topology boolean.
 * InspectorDOMAgent's pierced tree includes empty/open/closed author roots. DOM events
 * invalidate the lease even if a late root is removed before the final tree query.
 * UA trees are browser-owned and do not grant author paint a separate CSS scope. */
export async function openCssSvgShadowGuard(
  page: Page,
  identity: Identity,
): Promise<{
  verify(): Promise<void>;
  dispose(): Promise<void>;
}> {
  let session: CDPSession | undefined;
  let disposed = false;
  let objectId: string | undefined;
  let ownerBackend: number | undefined;
  let documentBackend: number | undefined;
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
      let owners = 0;
      const visit = (node: typeof tree.root): void => {
        if (node.backendNodeId === ownerBackend) owners++;
        for (const shadow of node.shadowRoots ?? []) {
          if (shadow.shadowRootType !== "user-agent")
            throw new Error("external CSS native isolation has unsupported author-shadow document paint");
        }
        for (const child of node.children ?? []) visit(child);
        // Refuse author contexts inside embedded documents too: this fallback has
        // no authenticated foreign-frame visibility isolation contract.
        if (node.contentDocument != null) visit(node.contentDocument);
      };
      visit(tree.root);
      if (owners !== 1 || changed) throw new Error("external CSS shadow ownership changed or unavailable");
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
    documentBackend = (await query(session.send("DOM.getDocument", { depth: -1, pierce: true }))).root.backendNodeId;
    await verify();
    armed = true;
    return { verify, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "external CSS shadow ownership and cleanup failed");
    }
    throw error;
  }
}
