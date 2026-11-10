import type { Page } from "@playwright/test";
import { expect, it, vi } from "vitest";
import {
  boundedSpinDeclarations,
  numberSpinNodeIds,
  observeExistingSpinRules,
} from "./native-decoration-rule-probe.js";

const documentReply = {
  root: {
    nodeId: 1,
    children: [
      {
        nodeId: 10,
        nodeName: "INPUT",
        attributes: ["id", "number", "type", "number"],
        shadowRoots: [
          {
            nodeId: 11,
            shadowRootType: "user-agent",
            children: [{ nodeId: 12, attributes: ["pseudo", "-webkit-inner-spin-button"] }],
          },
        ],
      },
      {
        nodeId: 20,
        nodeName: "INPUT",
        attributes: ["id", "other", "type", "number"],
        shadowRoots: [
          {
            nodeId: 21,
            shadowRootType: "user-agent",
            children: [{ nodeId: 22, attributes: ["pseudo", "-webkit-inner-spin-button"] }],
          },
        ],
      },
      {
        nodeId: 30,
        nodeName: "INPUT",
        attributes: ["id", "number", "type", "number"],
        shadowRoots: [
          {
            nodeId: 31,
            shadowRootType: "open",
            children: [{ nodeId: 32, attributes: ["pseudo", "-webkit-inner-spin-button"] }],
          },
        ],
      },
    ],
  },
};
const rulesReply = {
  matchedCSSRules: [
    {
      matchingSelectors: [0],
      rule: {
        origin: "user-agent",
        selectorList: { text: "input:hover::-webkit-inner-spin-button" },
        style: {
          cssProperties: [
            { name: "opacity", value: "1" },
            { name: "background-image", value: "url(PRIVATE)" },
          ],
        },
      },
    },
  ],
};

it("correlates only the actual number UA shadow part and keeps non-winning bounded declarations", () => {
  expect([...numberSpinNodeIds(documentReply)]).toEqual([[12, 10]]);
  const result = boundedSpinDeclarations(rulesReply);
  expect(result).toEqual([
    {
      origin: "user-agent",
      selector: "input:hover::-webkit-inner-spin-button",
      matchingSelectorIndices: [0],
      properties: [{ name: "opacity", value: "1", important: false, disabled: false, parsedOk: true }],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
  expect(
    boundedSpinDeclarations({
      matchedCSSRules: [{ rule: { origin: "regular", selectorList: { text: "input::-webkit-inner-spin-button" } } }],
    }),
  ).toEqual([]);
  expect(boundedSpinDeclarations(null)).toEqual([]);
  expect(boundedSpinDeclarations({ matchedCSSRules: Array(30).fill(rulesReply.matchedCSSRules[0]) })).toHaveLength(8);
});

it("copies existing replies without sending another command, preserves arguments/results, and restores wrappers", async () => {
  const send = vi.fn().mockResolvedValueOnce(documentReply).mockResolvedValue(rulesReply);
  const session = { send };
  const create = vi.fn().mockResolvedValue(session);
  const context = { newCDPSession: create };
  const page = { context: () => context } as unknown as Page;
  const probe = observeExistingSpinRules(page);
  const live = await page.context().newCDPSession(page);
  try {
    expect(await live.send("DOM.getDocument", { depth: -1, pierce: true })).toBe(documentReply);
    const wrong = { nodeId: 22 };
    expect(await live.send("CSS.getMatchedStylesForNode", wrong)).toBe(rulesReply);
    expect(send.mock.calls[1][1]).toBe(wrong);
    await live.send("CSS.getMatchedStylesForNode", { nodeId: 12 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(probe.snapshot()).toMatchObject({
      truncated: false,
      records: [
        {
          hostNodeId: 10,
          partNodeId: 12,
          sessionOrdinal: 1,
          requestOrdinal: 3,
          declarations: boundedSpinDeclarations(rulesReply),
        },
      ],
    });
  } finally {
    probe.dispose();
  }
  expect(page.context().newCDPSession).toBe(create);
  expect(session.send).toBe(send);
});

it("preserves original errors, ignores other pages, and caps retained reply rows", async () => {
  const error = Error("original protocol refusal");
  const send = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(documentReply).mockResolvedValue(rulesReply);
  const session = { send };
  const create = vi.fn().mockResolvedValue(session);
  const context = { newCDPSession: create };
  const page = { context: () => context } as unknown as Page;
  const probe = observeExistingSpinRules(page);
  try {
    await context.newCDPSession({} as Page);
    expect(session.send).toBe(send);
    const live = await page.context().newCDPSession(page);
    await expect(live.send("DOM.getDocument")).rejects.toBe(error);
    await live.send("DOM.getDocument");
    for (let i = 0; i < 12; i++) await live.send("CSS.getMatchedStylesForNode", { nodeId: 12 });
    expect(send).toHaveBeenCalledTimes(14);
    expect(probe.snapshot().records).toHaveLength(8);
    expect(probe.snapshot().truncated).toBe(true);
    expect(probe.snapshot().bytes).toBeLessThanOrEqual(16 * 1024);
  } finally {
    probe.dispose();
  }
});
