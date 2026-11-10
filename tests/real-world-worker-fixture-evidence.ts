/** Evidence-only ownership for the synthetic startup diagnostic fixture. */
import { createHash, randomUUID } from "node:crypto";
import { cdpBounded } from "./real-world-cdp.js";

export type FixtureMode = "healthy" | "throw" | "null";
export const FIXTURE_COOKIE = "__domotionWorkerFixture";
export function startupFixtureScript(mode: FixtureMode): string {
  const draw = `const canvas=new OffscreenCanvas(1,1);${mode === "null" ? "canvas.getContext('2d');" : ""}const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true});gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);port.onmessage=()=>port.postMessage(Array.from(pixel));port.start();port.postMessage(Array.from(pixel));`;
  return `onconnect=({ports:[port]})=>{${mode === "throw" ? "throw new Error('controlled onconnect throw');" : draw}};`;
}
const modes: FixtureMode[] = ["healthy", "throw", "null"];
const hashes = new Map(
  modes.map((mode) => [createHash("sha256").update(startupFixtureScript(mode)).digest("hex"), mode]),
);
export interface FixtureResponse {
  servedMode: FixtureMode | "unknown";
  modeMatchesClaim: boolean;
  path: "/worker.js";
  bytes: number;
  sha256: string | null;
  contentType: "text/javascript";
  serverFinished: boolean;
  connectionClosed: boolean;
}
export interface FixtureFailure {
  stage: "construct" | "ready" | "test";
  error: { name: string; detail: string };
  observedAt: string;
  capture: "pending" | "complete" | "unavailable";
  persistence: "pending" | "written" | "unavailable";
  evidence?: unknown;
}
export interface FixtureContext {
  id: number;
  label: string;
  expectedMode: FixtureMode;
  modeAtConstruction?: FixtureMode;
  processId: number;
  browserVersion: string;
  construction: "not_started" | "started" | "complete" | "failed";
  responses: FixtureResponse[];
  droppedResponses: number;
  failure?: FixtureFailure;
  cleanup: "pending" | "closed" | "unconfirmed";
}
/** Only the private map holds cookie values. Snapshot rows never contain
 * headers, cookies, script bodies or arbitrary exception strings. */
export class StartupFixtureJournal {
  readonly rows: FixtureContext[] = [];
  droppedContexts = 0;
  droppedResponses = 0;
  unattributedResponses = 0;
  #bindings = new Map<string, FixtureContext>();
  register(
    label: string,
    expectedMode: FixtureMode,
    processId: number,
    browserVersion: string,
  ): { row: FixtureContext; token: string } | undefined {
    if (this.rows.length >= 64) {
      this.droppedContexts++;
      return;
    }
    if (!/^[a-z0-9: -]{1,100}$/i.test(label)) throw new Error("Invalid fixture label");
    const row: FixtureContext = {
      id: this.rows.length + 1,
      label,
      expectedMode,
      processId,
      browserVersion,
      construction: "not_started",
      responses: [],
      droppedResponses: 0,
      cleanup: "pending",
    };
    const token = randomUUID().replaceAll("-", "");
    this.rows.push(row);
    this.#bindings.set(token, row);
    return { row, token };
  }
  response(cookieHeader: string | undefined, claimedMode: FixtureMode, body: string): FixtureResponse | undefined {
    const tokens =
      cookieHeader != null && cookieHeader.length <= 512
        ? cookieHeader
            .split(";")
            .map((part) => part.trim())
            .filter((part) => part.startsWith(FIXTURE_COOKIE + "="))
        : [];
    const token = tokens.length === 1 ? tokens[0].slice(FIXTURE_COOKIE.length + 1) : undefined;
    const row = token != null && /^[a-f0-9]{32}$/.test(token) ? this.#bindings.get(token) : undefined;
    if (row == null) {
      this.unattributedResponses = Math.min(1_000_000, this.unattributedResponses + 1);
      return;
    }
    if (row.responses.length >= 4 || this.rows.reduce((count, row) => count + row.responses.length, 0) >= 64) {
      row.droppedResponses++;
      this.droppedResponses++;
      return;
    }
    const bytes = Buffer.byteLength(body);
    const sha256 = bytes <= 4096 ? createHash("sha256").update(body).digest("hex") : null;
    const servedMode = sha256 == null ? "unknown" : (hashes.get(sha256) ?? "unknown");
    const fact: FixtureResponse = {
      servedMode,
      modeMatchesClaim: servedMode === claimedMode,
      path: "/worker.js",
      bytes,
      sha256,
      contentType: "text/javascript",
      serverFinished: false,
      connectionClosed: false,
    };
    row.responses.push(fact);
    return fact;
  }
  snapshot(): {
    contexts: Array<FixtureContext & { responseAssociation: string }>;
    droppedContexts: number;
    droppedResponses: number;
    unattributedResponses: number;
  } {
    return structuredClone({
      contexts: this.rows.map((row) => ({
        ...row,
        responseAssociation: row.responses.length > 0 ? "authenticated-context-cookie" : "unserved-or-unattributed",
      })),
      droppedContexts: this.droppedContexts,
      droppedResponses: this.droppedResponses,
      unattributedResponses: this.unattributedResponses,
    });
  }
  closed(processId: number, confirmed: boolean): void {
    for (const row of this.rows) if (row.processId === processId) row.cleanup = confirmed ? "closed" : "unconfirmed";
    // No future request may acquire a previous closed context's binding.
    for (const [token, row] of this.#bindings) if (row.processId === processId) this.#bindings.delete(token);
  }
}
export function fixtureError(error: unknown): { name: string; detail: string } {
  const name =
    error instanceof Error && ["Error", "TimeoutError", "TypeError", "TargetClosedError"].includes(error.name)
      ? error.name
      : "other";
  const first = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : "";
  return { name, detail: /^page\.waitForFunction: Timeout 8000ms exceeded\.$/.test(first) ? first : "[redacted]" };
}
/** Retrospective evidence cannot replace the original exception, including
 * under bounded diagnostic/persistence failure. Callbacks only mutate Node data. */
export async function rethrowWithFixtureEvidence<T>(
  original: unknown,
  failure: FixtureFailure,
  capture: () => Promise<T>,
  persist: () => Promise<void>,
): Promise<never> {
  try {
    failure.evidence = await cdpBounded(Promise.resolve().then(capture), 2500, "Fixture failure evidence");
    failure.capture = "complete";
  } catch {
    failure.capture = "unavailable";
  }
  try {
    await cdpBounded(Promise.resolve().then(persist), 1000, "Fixture failure persistence");
    failure.persistence = "written";
  } catch {
    failure.persistence = "unavailable";
  }
  throw original;
}

/** Await owned cleanup, reporting its result without replacing an existing test failure. */
export async function closeFixtureOwner(
  close: () => Promise<void>,
  failed: boolean,
  report: (confirmed: boolean) => void,
): Promise<void> {
  try {
    await close();
    report(true);
  } catch (error) {
    report(false);
    if (!failed) throw error;
  }
}
