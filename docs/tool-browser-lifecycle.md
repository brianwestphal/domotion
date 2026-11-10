# Browser ownership in tools and harnesses

Standalone TypeScript browser tools use `withBrowser` from `tools/lib/browser.ts`. Plain-Node `.mjs` and `.mts` probes use the equivalent `tools/lib/browser.mjs` entry point, so they run without a TypeScript loader. Both owners pass Chromium to an async callback and close it when the callback resolves or throws. A tool that also starts a server keeps the server in an outer `try/finally`, so the browser closes before the server.

```ts
await withBrowser(async (browser) => {
  const page = await browser.newPage();
  // Collect, compare, and write the tool's existing report here.
});
```

The helper accepts Playwright launch options as its second argument, including a pinned `executablePath`. A collector can supply a custom `launch` function in its third argument. It can also set `closeTimeoutMs` when its previous teardown contract used a specific deadline. Long-running probes that recycle Chromium use `openOwnedBrowser` for each generation and close the previous owner before launching another. Keep collector-specific context, CDP session, and server cleanup in the callback or outer scope as appropriate.

Harnesses that return a live browser use `openOwnedBrowser`. Its returned `close()` method is idempotent. `tests/harness-browsers.ts` uses one owner when capture and raster flags match and two owners when they differ. If the second launch fails, it closes the first browser before rethrowing. When both launches succeed, harness cleanup closes raster first, then capture, even if raster cleanup throws.

The helper does not change browser flags, the configured executable, collector output, baseline formats, or when reports are written. Individual E2E tests retain their own fixture and hook lifecycle. Both entries use idempotent, deadline-bounded cleanup; a failed probe still closes its browser.

## Failure-only SharedWorker evidence

DM-XWB4FA adds retrospective diagnostics to the synthetic owned-browser worker fixture. Its readiness observation remains 8,000 ms. Only after that observation fails (or a worker error is observed), `tests/real-world-worker-startup-diagnostics.ts` creates a page-owned public CDP session. It authenticates the page's browser context and the exact loopback fixture URL, SharedWorker type and name before attaching a non-flat worker session. Only `/worker.js` and `/missing-worker.js` are admitted; this is not a recorder for arbitrary real-world workers.

The worker command is `Runtime.enable`, which replays stored exceptions. There is no worker evaluation, debugger enablement, auto-attach change or resume command. The body has a total 1,500 ms deadline; child and page cleanup each have a separate 250 ms bound. A late-created session is scheduled for detach, and a late attachment reply gets a best-effort child detach. Closing the owning page session also destroys its child sessions. Cleanup output distinguishes confirmed detach, unavailable cleanup and pending late cleanup rather than claiming every timed-out operation completed. If cleanup cannot be confirmed, the fixture's owned-browser teardown remains the final resource boundary.

This boundary follows installed Chromium revision `6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050`: [`SharedWorkerReportingProxy`](https://github.com/chromium/chromium/blob/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/workers/shared_worker_reporting_proxy.cc#L36) does not forward exceptions after top-level evaluation, [`SharedWorkerDevToolsAgentHost::GetTitle`](https://github.com/chromium/chromium/blob/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/content/browser/devtools/shared_worker_devtools_agent_host.cc#L65) exposes the worker name, and [`TargetHandler`](https://github.com/chromium/chromium/blob/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/content/browser/devtools/protocol/target_handler.cc#L752) owns and destroys child sessions. Stored replay is implemented by [V8 Runtime.enable at the authenticated dependency revision](https://github.com/v8/v8/blob/e92be92d2c1537d41acb9d82bacf3c1c19e93ff9/src/inspector/v8-runtime-agent-impl.cc#L1101). Missing or cleared storage remains inconclusive.

Each failure artifact uses schema version 2. It snapshots actual controlled-hook execution and the failing context's bootstrap counters before awaiting diagnostics. The added `workerDiagnostic` records the pre-inspection attached flag and the diagnostic attachment's own `waitingForDebugger` flag. Global debugger pause state remains explicitly unobserved; a manual attachment's flag cannot establish another client's pause state. The historical DM-J5HGKV cause remains unresolved.

Retention is intentionally narrow: at most eight exceptions, 32 KiB per incoming message and 64 KiB of aggregate exception messages. Exception names and source positions are allowlisted. Only known synthetic/native error details survive; other text becomes `[redacted]`. Object IDs, arbitrary URLs, stacks, argument values and protocol error messages are not retained. Diagnostic unavailability is data in the failure artifact and does not replace the original startup error. If the artifact cannot be written, the fixture emits a fixed warning and retains that original error. Existing filtered owned-process stderr remains separate.

`tests/real-world-worker-startup-diagnostics.test.ts` covers identity, redaction, byte limits, rejected/missing/late replies and cleanup failures. `tests/real-world-worker-startup-diagnostics.e2e.test.ts` exercises native healthy, silent `onconnect` and null-context errors, same-URL/name foreign-context liveness, real protocol failures, late-attachment cleanup, and preservation of another client's startup barrier. The existing bootstrap E2E suite also verifies installed-versus-executed hook facts and the unchanged worker/import SHA-256 digests. Native diagnostic observations are written under `DOMOTION_OUTPUT_DIR/worker-bootstrap/diagnostics/`, with source hashes and owned-process identity; these synthetic JSON files supplement the strict browser test report. The Linux and Windows manual worker-bootstrap profiles include the new native file, preserve their no-skip validation, and retain these observations through their existing artifact scope.

DM-EBZZ1P also retains failures before the protocol-fault loop. Every owned fixture context gets a bounded journal row, including the healthy foreign prerequisite. An ephemeral HttpOnly, SameSite-Strict cookie binds loopback requests to that context; only the binding lives in memory. Responses retain byte count, SHA-256, body-derived mode and server finish/close facts, never cookie/header values or script bodies. A constructor with no authenticated request remains explicitly unserved or unattributed. Changing the server's global mode later cannot rewrite these facts.

A failed readiness observation triggers bounded page-state and existing public Runtime replay collection, then a unique failure snapshot. The original exception is rethrown unchanged even when collection or persistence fails. Owned teardown is awaited and its confirmation retained. Summary schema version 2 contains at most 64 contexts, 64 responses total (four per context), 128 diagnostic observations and counters for dropped rows. Bodies above 4 KiB are not hashed or classified. The collector optionally retains sanitized context/page/worker IDs from its existing replies; target authentication and protocol commands are unchanged.

The controlled early-prerequisite regression deliberately serves the original null-context script after creating a context expecting healthy bytes, then restores the global mode before the unchanged 8,000 ms wait. Its actual response digest and native Runtime exception prove that synthetic case only. Historical healthy-prerequisite timeouts remain unattributed until their own response/runtime evidence is captured; a timeout alone does not prove a null WebGL context. Unit controls cover absent/ambiguous request identity, bounded retention, collection/storage failure and original-error/cleanup preservation.

## Owned UI server processes

`tests/kerf-client-uis.e2e.test.ts` uses `tests/owned-ui-server.ts` to launch the
actual Node service with `process.execPath --import tsx`. It does not launch an
`npx` wrapper. Review-harness tests request `--port 0`; the server prints the
port returned by `server.address()`. The ordinary human CLI still defaults to 4175. Tests never reserve a port and release it before the real server binds.
The helper returns an origin-only base URL, preserving existing `/api/...`
request joining.

A private E2E-only preload, `tests/owned-ui-server-bootstrap.mjs`, authenticates
its PID through the owned Node IPC channel. Readiness requires that handshake
and a complete bounded loopback-URL line; split chunks cannot publish a partial
port, and oversized lines are discarded through their terminating newline.
The 60-second startup limit is unchanged. Each stdout/stderr stream retains at
most 32 KiB of raw prefix/tail bytes, with total/retained byte counts and an
explicit truncation marker. Failure details include the actual PID, Node
version, command, output, exit code/signal and observed closed state; environment
values are not dumped.

Shutdown is sent over that same private IPC channel and invokes the CLI's
existing `SIGTERM` handler in JavaScript. This allows asynchronous cleanup on
Windows, where OS signal delivery terminates a child abruptly. Parent-channel
loss also requests shutdown and installs an eight-second self-exit bound in
case an application handler hangs after its owner disappears. A preload without
its owner exits before the service starts. Ordinary human CLI execution never
loads this preload.

Cleanup waits for the child's `close` event, which follows process termination
and stdio closure, rather than treating `kill()` or `exit` as completed cleanup.
A six-second grace period can escalate to `SIGKILL` on that exact owned PID,
followed by a two-second observed-close bound. Escalation or an unobserved close
or a nonzero/signal shutdown exit is an error, not clean success. Startup failures retain their original reason
and include any cleanup failure. The UI file's existing 20-second teardown
limit remains; owned servers close in parallel, and every existing UI assertion
and test/startup deadline is retained. No retry or global concurrency policy is
changed. These are owned-service guarantees, not a claim that arbitrary
untracked descendant trees have been authenticated.

`tests/owned-ui-server.test.ts` drives two simultaneous real review servers with
different fixtures, then proves their distinct responses and closed ports. An
occupied-port control retains its unrelated owner while the attempted child
records the actual bind error. Other controls cover split/oversized URL lines,
stream overflow, spawn error, early exit, timeout, forced/failing cleanup,
unexpected late exit and IPC loss with both completing and hanging handlers.
New process-test budgets include the existing startup
and cleanup bounds; they do not enlarge the UI's deadlines.

Bounded control evidence is retained in `owned-ui-server/observations.json`;
actual UI services retain `owned-ui-server/client-processes.json` after awaited
cleanup. `DOMOTION_OUTPUT_DIR` selects their parent directory. The macOS unit
and browser CI jobs upload this folder with `always()`. Missing artifacts never
establish successful cleanup; the process/test result remains authoritative.

The earlier isolated startup returning null was not causally attributed. These
changes address source-proven shared-port, port-reporting and ownership gaps.
Legacy `tests/review-server-e2e.test.ts` still uses fixed ports and detached
wrapper groups for fixtures with held `gh` descendants; its separate
cross-platform port/process-tree audit (DM-W4BR21) must preserve those children
until their release and cleanup are proved.

Node 22's official documentation specifies both
[process/stdio closure ordering](https://github.com/nodejs/node/blob/v22.21.0/doc/api/child_process.md#event-close)
and [Windows signal behavior](https://github.com/nodejs/node/blob/v22.21.0/doc/api/child_process.md#subprocesskillsignal).

### Native clipboard copy assertions (DM-2Z7626)

The review-client guard compares the complete copied issue text with the
textarea value, accounting only for Chromium's native clipboard line endings.
At Chromium147 revision6b5a1b80,
[`SystemClipboard::WritePlainText`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/core/clipboard/system_clipboard.cc)
calls `NormalizeLineEndingsToCRLF` on Windows; the
[`line-ending implementation`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/third_party/blink/renderer/platform/wtf/text/line_ending.cc)
preserves existing CRLF and converts lone CR/LF to CRLF, leaving other characters
alone. Windows
[`ClipboardWin::ReadTextInternal`](https://chromium.googlesource.com/chromium/src/+/6b5a1b80ccc1e8a4967901d8e58fc2e162cdf050/ui/base/clipboard/clipboard_win.cc)
returns native `CF_UNICODETEXT` without converting those endings back to LF.

`tests/native-clipboard-text.ts` expresses this expected transport convention;
macOS/Linux expectations retain the original string. The native assertion still
requires exact whole-text equality, including Unicode, spaces, blank lines and
the final line ending. It does not trim the readback, alter product copy logic,
replace the browser clipboard or weaken readonly/selection checks. The f283
Windows9/2 native profile failed this clipboard expectation after the editor
checks passed; its other Select-placement failure is tracked independently in
DM-QV1MYS. Its13 process controls and all five owned-service cleanup records
passed. Neither UI assertion identifies the earlier startup-null cause.

### Scrolled Select geometry qualification (DM-QV1MYS)

The Windows f283 native UI report records `data-placement=top` where the strict
test expected bottom, but did not retain the failed trigger/popup geometry.
The beta129 Select calls its package `positionPopup` with a bottom preference.
The installed shared popup implementation uses fixed positioning, a
`documentElement.clientWidth/clientHeight` viewport boundary, adaptive
`flip(bestFit)`, shift and size middleware, then asynchronously writes its
position and placement attribute. These source branches do not establish why
that Windows observation differed; no font, scroll or timing cause is assigned.

The existing popup geometry query now retains trigger bounds, actual root and
visual viewport, scroll position, raw space above/below, used popup limits and
declared font strings before the unchanged comparisons. It also records selected
and focused option indices/counts and the selected row's used rectangle, inspecting
at most64 options without retaining labels or option values. Declared fonts are not
painted-face identity; raw space omits the package's padding. The artifact does
not simulate a winning placement or relax the original bottom/height assertions.

Unique `owned-ui-server/select-viewport/<uuid>/geometry.json` files hold at most
two observations/16KiB, with full commit when supplied, normalized source/project/
lockfile hashes and runtime identity. A failed case alone may retain a later
PNG (maximum4MiB,2000ms diagnostic deadline), explicitly separate from the
earlier geometry read. I/O failure cannot replace the original error. Healthy
cases take no extra screenshot, page query or frame wait. The native test count,
launch, viewport/scroll inputs, assertion thresholds and120-second limit stay
unchanged. Actual failed Windows geometry remains necessary before proposing a
placement repair; local healthy geometry cannot explain a historical failure.
