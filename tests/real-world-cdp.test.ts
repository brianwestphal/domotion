import { describe, expect, it, vi } from "vitest";
import { excludeSharedWorkerAutoAttach } from "./real-world-cdp.js";
import { brokerLaunchArguments, closeLaunchScout } from "./real-world-browser.js";

type Filter = Array<{ type?: string; exclude?: boolean }>;
const defaults: Filter = [{ type: "browser", exclude: true }, { type: "tab", exclude: true }, {}];
const allows = (filter: Filter, type: string): boolean => {
  const entry = filter.find((entry) => entry.type == null || entry.type === type);
  return entry != null && entry.exclude !== true;
};
describe("public CDP bootstrap broker policy (DM-34WC46)", () => {
  it.each([
    undefined,
    [],
    [{ type: "page", exclude: true }, { type: "worker" }, {}],
    [{ type: "shared_worker" }, { type: "iframe" }],
  ] as Array<Filter | undefined>)("preserves non-SharedWorker first-match filter semantics: %j", (filter) => {
    const original = {
      id: 7,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, ...(filter == null ? {} : { filter }) },
    };
    const result = JSON.parse(excludeSharedWorkerAutoAttach(JSON.stringify(original))) as typeof original & {
      params: { filter: Filter };
    };
    expect(result.id).toBe(7);
    expect(result.params.waitForDebuggerOnStart).toBe(true);
    expect(result.params.flatten).toBe(true);
    expect(allows(result.params.filter, "shared_worker")).toBe(false);
    for (const type of ["browser", "tab", "page", "worker", "service_worker", "other", "iframe", "future_target"])
      expect(allows(result.params.filter, type), type).toBe(allows(filter ?? defaults, type));
  });
  it.each([
    {
      id: 1,
      sessionId: "page-session",
      method: "Target.setAutoAttach",
      params: { autoAttach: true, waitForDebuggerOnStart: true },
    },
    { id: 2, method: "Target.setAutoAttach", params: { autoAttach: false } },
    { id: 3, method: "Target.autoAttachRelated", params: { targetId: "page" } },
    { id: 4, method: "Target.setAutoAttach", params: { autoAttach: true, filter: "invalid" } },
  ])("leaves child sessions, unrelated requests and invalid filters unchanged", (message) => {
    const wire = JSON.stringify(message);
    expect(excludeSharedWorkerAutoAttach(wire)).toBe(wire);
  });
  it("rejects malformed protocol JSON", () => {
    expect(() => excludeSharedWorkerAutoAttach("not JSON")).toThrow();
  });

  it("retains normal launch flags, executable arguments and paths exactly", () => {
    const original = [
      "--headless",
      "--font-render-hinting=none",
      "--user-data-dir=old profile",
      "--remote-debugging-pipe",
      "--custom=value with spaces",
      "--no-startup-window",
    ];
    const result = brokerLaunchArguments(original, "new profile");
    expect(original[2]).toBe("--user-data-dir=old profile");
    expect(result).toEqual([
      "--headless",
      "--font-render-hinting=none",
      "--user-data-dir=new profile",
      "--remote-debugging-pipe",
      "--custom=value with spaces",
      "--no-startup-window",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
    ]);
  });
  it.each(
    [
      [],
      ["--remote-debugging-pipe"],
      ["--user-data-dir=profile"],
      ["--remote-debugging-pipe", "--user-data-dir=profile", "--remote-debugging-port=9222"],
    ].map((args) => ({ args })),
  )("rejects unsupported launch provenance without guessing", ({ args }) => {
    expect(() => brokerLaunchArguments(args, "owned-profile")).toThrow("normal Playwright pipe/profile arguments");
  });
});

describe("closeLaunchScout (DM-5Q5MB2)", () => {
  const evidence = () => {
    const calls: string[] = [];
    return {
      calls,
      requested: () => void calls.push("requested"),
      expired: () => void calls.push("expired"),
      sample: async () => void calls.push("sample"),
      dispose: () => void calls.push("dispose"),
      fail: async (outcome: "resolved" | "rejected") => void calls.push(`fail:${outcome}`),
    };
  };

  it("disposes failure-only evidence when the scout closes in time", async () => {
    const record = evidence();
    const kill = vi.fn(async () => undefined);
    await expect(closeLaunchScout({ close: async () => undefined, kill }, record, 50)).resolves.toBe("closed");
    expect(record.calls).toEqual(["requested", "dispose"]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("kills a scout that misses the close bound, retains evidence and continues", async () => {
    const record = evidence();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const kill = vi.fn(async () => undefined);
    const slowClose = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    await expect(closeLaunchScout({ close: slowClose, kill }, record, 20)).resolves.toBe("killed-after-close-deadline");
    expect(record.calls).toEqual(["requested", "expired", "sample", "fail:resolved"]);
    expect(kill).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Chromium scout close timed out after 20ms"));
    warn.mockRestore();
  });

  it("throws the kill error when the slow scout cannot be killed", async () => {
    const record = evidence();
    const failure = new Error("controlled kill rejection");
    const slowClose = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    await expect(closeLaunchScout({ close: slowClose, kill: () => Promise.reject(failure) }, record, 20)).rejects.toBe(
      failure,
    );
    expect(record.calls).toEqual(["requested", "expired", "sample", "fail:rejected"]);
  });

  it("does not let an evidence write failure replace the outcome", async () => {
    const record = { ...evidence(), fail: () => Promise.reject(new Error("disk full")) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const slowClose = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    await expect(closeLaunchScout({ close: slowClose, kill: async () => undefined }, record, 20)).resolves.toBe(
      "killed-after-close-deadline",
    );
    warn.mockRestore();
  });
});
