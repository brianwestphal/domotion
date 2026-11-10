---
id: "requirements/playwright-zip-reader-investigation"
title: "Playwright compressed ZIP reader lifecycle investigation"
kind: "investigation"
status: "current"
owners: ["rendering"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-Z9VSDJ", "DM-9K75QG", "DM-VFZCB4"]
code: ["package.json", "package-lock.json"]
aliases: ["docs/275-playwright-zip-reader-investigation.md", "doc-275"]
---

# Playwright compressed ZIP reader lifecycle investigation

**Investigation only.** The observed Playwright ZIP body-read stall comes from
an upstream reader's premature stream destruction interacting with Node's
backpressure handling. This finding changes neither the
[HAR input contract](48-har-source.md) nor the JSON-format workaround in
DM-9K75QG. No dependency upgrade or runtime patch ships here.

## Source and observed mechanism

The investigated lockfile installs Playwright **1.59.1**, whose
[ZIP bundle declares yauzl 3.2.1](https://github.com/microsoft/playwright/blob/v1.59.1/packages/playwright-core/bundles/zip/package.json).
Its vendored
[fd-slicer reader](https://github.com/thejoshwolfe/yauzl/blob/3.2.1/fd-slicer.js#L94-L124)
sets the public `destroyed` property at normal EOF, before calling `push(null)`.
That property also controls Node's internal destroyed state.

On macOS 27.2 arm64, Node **26.13.0** stalls while Node **22.15.0** completes the
same installed reader and synthetic archive. Both have a 65,536-byte default
stream high-water mark. Their relevant difference is
[`Readable.resume()`](https://github.com/nodejs/node/blob/v26.13.0/lib/internal/streams/readable.js):
the inspected Node 26 implementation returns immediately for a destroyed
stream; the inspected Node 22.15 implementation does not have that guard.
The installed built-in source and official Node 26 source agree on this branch.

A passive stream-event trace of a 65,536-byte incompressible deflated entry
records the complete causal sequence:

1. The file reader supplies 65,536 compressed bytes, then pauses for inflate
   backpressure.
2. It buffers the remaining 20 compressed bytes and reaches normal EOF, setting
   `destroyed=true` with those bytes still unread.
3. Inflate produces 65,516 bytes and emits `drain`.
4. Node 26's resume guard leaves the source paused: buffer length 20,
   `ended=true`, `endEmitted=false`. Neither the remaining bytes nor the final
   `end` reaches the inflater. Node 22 resumes and finishes.

This reproduces through bundled yauzl without Playwright's `ZipFile` wrapper.
The minimal reproducer below also needs no ZIP, filesystem or decompressor.
The evidence attributes a reader/stream lifecycle incompatibility, rather than
a decompression-engine failure. Local process evidence is macOS-only; it does
not establish an exclusive platform condition or a complete Node-version range.

## Bounded causal matrix

All archives contain deterministic synthetic data, with no HAR contents.
The incompressible archive has entries of 16,384, 65,536, 131,072 and 524,288
uncompressed bytes. Child processes have an outer four-second limit; each
entry has a 1.5-second deadline.

| Reader / runtime                                                   | Input                               | Result                                 |
| ------------------------------------------------------------------ | ----------------------------------- | -------------------------------------- |
| Installed file reader / Node 26.13.0                               | Incompressible deflate              | First entry succeeds; second times out |
| Same reader / Node 22.15.0                                         | Same archive                        | All 737,280 bytes, 6 ms                |
| Scratch copy with private EOF flag / Node 26.13.0                  | Same archive                        | All bytes, 5 ms                        |
| Installed yauzl `fromBuffer` / Node 26.13.0                        | Same archive                        | All bytes, 5 ms                        |
| Installed file reader / Node 26.13.0                               | Stored, 500,000 bytes               | Completes, 2 ms                        |
| Installed file reader / Node 26.13.0                               | Compressible deflate, 500,000 bytes | Completes, 3 ms                        |
| Exact merged Playwright reader delegated in scratch / Node 26.13.0 | Same incompressible archive         | All bytes, 6 ms                        |

Successful incompressible runs have identical per-entry SHA-256 digests and
lengths. Timings describe these bounded runs, not performance guarantees. The
scratch private-flag change is a causal intervention, not a production patch
or proof of complete cancellation/close/error correctness. Neither installed
packages nor global stream settings were modified.

## Portable minimal reproducer

Save this as `lifecycle-repro.cjs`. Run `node lifecycle-repro.cjs legacy` and
`node lifecycle-repro.cjs correct` with each runtime. The legacy case writes
65,536 bytes and times out on the tested Node 26; the correct case and both
Node 22 cases finish with 65,556 bytes. The 500 ms deadline terminates the test
instead of leaving an unsettled read running.

```js
const { Readable, Writable } = require("node:stream");
let sequence = 0;
let bytes = 0;
let finished = false;
const source = new Readable({
  highWaterMark: 65536,
  read() {
    if (sequence++ === 0) this.push(Buffer.alloc(65536));
    else if (sequence === 2) this.push(Buffer.alloc(20));
    else {
      if (process.argv[2] === "legacy") this.destroyed = true;
      this.push(null);
    }
  },
});
const target = new Writable({
  highWaterMark: 65536,
  write(chunk, encoding, done) {
    bytes += chunk.length;
    setImmediate(done);
  },
});
const timer = setTimeout(() => report("timeout"), 500);
function report(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log({ node: process.version, result, bytes });
  source.destroy();
  target.destroy();
  if (result !== "finish") process.exitCode = 1;
}
target.on("finish", () => report("finish"));
source.pipe(target);
```

## Upstream resolution and adoption boundary

[Playwright PR 40747](https://github.com/microsoft/playwright/pull/40747), merged
May 9, 2026, vendors a lifecycle-corrected reader at commit
`c17e0b45c12f12d164f08b6927faed08d5ff1d42`.
The later [yauzl PR 170](https://github.com/thejoshwolfe/yauzl/pull/170), merged
May 21, modernizes the vendored reader's destruction lifecycle. A duplicate
upstream report is unnecessary. Existing upstream reports describe related
stream cases; this investigation independently demonstrates the specific
compressed-entry backpressure path above.

DM-VFZCB4 tracks review of adopting the upstream fix through a supported
Playwright dependency change. Validate the actual bundled source and bounded
regressions on supported runtime/platform combinations before adoption;
version labels alone do not establish that the fix is present. No particular
replacement Playwright release is certified here. Updating the dependency
does not itself establish direct ZIP HAR support in Domotion.

The sanitized reproduction, stream traces, generator, causal-matrix digests and
runtime provenance are attached to DM-Z9VSDJ. No credential-bearing archives,
upstream messages, global Node changes or application HAR pipeline changes
were needed for attribution.
