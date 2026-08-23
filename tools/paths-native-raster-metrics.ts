import sharp from "sharp";

import type { PathsRasterRow } from "./paths-native-raster-gate.js";

export interface DecodedRaster {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

export async function decodePathsRasterPng(bytes: Buffer): Promise<DecodedRaster> {
  const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: decoded.data, width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels };
}

interface Point { x: number; y: number }

function inkMask(image: DecodedRaster): Uint8Array {
  const mask = new Uint8Array(image.width * image.height);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * image.channels;
    // Collector pages are opaque black-on-white. Keep low-coverage antialias
    // fringe out of the edge set while retaining every substantive mask pixel.
    mask[pixel] = Math.min(image.data[offset], image.data[offset + 1], image.data[offset + 2]) < 250 ? 1 : 0;
  }
  return mask;
}

function edges(mask: Uint8Array, width: number, height: number): Point[] {
  const result: Point[] = [];
  const at = (x: number, y: number): number => x < 0 || y < 0 || x >= width || y >= height ? 0 : mask[y * width + x];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y) === 1 && (at(x - 1, y) === 0 || at(x + 1, y) === 0 || at(x, y - 1) === 0 || at(x, y + 1) === 0)) result.push({ x, y });
    }
  }
  return result;
}

function inkGeometry(mask: Uint8Array, width: number, height: number): { area: number; x: number; y: number; width: number; height: number } {
  let area = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let pixel = 0; pixel < mask.length; pixel++) {
    if (mask[pixel] === 0) continue;
    area++;
    const x = pixel % width, y = Math.floor(pixel / width);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return {
    area,
    x: area === 0 ? 0 : minX,
    y: area === 0 ? 0 : minY,
    width: area === 0 ? 0 : maxX - minX + 1,
    height: area === 0 ? 0 : maxY - minY + 1,
  };
}

function directedMaxDistance(from: readonly Point[], to: readonly Point[]): number {
  let maxSquared = 0;
  for (const source of from) {
    let minSquared = Number.POSITIVE_INFINITY;
    for (const target of to) {
      const dx = source.x - target.x, dy = source.y - target.y;
      minSquared = Math.min(minSquared, dx * dx + dy * dy);
      if (minSquared === 0) break;
    }
    maxSquared = Math.max(maxSquared, minSquared);
  }
  return Math.sqrt(maxSquared);
}

/**
 * Exact device-pixel residuals. This intentionally has no image-percentage
 * score: each dimension is ratified independently for one complete fingerprint
 * and one declared matrix cell.
 */
export function measureDecodedPathsRasterResidual(
  native: DecodedRaster,
  paths: DecodedRaster,
): PathsRasterRow["residual"] {
  if (native.width !== paths.width || native.height !== paths.height || native.channels !== paths.channels) {
    throw new Error(`raster dimensions differ: native ${native.width}x${native.height}x${native.channels}, paths ${paths.width}x${paths.height}x${paths.channels}`);
  }
  let changedPixels = 0, totalChannelDelta = 0;
  for (let pixel = 0; pixel < native.width * native.height; pixel++) {
    const offset = pixel * native.channels;
    let delta = 0;
    for (let channel = 0; channel < native.channels; channel++) delta += Math.abs(native.data[offset + channel] - paths.data[offset + channel]);
    if (delta === 0) continue;
    changedPixels++;
    totalChannelDelta += delta;
  }
  const nativeMask = inkMask(native), pathsMask = inkMask(paths);
  const nativeGeometry = inkGeometry(nativeMask, native.width, native.height);
  const pathsGeometry = inkGeometry(pathsMask, paths.width, paths.height);
  const nativeEdges = edges(nativeMask, native.width, native.height);
  const pathsEdges = edges(pathsMask, paths.width, paths.height);
  if (nativeEdges.length === 0 || pathsEdges.length === 0) throw new Error("native or paths raster contains no substantive ink edge");
  const maxEdgeDistance = Math.max(directedMaxDistance(nativeEdges, pathsEdges), directedMaxDistance(pathsEdges, nativeEdges));
  return {
    changedPixels,
    area: Math.abs(nativeGeometry.area - pathsGeometry.area),
    width: Math.abs(nativeGeometry.width - pathsGeometry.width),
    height: Math.abs(nativeGeometry.height - pathsGeometry.height),
    maxEdgeDistance,
    // Retain the historical normalized severity for reviewed envelopes, but
    // also persist the exact integer numerator so producer recomputation never
    // depends on floating-point summation order.
    severity: totalChannelDelta / (255 * native.channels),
    totalChannelDelta,
    nativeInk: nativeGeometry,
    pathsInk: pathsGeometry,
  };
}

export async function measurePathsRasterResidual(native: Buffer, paths: Buffer): Promise<PathsRasterRow["residual"]> {
  const [nativeDecoded, pathsDecoded] = await Promise.all([decodePathsRasterPng(native), decodePathsRasterPng(paths)]);
  return measureDecodedPathsRasterResidual(nativeDecoded, pathsDecoded);
}
