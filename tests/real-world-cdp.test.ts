import { describe, expect, it } from "vitest";
import { excludeSharedWorkerAutoAttach } from "./real-world-cdp.js";
import { brokerLaunchArguments } from "./real-world-browser.js";

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
