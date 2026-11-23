import type { CDPSession, Page } from "@playwright/test";
import { withTimeout } from "../utils/with-timeout.js";
import { browserCallbackExpression } from "./evaluate-in-frame.js";
import { privateCaptureKey } from "./private-key.js";
import { rootHasAuthorShadowContext } from "./inset-root-shadow-context.js";
import { probeFailureWarning } from "./probe-failure.js";
import { createBrowserAuthorShadowAdmin, type BrowserAuthorShadowRead } from "./author-shadow-context-browser.js";
import { encodePlainCaptureValue, decodePlainCaptureValue } from "./plain-capture-value.js";
import type { CaptureWarning } from "./types.js";
import type { AuthorShadowContextMode } from "./author-shadow-context-record.js";

export interface AuthorShadowContextOptions {
  mode: AuthorShadowContextMode;
  purpose: string;
}
export interface AuthorShadowContextProbe {
  readonly key?: string;
  readonly warnings: CaptureWarning[];
  verify(): Promise<void>;
  dispose(): Promise<void>;
}
export interface AuthorShadowScope {
  readonly warnings: CaptureWarning[];
  prepare(selector: string, options: AuthorShadowContextOptions): Promise<AuthorShadowContextProbe>;
  /** The same trusted CAPTURE_SCRIPT in the same default realm. Registered
   * private slots are overwritten by actual owned capabilities. Never retry
   * an executed/failed capture through a different transport. */
  evaluateCapture<T>(script: string, args: object): Promise<T>;
  verify(): Promise<void>;
  dispose(): Promise<void>;
}
interface OwnedProbe {
  key: string;
  selector: string;
  options: AuthorShadowContextOptions;
  warnings: CaptureWarning[];
  admin: string;
  backends: number[];
  invalid: Set<number>;
  closed: boolean;
  authenticated: boolean;
}
interface DomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  children?: DomNode[];
  shadowRoots?: DomNode[];
  shadowRootType?: string;
  contentDocument?: DomNode;
  distributedNodes?: Array<{ backendNodeId: number }>;
}
interface RuntimeException {
  text: string;
  exception?: { description?: string; value?: unknown };
  stackTrace?: { callFrames: Array<{ functionName: string; url: string; lineNumber: number; columnNumber: number }> };
}
interface Track {
  owner: OwnedProbe;
  index: number;
}

/** Match public Playwright1.59.1's Chromium exception description/value
 * interpretation without importing or patching private Playwright internals. */
function evaluationError(details: RuntimeException): Error {
  let message = details.exception?.description;
  if (details.exception && message == null) message = String(details.exception.value);
  if (message == null) {
    message = details.text;
    for (const frame of details.stackTrace?.callFrames ?? [])
      message += `\n    at ${frame.functionName || "<anonymous>"} (${frame.url}:${frame.lineNumber}:${frame.columnNumber})`;
  }
  return new Error(`page.evaluate: ${message}`);
}

/** One capture-owned carrier, two closed consumer modes with separate records,
 * object groups and lifetimes. Original admins/capabilities never enter page
 * globals. Only opaque objects registered by this scope can be injected. */
export function createAuthorShadowScope(page: Page, options: { timeoutMs?: number } = {}): AuthorShadowScope {
  const timeout = options.timeoutMs ?? 3000;
  const warnings: CaptureWarning[] = [];
  const group = privateCaptureKey("AuthorShadowCarrier");
  const probes = new Set<OwnedProbe>();
  const slots = new Map<AuthorShadowContextMode, OwnedProbe>();
  const reserved = new Set<AuthorShadowContextMode>();
  const nodeOwners = new Map<number, Set<Track>>();
  const backendOwners = new Map<number, Set<Track>>();
  const earlyEvents: Array<{ kind: "node" | "backend"; id: number }> = [];
  const pending = new Set<Promise<unknown>>();
  let session: CDPSession | undefined;
  let starting: Promise<void> | undefined;
  let abandonedSession = false;
  let context: { id: number; uniqueId: string } | undefined;
  let carrier: string | undefined;
  let documentBackend: number | undefined;
  let disposed = false,
    closing = false,
    sealed = false,
    armed = false,
    indexed = false,
    contextLost = false;
  let deadline = performance.now() + timeout;
  const report = (selector: string, purpose: string, probe: string, cause: unknown, target = warnings) =>
    target.push(
      probeFailureWarning({
        selector,
        feature: purpose,
        probe,
        cause,
        status: "unavailable",
        effect: "new candidate authority is absent; prior rendering remains",
      }),
    );
  const query = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remaining = deadline - performance.now();
    if (disposed || closing || !Number.isFinite(remaining) || remaining <= 0)
      throw new Error("author-shadow Node deadline expired");
    const value = await withTimeout(operation(), remaining);
    if (value === undefined || disposed || closing) throw new Error("author-shadow Node deadline expired");
    return value;
  };
  const target = (event: { kind: "node" | "backend"; id: number }) => {
    if (!armed) return;
    if (!indexed) {
      if (earlyEvents.length >= 8192) contextLost = true;
      else earlyEvents.push(event);
      return;
    }
    for (const track of (event.kind === "node" ? nodeOwners : backendOwners).get(event.id) ?? [])
      track.owner.invalid.add(track.index);
  };
  const cleanupWarned = new Set<string>();
  const closeRemote = async (active: CDPSession, key: string, admin?: string) => {
    const issues: string[] = [];
    const attempt = async (label: string, operation: () => Promise<unknown>) => {
      try {
        const completed = await withTimeout(
          operation().then((reply) => ({ reply })),
          250,
        );
        if (completed === undefined) issues.push(`${label} timed out`);
        else if (completed.reply && typeof completed.reply === "object" && "exceptionDetails" in completed.reply)
          issues.push(`${label} returned an exception`);
      } catch {
        issues.push(`${label} rejected`);
      }
    };
    if (admin)
      await attempt("original closure close", () =>
        active.send("Runtime.callFunctionOn", {
          objectId: admin,
          functionDeclaration: "function(){this.close();}",
          silent: true,
        }),
      );
    await attempt("owned group release", () => active.send("Runtime.releaseObjectGroup", { objectGroup: key }));
    if (issues.length && !cleanupWarned.has(key)) {
      cleanupWarned.add(key);
      report("capture", "author-shadow context", "owned cleanup confirmation", issues.join("; "));
    }
  };
  const closeAdmin = async (owner: OwnedProbe) => {
    if (session) await closeRemote(session, owner.key, owner.admin);
  };
  const disposeProbe = async (owner: OwnedProbe) => {
    if (owner.closed) return;
    owner.closed = true;
    if (slots.get(owner.options.mode) === owner) slots.delete(owner.options.mode);
    await closeAdmin(owner);
  };
  const ensure = async () => {
    if (starting) return starting;
    starting = (async () => {
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("invalid author-shadow Node deadline");
      const active = await query(() => {
        const creating = page.context().newCDPSession(page);
        void creating.then(
          (created) => {
            if (disposed || closing || abandonedSession) void created.detach().catch(() => undefined);
          },
          () => undefined,
        );
        return creating;
      });
      session = active;
      const contexts: Array<{ id: number; uniqueId: string; frameId: unknown }> = [];
      active.on("Runtime.executionContextCreated", ({ context: created }) => {
        const isDefault: unknown = created.auxData?.["isDefault"];
        if (isDefault === true)
          contexts.push({ id: created.id, uniqueId: created.uniqueId, frameId: created.auxData?.["frameId"] });
      });
      active.on("Runtime.executionContextDestroyed", (event) => {
        if (event.executionContextId === context?.id) contextLost = true;
      });
      active.on("Runtime.executionContextsCleared", () => {
        if (context) contextLost = true;
      });
      active.on("DOM.documentUpdated", () => {
        if (armed) contextLost = true;
      });
      active.on("DOM.childNodeRemoved", (event) => target({ kind: "node", id: event.nodeId }));
      active.on("DOM.childNodeInserted", (event) => target({ kind: "node", id: event.node.nodeId }));
      active.on("DOM.shadowRootPushed", (event) => {
        if (event.root.shadowRootType !== "user-agent") target({ kind: "node", id: event.hostId });
      });
      active.on("DOM.shadowRootPopped", (event) => target({ kind: "node", id: event.hostId }));
      active.on("DOM.distributedNodesUpdated", (event) => {
        target({ kind: "node", id: event.insertionPointId });
        for (const node of event.distributedNodes) target({ kind: "backend", id: node.backendNodeId });
      });
      active.on("DOM.attributeModified", (event) => {
        if (event.name === "slot" || event.name === "name") target({ kind: "node", id: event.nodeId });
      });
      active.on("DOM.attributeRemoved", (event) => {
        if (event.name === "slot" || event.name === "name") target({ kind: "node", id: event.nodeId });
      });
      await query(() => active.send("Runtime.enable"));
      await query(() => active.send("DOM.enable"));
      const frame = await query(() => active.send("Page.getFrameTree"));
      const defaults = contexts.filter((value) => value.frameId === frame.frameTree.frame.id);
      if (defaults.length !== 1) throw new Error("main default execution context unavailable");
      context = defaults[0];
      const created = await query(() =>
        active.send("Runtime.evaluate", {
          uniqueContextId: defaults[0].uniqueId,
          expression: "({})",
          objectGroup: group,
        }),
      );
      if (created.exceptionDetails || !created.result.objectId) throw new Error("author-shadow carrier unavailable");
      carrier = created.result.objectId;
    })().catch((error) => {
      abandonedSession = true;
      throw error;
    });
    return starting;
  };
  const treeNodes = (root: DomNode): Array<{ node: DomNode; path: DomNode[] }> => {
    const queue = [{ node: root, path: [] as DomNode[] }],
      seen = new Set<DomNode>(),
      result: Array<{ node: DomNode; path: DomNode[] }> = [];
    while (queue.length) {
      const entry = queue.pop()!;
      if (performance.now() >= deadline || seen.has(entry.node) || seen.size >= 20000 || entry.path.length > 512)
        throw new Error("author-shadow pierced-tree budget exceeded");
      seen.add(entry.node);
      const path = [...entry.path, entry.node];
      result.push({ node: entry.node, path });
      for (const node of [...(entry.node.children ?? []), ...(entry.node.shadowRoots ?? [])])
        queue.push({ node, path });
      if (entry.node.contentDocument) queue.push({ node: entry.node.contentDocument, path });
    }
    return result;
  };
  const authenticate = async () => {
    if (sealed) return;
    sealed = true;
    if (slots.size === 0) return;
    deadline = performance.now() + timeout;
    const active = session;
    if (!active || contextLost) throw new Error("author-shadow context ownership lost before authentication");
    armed = true;
    const tree = await query(() => active.send("DOM.getDocument", { depth: -1, pierce: true }));
    documentBackend = tree.root.backendNodeId;
    const nodes = treeNodes(tree.root);
    const add = (map: Map<number, Set<Track>>, id: number, track: Track) => {
      let set = map.get(id);
      if (!set) {
        set = new Set();
        map.set(id, set);
      }
      set.add(track);
    };
    const byBackend = new Map<number, Track[]>();
    for (const owner of slots.values())
      for (let index = 0; index < owner.backends.length; index++) {
        const backend = owner.backends[index],
          track = { owner, index };
        const list = byBackend.get(backend) ?? [];
        list.push(track);
        byBackend.set(backend, list);
      }
    for (const { node, path } of nodes)
      for (const track of byBackend.get(node.backendNodeId) ?? [])
        for (const ancestor of path) {
          add(nodeOwners, ancestor.nodeId, track);
          add(backendOwners, ancestor.backendNodeId, track);
        }
    for (const { node } of nodes)
      for (const distributed of node.distributedNodes ?? [])
        for (const track of backendOwners.get(distributed.backendNodeId) ?? []) add(nodeOwners, node.nodeId, track);
    indexed = true;
    for (const event of earlyEvents) target(event);
    for (const owner of slots.values()) {
      const dispositions = owner.backends.map((backend) => rootHasAuthorShadowContext(tree.root, backend, deadline));
      const installed = await query(() =>
        active.send("Runtime.callFunctionOn", {
          objectId: owner.admin,
          functionDeclaration: "function(values){return this.install(values);}",
          arguments: [{ value: dispositions }],
          returnByValue: true,
        }),
      );
      if (installed.exceptionDetails || installed.result.value !== true || contextLost)
        throw new Error("author-shadow original context activation failed");
      owner.authenticated = true;
    }
  };
  const verifyOwners = async (owners: OwnedProbe[]) => {
    if (owners.length === 0) return;
    if (disposed || contextLost || !session || !carrier || !documentBackend)
      throw new Error("author-shadow context ownership changed or unavailable");
    deadline = performance.now() + timeout;
    const active = session;
    const originalCarrier = carrier;
    const readLedgers = async () => {
      if (owners.some((owner) => owner.closed || !owner.authenticated))
        throw new Error("author-shadow probe is inactive");
      // Both consumers must observe the same source instant. A separate read
      // per admin leaves earlier owners unchecked while a later reply is pending.
      const reply = await query(() =>
        active.send("Runtime.callFunctionOn", {
          objectId: originalCarrier,
          functionDeclaration: "function(...admins){return admins.map(admin=>admin.read());}",
          arguments: owners.map((owner) => ({ objectId: owner.admin })),
          returnByValue: true,
        }),
      );
      const reads: unknown = reply.result.value;
      if (reply.exceptionDetails || !Array.isArray(reads) || reads.length !== owners.length || contextLost)
        throw new Error("author-shadow original ledger unavailable");
      return owners.map((owner, index) => {
        const read = reads[index] as Partial<BrowserAuthorShadowRead> | null;
        if (
          read?.active !== true ||
          read.valid !== true ||
          !Array.isArray(read.used) ||
          !read.used.every((entry) => Number.isSafeInteger(entry) && entry >= 0 && entry < owner.backends.length)
        )
          throw new Error("author-shadow original candidate ownership changed");
        return read.used;
      });
    };
    const used = await readLedgers();
    if (used.every((indices) => indices.length === 0)) return;
    // getDocument discards frontend NodeId bindings. describeNode keeps the
    // original tracking epoch alive, including after this verification read.
    const described = await query(() =>
      active.send("DOM.describeNode", { backendNodeId: documentBackend, depth: -1, pierce: true }),
    );
    if (described.node.backendNodeId !== documentBackend || described.node.nodeType !== 9)
      throw new Error("author-shadow original document changed");
    treeNodes(described.node);
    for (const [position, indices] of used.entries()) {
      const owner = owners[position];
      for (const index of indices)
        if (
          owner.invalid.has(index) ||
          rootHasAuthorShadowContext(described.node, owner.backends[index], deadline) !== false
        )
          throw new Error("author-shadow adopted context changed during capture");
    }
    // An event can arrive after describeNode but before the final source read.
    const final = await readLedgers();
    for (const [position, indices] of used.entries()) {
      if (
        final[position].length !== indices.length ||
        indices.some((index, offset) => final[position][offset] !== index || owners[position].invalid.has(index))
      )
        throw new Error("author-shadow adopted ownership changed during verification");
    }
  };
  const prepare = async (selector: string, supplied: AuthorShadowContextOptions): Promise<AuthorShadowContextProbe> => {
    const consumer = Object.freeze({ mode: supplied.mode, purpose: supplied.purpose });
    const ownWarnings: CaptureWarning[] = [];
    const absent = (): AuthorShadowContextProbe => ({
      warnings: ownWarnings,
      verify: async () => undefined,
      dispose: async () => undefined,
    });
    if (
      disposed ||
      closing ||
      sealed ||
      !["selected-root", "inline-svg-roots"].includes(consumer.mode) ||
      typeof consumer.purpose !== "string" ||
      !consumer.purpose ||
      consumer.purpose.length > 128 ||
      reserved.has(consumer.mode)
    ) {
      report(
        selector,
        consumer.purpose,
        "closed consumer registration",
        "scope closed, unsupported, or duplicate mode",
        ownWarnings,
      );
      return absent();
    }
    reserved.add(consumer.mode);
    deadline = performance.now() + timeout;
    const key = privateCaptureKey("AuthorShadowProbe");
    let createdOwner: OwnedProbe | undefined;
    let cancelled = false;
    try {
      await ensure();
      const active = session!,
        defaultContext = context!;
      const reply = await query(() => {
        const creating = active.send("Runtime.evaluate", {
          uniqueContextId: defaultContext.uniqueId,
          expression: browserCallbackExpression(createBrowserAuthorShadowAdmin, {
            selector,
            mode: consumer.mode,
            purpose: consumer.purpose,
          }),
          objectGroup: key,
        });
        const late = creating.then(async (reply) => {
          if (disposed || closing || cancelled)
            await closeRemote(active, key, reply.exceptionDetails ? undefined : reply.result.objectId);
        });
        pending.add(late);
        void late.finally(() => pending.delete(late)).catch(() => undefined);
        return creating;
      });
      if (reply.exceptionDetails || !reply.result.objectId) throw new Error("author-shadow original admin unavailable");
      const admin = reply.result.objectId;
      createdOwner = {
        key,
        selector,
        options: consumer,
        warnings: ownWarnings,
        admin,
        backends: [],
        invalid: new Set(),
        closed: false,
        authenticated: false,
      };
      probes.add(createdOwner);
      const inventory = await query(() =>
        active.send("Runtime.callFunctionOn", {
          objectId: admin,
          functionDeclaration: "function(){return this.elements();}",
          objectGroup: key,
        }),
      );
      if (inventory.exceptionDetails || !inventory.result.objectId)
        throw new Error("author-shadow candidate inventory unavailable");
      const inventoryId = inventory.result.objectId;
      const properties = await query(() =>
        active.send("Runtime.getProperties", { objectId: inventoryId, ownProperties: true }),
      );
      const numeric = properties.result.filter((property) => /^(?:0|[1-9][0-9]*)$/.test(property.name));
      if (numeric.length > 128) throw new Error("author-shadow candidate budget exceeded");
      if (numeric.length === 0) {
        await disposeProbe(createdOwner);
        return absent();
      }
      for (let index = 0; index < numeric.length; index++) {
        const objectId = numeric.find((property) => property.name === String(index))?.value?.objectId;
        if (!objectId) throw new Error("author-shadow candidate handle unavailable");
        const described = await query(() => active.send("DOM.describeNode", { objectId }));
        createdOwner.backends.push(described.node.backendNodeId);
      }
      if (new Set(createdOwner.backends).size !== createdOwner.backends.length)
        throw new Error("author-shadow candidate identities are ambiguous");
      if (sealed || disposed || closing) throw new Error("author-shadow registration closed during preparation");
      const owner = createdOwner;
      slots.set(consumer.mode, owner);
      return {
        key,
        warnings: ownWarnings,
        verify: async () => {
          if (owner.closed) throw new Error("author-shadow probe is inactive");
          await authenticate();
          await verifyOwners([owner]);
        },
        dispose: () => disposeProbe(owner),
      };
    } catch (error) {
      cancelled = true;
      report(selector, consumer.purpose, "candidate source ownership", error, ownWarnings);
      if (createdOwner) await disposeProbe(createdOwner);
      else if (session) await closeRemote(session, key);
      reserved.delete(consumer.mode);
      return absent();
    }
  };
  const evaluateCapture = async <T>(script: string, args: object): Promise<T> => {
    if (disposed || closing) throw new Error("author-shadow scope is disposed");
    // Reserved private slots are never accepted from caller-supplied data.
    const clean = { ...args, authorShadowContexts: undefined };
    try {
      await authenticate();
    } catch (error) {
      report("capture", "author-shadow context", "source authentication", error);
      for (const owner of [...slots.values()]) await disposeProbe(owner);
    }
    if (disposed || closing) throw new Error("author-shadow scope disposed during authentication");
    const owners = [...slots.values()];
    const encoded = encodePlainCaptureValue(clean);
    const codec = `var __name=(fn)=>fn;const decode=(${decodePlainCaptureValue.toString()}),encode=(${encodePlainCaptureValue.toString()});const args=decode(wire);`;
    if (owners.length === 0) {
      const expression = `((wire)=>{${codec}Object.defineProperty(args,'authorShadowContexts',{value:Object.freeze({}),writable:true,enumerable:true,configurable:true});const result=(${script})(args);if(result&&typeof result.then==='function')return Promise.resolve(result).then(encode);return encode(result);})(${JSON.stringify(encoded)})`;
      return decodePlainCaptureValue(await page.evaluate(expression)) as T;
    }
    if (contextLost || !session || !carrier) throw new Error("author-shadow capture source context lost");
    const parameters = owners.map((_, index) => `admin${index}`);
    const capability = owners
      .map(
        (owner, index) =>
          `${JSON.stringify(owner.options.mode === "selected-root" ? "selectedRoot" : "inlineSvgRoots")}:admin${index}.capability`,
      )
      .join(",");
    const declaration = `function(wire,${parameters.join(",")}){"use strict";var __name=(fn)=>fn;const decode=(${decodePlainCaptureValue.toString()}),encode=(${encodePlainCaptureValue.toString()});const args=decode(wire);Object.defineProperty(args,'authorShadowContexts',{value:Object.freeze({${capability}}),writable:true,enumerable:true,configurable:true});const result=(${script})(args);if(result&&typeof result.then==='function')return Promise.resolve(result).then(encode);return encode(result);}`;
    // Do not impose the authority-query deadline on the actual source capture.
    const reply = await session.send("Runtime.callFunctionOn", {
      objectId: carrier,
      functionDeclaration: declaration,
      arguments: [{ value: encoded }, ...owners.map((owner) => ({ objectId: owner.admin }))],
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (reply.exceptionDetails) throw evaluationError(reply.exceptionDetails);
    const result = decodePlainCaptureValue(reply.result.value);
    await verifyOwners(owners);
    return result as T;
  };
  const dispose = async () => {
    if (disposed || closing) return;
    closing = true;
    // Close slots before releasing handles; another consumer cannot receive a
    // dead handle while a purpose-specific probe is being disposed.
    for (const owner of [...probes]) await disposeProbe(owner);
    disposed = true;
    const detach = async () => {
      if (session)
        await session.detach().catch((error) => {
          if (!page.isClosed()) report("capture", "author-shadow context", "carrier cleanup", error);
        });
    };
    const done = await withTimeout(
      Promise.allSettled([...pending]).then(() => true),
      500,
    );
    if (done === undefined)
      report("capture", "author-shadow context", "late cleanup", "owned late creation cleanup remains pending");
    // A never-resolving reply must not retain the owned CDP session. Pending
    // handlers still close any late original handles; detach is independent.
    const detached = await withTimeout(
      detach().then(() => true),
      250,
    );
    if (detached === undefined)
      report(
        "capture",
        "author-shadow context",
        "carrier cleanup",
        "owned session detach did not confirm before its bound",
      );
  };
  return {
    warnings,
    prepare,
    evaluateCapture,
    verify: async () => {
      await authenticate();
      await verifyOwners([...slots.values()]);
    },
    dispose,
  };
}
