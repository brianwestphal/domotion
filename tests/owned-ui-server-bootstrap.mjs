// Private to the owned E2E launcher; ordinary human CLI invocation never loads it.
if (!process.connected || process.send == null) process.exit(1);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  // Emit the existing handler in JS: Windows OS signals terminate Node before
  // async CLI cleanup can run. The IPC pipe belongs to this exact parent.
  if (process.listenerCount("SIGTERM") > 0) process.emit("SIGTERM");
  else process.exit(0);
}
process.on("message", (message) => {
  if (message == null || typeof message !== "object" || message.type !== "domotion-owned-ui-stop-v1") return;
  process.send?.({ type: "domotion-owned-ui-stopping-v1", pid: process.pid }, shutdown);
});
process.once("disconnect", () => {
  // Once the owner is gone it cannot enforce its own 6s + 2s cleanup bound.
  // Keep the same total bound even if an application handler never completes.
  setTimeout(() => process.exit(1), 8000).unref();
  shutdown();
});
process.send({ type: "domotion-owned-ui-ready-v1", pid: process.pid, node: process.version }, (error) => {
  if (error != null) shutdown();
});
