import type { Page } from "@playwright/test";
import sharp from "sharp";
import { withCdpSession } from "./cdp-lifecycle.js";
import { privateCaptureKey } from "./private-key.js";
import type { CapturedElement, CaptureWarning } from "./types.js";
import { forEachElement } from "../tree-ops/for-each-element.js";
import { withTimeout } from "../utils/with-timeout.js";

const MAX_OWNERS = 128;
const MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const READ_TIMEOUT_MS = 5000;
const FORMAT_BY_MIME = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" } as const;

// Runs against the exact DOM receiver in an isolated world with the document's
// normal origin and CSP. In particular, page wrappers cannot redirect this read
// or substitute bytes through an overridden fetch.
const readSelectedBlob = `async function (request) {
  const { source, width, height, remaining, timeout, formats } = request;
  const owner = this;
  const stillSelected = () =>
    owner instanceof HTMLImageElement && owner.ownerDocument === document && owner.isConnected &&
    owner.complete && owner.currentSrc === source && owner.naturalWidth === width &&
    owner.naturalHeight === height && getComputedStyle(owner).content === "normal";
  if (!stillSelected()) return null;
  const url = new URL(source);
  if (url.protocol !== "blob:" || url.origin !== self.origin || url.hash !== "") return null;
  try {
    const reply = await fetch(source, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
    const mime = reply.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const size = Number(reply.headers.get("content-length"));
    if (!reply.ok || reply.url !== source || !formats.includes(mime) ||
        !Number.isSafeInteger(size) || size <= 0 || size > remaining) {
      await reply.body?.cancel();
      return null;
    }
    const blob = await reply.blob();
    if (blob.size !== size || !stillSelected()) return null;
    const dataUri = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(new Blob([blob], { type: mime }));
    });
    return stillSelected() && typeof dataUri === "string" ? { dataUri, mime, size } : null;
  } catch {
    return null;
  }
}`;

interface BlobRead {
  mime: string;
  size: number;
  dataUri: string;
}

function isStaticPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return false;
  }
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + length + 12;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (end > bytes.length || type === "acTL" || type === "fcTL" || type === "fdAT") return false;
    if (type === "IEND") return length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

async function staticRasterDataUri(read: BlobRead): Promise<string | undefined> {
  if (!Object.hasOwn(FORMAT_BY_MIME, read.mime)) return;
  const format = FORMAT_BY_MIME[read.mime as keyof typeof FORMAT_BY_MIME];
  const prefix = `data:${read.mime};base64,`;
  if (!read.dataUri.startsWith(prefix)) return;
  const bytes = Buffer.from(read.dataUri.slice(prefix.length), "base64");
  if (bytes.length !== read.size) return;
  if (format === "png" && !isStaticPng(bytes)) return;
  if (format === "jpeg" && !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return;
  if (format === "gif" && !/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return;
  if (format === "webp") {
    if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return;
    if (bytes.toString("ascii", 12, 16) === "VP8X" && (bytes[20] & 2) !== 0) return;
  }
  try {
    const meta = await sharp(bytes, { animated: true }).metadata();
    if (meta.format === format && (meta.pages ?? 1) === 1) return read.dataUri;
  } catch {
    // The browser source stays in place for unrecognized or unreadable bytes.
  }
}

/** Inline static bytes only for a live `<img>` from this capture's source-node
 * registry. Rewriting the corresponding node keeps bytes local to its tree. */
export async function embedCapturedStaticBlobImages(
  page: Page,
  tree: CapturedElement[],
  sourceNodeKey: string | undefined,
  warnings: CaptureWarning[],
): Promise<void> {
  const owners: Array<{ element: CapturedElement; index: number; source: string; width: number; height: number }> = [];
  forEachElement(tree, (element) => {
    const index = element.staticBlobSourceNodeIndex;
    if (index == null) return;
    delete element.staticBlobSourceNodeIndex;
    const source = element.imageSrc;
    const intrinsic = element.imageIntrinsic;
    if (source == null || !source.startsWith("blob:") || intrinsic == null) return;
    owners.push({ element, index, source, width: intrinsic.w, height: intrinsic.h });
  });
  if (owners.length === 0) return;

  const deadline = Date.now() + READ_TIMEOUT_MS;
  const reads =
    sourceNodeKey == null
      ? undefined
      : await withTimeout(
          withCdpSession(page, async (session) => {
            const group = privateCaptureKey("StaticBlobOwners");
            const output = new Map<number, string>();
            let remaining = MAX_TOTAL_BYTES;
            try {
              const {
                frameTree: { frame },
              } = await session.send("Page.getFrameTree");
              const { executionContextId } = await session.send("Page.createIsolatedWorld", {
                frameId: frame.id,
                worldName: "domotion-static-blob-images",
              });
              for (const [owner, { index, source, width, height }] of owners.slice(0, MAX_OWNERS).entries()) {
                if (remaining <= 0 || Date.now() >= deadline) break;
                try {
                  const { result } = await session.send("Runtime.evaluate", {
                    expression: `globalThis[${JSON.stringify(sourceNodeKey)}]?.[${index}]`,
                    objectGroup: group,
                    silent: true,
                  });
                  if (result.objectId == null) continue;
                  const { node } = await session.send("DOM.describeNode", { objectId: result.objectId });
                  const { object } = await session.send("DOM.resolveNode", {
                    backendNodeId: node.backendNodeId,
                    executionContextId,
                    objectGroup: group,
                  });
                  if (object.objectId == null) continue;
                  const timeout = deadline - Date.now();
                  if (timeout <= 0) break;
                  const maximum = Math.min(MAX_RESOURCE_BYTES, remaining);
                  const reply = await session.send("Runtime.callFunctionOn", {
                    objectId: object.objectId,
                    functionDeclaration: readSelectedBlob,
                    arguments: [
                      {
                        value: {
                          source,
                          width,
                          height,
                          remaining: maximum,
                          timeout,
                          formats: Object.keys(FORMAT_BY_MIME),
                        },
                      },
                    ],
                    awaitPromise: true,
                    returnByValue: true,
                    silent: true,
                  });
                  const read = reply.result.value as BlobRead | null | undefined;
                  if (reply.exceptionDetails != null || read == null || read.size <= 0 || read.size > maximum) continue;
                  remaining -= read.size;
                  const dataUri = await staticRasterDataUri(read);
                  if (dataUri != null) output.set(owner, dataUri);
                } catch {
                  // A detached, changed, or inaccessible source cannot authenticate.
                }
              }
              const current = (await session.send("Page.getFrameTree")).frameTree.frame;
              if (current.id === frame.id && current.loaderId === frame.loaderId) return output;
            } finally {
              await session.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
            }
          }).catch(() => undefined),
          READ_TIMEOUT_MS,
        );
  for (const [index, owner] of owners.entries()) {
    const dataUri = reads?.get(index);
    if (dataUri != null) {
      owner.element.imageSrc = dataUri;
    } else {
      warnings.push({
        selector: "img",
        feature: "static-blob-image",
        detail: "the selected blob could not be embedded as a verified static raster",
        status: "unavailable",
      });
    }
  }
}
