/**
 * The iteration order of Blink's `FontFaceCache::CapabilitiesSet`, the
 * `HeapHashMap<FontSelectionCapabilities, Member<CSSSegmentedFontFace>>` that
 * holds one entry per distinct capability key of a CSS font family
 * (`core/css/font_face_cache.h:81-102`, Chromium 7d859f27).
 *
 * `FontSelectionQueryResult::GetOrCreate` (`core/css/font_face_cache.cc:
 * 227-258`) walks that map from its first bucket and replaces the current
 * winner only when `IsBetterMatchForRequest` is strictly true. When two keys
 * tie on stretch, style and weight distance, the one in the earlier bucket
 * wins. Neither source order nor reverse source order decides the tie.
 *
 * The bucket a key lands in is a pure function of the key hashes and the order
 * in which the keys were first inserted. Every input is transcribed below with
 * its citation. The hash reads its bytes little-endian with no per-process
 * seed (`PlainHashReader`, `third_party/rapidhash/rapidhash.h:93-137`), so the
 * order is the same on every platform.
 */

const M64 = (1n << 64n) - 1n;

/** `RAPID_SEED` (`third_party/rapidhash/rapidhash.h:148`, Chromium 7d859f27). */
const RAPID_SEED = 0xbdd89aa982704029n;

/** `rapid_secret` (`third_party/rapidhash/rapidhash.h:180-181`). */
const RAPID_SECRET = [0x2d358dccaa6c78a5n, 0x8bb84b93962eacc9n, 0x4b33a62ed433d4a3n] as const;

/** `rapid_mul128` (`rapidhash.h:191-217`): the full 128-bit product as
 *  `[low, high]`. */
function rapidMul128(a: bigint, b: bigint): [bigint, bigint] {
  const r = a * b;
  return [r & M64, (r >> 64n) & M64];
}

/** `rapid_mix` (`rapidhash.h:228-231`). */
function rapidMix(a: bigint, b: bigint): bigint {
  const [lo, hi] = rapidMul128(a, b);
  return lo ^ hi;
}

function read32(bytes: Uint8Array, offset: number): bigint {
  return BigInt(
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0,
  );
}

/**
 * `rapidhash(key, len)` with the default seed and `PlainHashReader`
 * (`rapidhash.h:254-338`), for inputs of at most 16 bytes, which is every key
 * this module hashes. The `len > 16` block loop is not transcribed, and such
 * an input throws rather than returning a guess.
 */
export function rapidhash(bytes: Uint8Array): bigint {
  const len = bytes.length;
  if (len > 16) throw new Error("rapidhash: inputs over 16 bytes are not transcribed");
  const length = BigInt(len);
  const seed = (RAPID_SEED ^ rapidMix(RAPID_SEED ^ RAPID_SECRET[0], RAPID_SECRET[1]) ^ length) & M64;
  let a: bigint;
  let b: bigint;
  if (len >= 4) {
    // Lines 269-274: the first and last four bytes, then the pair `delta`
    // bytes in from each end.
    const last = len - 4;
    a = (read32(bytes, 0) << 32n) | read32(bytes, last);
    const delta = (len & 24) >> (len >> 3);
    b = (read32(bytes, delta) << 32n) | read32(bytes, last - delta);
  } else if (len > 0) {
    // `ReadSmall` (lines 134-136).
    a = (BigInt(bytes[0]) << 56n) | (BigInt(bytes[len >> 1]) << 32n) | BigInt(bytes[len - 1]);
    b = 0n;
  } else {
    a = 0n;
    b = 0n;
  }
  a ^= RAPID_SECRET[1];
  b ^= seed;
  [a, b] = rapidMul128(a, b);
  return rapidMix(a ^ RAPID_SECRET[0] ^ length, b ^ RAPID_SECRET[1]);
}

/** One selection range in float units, as `[minimum, maximum]`. */
export type SelectionRange = readonly [number, number];

/** A `FontSelectionCapabilities` key: width, slope and weight ranges. */
export interface SelectionCapabilitiesKey {
  readonly width: SelectionRange;
  readonly slope: SelectionRange;
  readonly weight: SelectionRange;
}

/** `FontSelectionValue::RawValue()`: `ClampTo<int16_t>(x * 4)`, truncating
 *  toward zero (`platform/fonts/font_selection_types.h:52-61, 101`). */
function rawValue(x: number): number {
  return Math.max(-32768, Math.min(32767, Math.trunc(x * 4)));
}

/** `FontSelectionRange::UniqueValue()` (`font_selection_types.h:287-289`):
 *  `minimum.RawValue() << 16 | maximum.RawValue()`. Both `int16_t` operands
 *  promote to `int`, so a negative maximum sign-extends over the minimum. */
function uniqueValue([minimum, maximum]: SelectionRange): number {
  return ((rawValue(minimum) << 16) | rawValue(maximum)) >>> 0;
}

/**
 * `FontSelectionCapabilitiesHashTraits::GetHash`
 * (`platform/fonts/font_selection_types.cc:49-55`): `StringHasher::HashMemory`
 * (`wtf/text/string_hasher.h:89-93`, `rapidhash` over the bytes) of the
 * `uint32_t` array `{width, slope, weight UniqueValue, is_deleted}`, truncated
 * to `unsigned`. A live key's `is_deleted` is 0.
 */
export function fontSelectionCapabilitiesHash(key: SelectionCapabilitiesKey): number {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, uniqueValue(key.width), true);
  view.setUint32(4, uniqueValue(key.slope), true);
  view.setUint32(8, uniqueValue(key.weight), true);
  view.setUint32(12, 0, true);
  return Number(rapidhash(bytes) & 0xffffffffn);
}

/** `HashTraits::kMinimumTableSize` (`wtf/hash_traits.h:180`; the 1-slot
 *  variant at line 178 is for sanitizer builds only). */
const MINIMUM_TABLE_SIZE = 8;

/** `HashTable::kMaxLoad` (`wtf/hash_table.h:873`). */
const MAX_LOAD = 2;

/**
 * Bucket iteration order of a WTF `HashTable` after inserting `keys` in the
 * given order into an empty table, with no removals. Duplicate keys (by
 * `identity`) keep their first insertion, as `insert` returns the existing
 * entry (`wtf/hash_table.h:1236-1251`).
 *
 * Transcribed from `HashTable::insert` (`hash_table.h:1205-1290`): the first
 * insert allocates `kMinimumTableSize` buckets; a key starts at
 * `hash & mask` and probes triangularly, `i = (i + ++probe_count) & mask`;
 * after an insert, `ShouldExpand` (`(key_count + deleted_count) * kMaxLoad >=
 * table_size`, lines 819-821) doubles the table. Without removals
 * `MustRehashInPlace` (lines 822-824) never holds at that point. `RehashTo`
 * (lines 1685-1748) re-inserts the old buckets in index order with the same
 * probe (`Reinsert`, lines 1349-1386). The garbage-collected
 * `ExpandBuffer` path (lines 1636-1677) first copies each entry to the same
 * index of a temporary table, so it rehashes in that same order. Iteration
 * walks buckets from index 0 (`begin()`, line 675).
 */
export function hashTableIterationOrder<K>(
  keys: readonly K[],
  hash: (key: K) => number,
  identity: (key: K) => string,
): K[] {
  let table: Array<K | undefined> = [];
  let count = 0;
  const place = (target: Array<K | undefined>, key: K): boolean => {
    const mask = target.length - 1;
    let i = hash(key) & mask;
    let probe = 0;
    const id = identity(key);
    for (;;) {
      const entry = target[i];
      if (entry === undefined) {
        target[i] = key;
        return true;
      }
      if (identity(entry) === id) return false;
      probe++;
      i = (i + probe) & mask;
    }
  };
  for (const key of keys) {
    if (table.length === 0) table = new Array<K | undefined>(MINIMUM_TABLE_SIZE).fill(undefined);
    if (!place(table, key)) continue;
    count++;
    if (count * MAX_LOAD >= table.length) {
      const old = table;
      table = new Array<K | undefined>(old.length * 2).fill(undefined);
      for (const entry of old) if (entry !== undefined) place(table, entry);
    }
  }
  return table.filter((entry): entry is K => entry !== undefined);
}
