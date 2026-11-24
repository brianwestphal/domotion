import type { CDPSession, Page } from "@playwright/test";
import { vi } from "vitest";
import { decodePlainCaptureValue, type PlainCaptureWire } from "../src/capture/plain-capture-value.js";
import { CAPTURE_SCRIPT } from "../src/capture/script.generated.js";

interface Attempt {
  transport: "shadow carrier" | "Playwright";
  preparation: boolean;
}

export function observeLiveTextCaptures(
  page: Page,
  {
    afterCapture,
    finalError,
    denyAuthority,
  }: {
    afterCapture?: (attempt: Attempt) => Promise<void>;
    finalError?: string;
    denyAuthority?: boolean;
  } = {},
) {
  const attempts: Attempt[] = [];
  const evaluate = page.evaluate.bind(page);
  const evaluation = vi.spyOn(page, "evaluate").mockImplementation(async (source, input) => {
    const tracked =
      typeof source === "string" && source.includes(CAPTURE_SCRIPT) && source.includes('"textPaintGeometryKey":');
    if (!tracked) return evaluate(source, input);
    const attempt: Attempt = { transport: "Playwright", preparation: source.includes('"textPaintProbe":true') };
    attempts.push(attempt);
    const result = await evaluate(source, input);
    await afterCapture?.(attempt);
    return result;
  });
  const context = page.context();
  const create = context.newCDPSession.bind(context);
  const restoreSessions: Array<() => void> = [];
  const connections = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
    const session = await create(target);
    const send = session.send.bind(session);
    const protocol = vi.spyOn(session, "send").mockImplementation((async (method: string, params?: object) => {
      const request = params as
        | {
            expression?: string;
            functionDeclaration?: string;
            arguments?: Array<{ value?: PlainCaptureWire }>;
          }
        | undefined;
      if (denyAuthority && method === "Runtime.evaluate" && request?.expression?.includes('"mode":"live-affine-boxes"'))
        throw new Error("test denies text participant authority");
      const wire = request?.arguments?.[0]?.value;
      if (
        method !== "Runtime.callFunctionOn" ||
        !request?.functionDeclaration?.includes(CAPTURE_SCRIPT) ||
        wire == null
      )
        return Reflect.apply(send, session, [method, params]);
      const { textPaintProbe } = decodePlainCaptureValue(wire) as { textPaintProbe?: boolean };
      const attempt: Attempt = { transport: "shadow carrier", preparation: textPaintProbe === true };
      attempts.push(attempt);
      if (!attempt.preparation && finalError != null) {
        return Reflect.apply(send, session, [
          method,
          {
            ...params,
            functionDeclaration: `function(){throw new Error(${JSON.stringify(finalError)});}`,
          },
        ]);
      }
      const result: unknown = await Reflect.apply(send, session, [method, params]);
      await afterCapture?.(attempt);
      return result;
    }) as CDPSession["send"]);
    restoreSessions.push(() => protocol.mockRestore());
    return session;
  });
  return {
    attempts,
    restore() {
      evaluation.mockRestore();
      connections.mockRestore();
      for (const restore of restoreSessions) restore();
    },
  };
}
