import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerCommandTransport } from "./real-world-webgl-worker-lifecycle.js";

afterEach(() => vi.useRealTimers());
function transport(timeout = 1000) {
  const send = vi.fn<ConstructorParameters<typeof WorkerCommandTransport>[0]["send"]>().mockResolvedValue({});
  const wire = new WorkerCommandTransport({ send }, timeout);
  const id = (index = 0): number => JSON.parse((send.mock.calls[index][1] as { message: string }).message).id;
  return { wire, send, id };
}
describe("worker command routing and bounded waits (DM-S9S3WG)", () => {
  it("routes replies by both target session and request id", async () => {
    const { wire, id } = transport();
    const a = wire.command("a", "Runtime.evaluate"),
      b = wire.command("b", "Runtime.evaluate");
    wire.receive({ sessionId: "wrong", message: JSON.stringify({ id: id(), result: { ignored: true } }) });
    wire.receive({ sessionId: "b", message: JSON.stringify({ id: id(1), result: { value: "b" } }) });
    wire.receive({ sessionId: "a", message: JSON.stringify({ id: id(), result: { value: "a" } }) });
    expect(await a).toEqual({ value: "a" });
    expect(await b).toEqual({ value: "b" });
  });
  it("ignores malformed events and rejects nested protocol errors", async () => {
    const { wire, id } = transport();
    const command = wire.command("a", "Runtime.evaluate");
    wire.receive({ sessionId: "a", message: "bad json" });
    wire.receive({ sessionId: "a", message: "null" });
    wire.receive({ sessionId: "a", message: JSON.stringify({ method: "Runtime.consoleAPICalled" }) });
    const failed = expect(command).rejects.toThrow("controlled failure");
    wire.receive({ sessionId: "a", message: JSON.stringify({ id: id(), error: { message: "controlled failure" } }) });
    await failed;
  });
  it("cancels a detached target while retaining other pending sessions", async () => {
    const { wire, id } = transport();
    const a = wire.command("a", "Runtime.evaluate"),
      b = wire.command("b", "Runtime.evaluate");
    const failed = expect(a).rejects.toThrow("session closed");
    wire.cancel("a");
    await failed;
    wire.receive({ sessionId: "b", message: JSON.stringify({ id: id(1), result: { ok: true } }) });
    expect(await b).toEqual({ ok: true });
  });
  it("times out missing replies, ignores late replies and clears timers on send failure", async () => {
    vi.useFakeTimers();
    const { wire, send, id } = transport(10);
    const command = wire.command("a", "Runtime.evaluate");
    const failed = expect(command).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10);
    await failed;
    wire.receive({ sessionId: "a", message: JSON.stringify({ id: id(), result: { late: true } }) });
    send.mockRejectedValueOnce(new Error("closed transport"));
    await expect(wire.command("b", "Runtime.runIfWaitingForDebugger")).rejects.toThrow("closed transport");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clears every pending request on transport shutdown", async () => {
    vi.useFakeTimers();
    const { wire } = transport();
    const pending = [wire.command("a", "Runtime.evaluate"), wire.command("b", "Runtime.runIfWaitingForDebugger")];
    const failed = Promise.all(pending.map((command) => expect(command).rejects.toThrow("session closed")));
    wire.cancel();
    await failed;
    expect(vi.getTimerCount()).toBe(0);
  });
});
