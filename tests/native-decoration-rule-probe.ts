import type { CDPSession, Page } from "@playwright/test";

type ObjectRow = Record<string, unknown>;
const object = (value: unknown): ObjectRow | null =>
  value != null && typeof value === "object" ? (value as ObjectRow) : null;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Correlation uses only the existing pierced document reply, never a new query. */
export function numberSpinNodeIds(reply: unknown): Map<number, number> {
  const result = new Map<number, number>();
  let visited = 0;
  const visit = (value: unknown, host: number | null, owned: boolean) => {
    const node = object(value);
    if (node == null || ++visited > 256) return;
    const attrs = array(node.attributes).slice(0, 128);
    const attribute = (name: string) => {
      for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i] === name) return attrs[i + 1];
      return undefined;
    };
    if (
      node.nodeName === "INPUT" &&
      attribute("id") === "number" &&
      attribute("type") === "number" &&
      Number.isSafeInteger(node.nodeId)
    )
      host = node.nodeId as number;
    const pseudo = attribute("pseudo") ?? attribute("-webkit-pseudo");
    if (owned && host != null && pseudo === "-webkit-inner-spin-button" && Number.isSafeInteger(node.nodeId))
      result.set(node.nodeId as number, host);
    for (const child of array(node.children)) visit(child, host, owned);
    for (const shadow of array(node.shadowRoots))
      visit(shadow, host, object(shadow)?.shadowRootType === "user-agent" && host != null);
  };
  visit(object(reply)?.root, null, false);
  return result;
}

/** Raw matched declarations: neither computed values nor a winning cascade. */
export function boundedSpinDeclarations(reply: unknown) {
  return array(object(reply)?.matchedCSSRules)
    .slice(0, 64)
    .flatMap((entry) => {
      const match = object(entry),
        rule = object(match?.rule),
        selector = object(rule?.selectorList)?.text;
      if (
        rule?.origin !== "user-agent" ||
        typeof selector !== "string" ||
        selector.length > 512 ||
        !selector.includes("::-webkit-inner-spin-button") ||
        /[<>]/.test(selector)
      )
        return [];
      const properties = array(object(rule.style)?.cssProperties)
        .slice(0, 64)
        .flatMap((raw) => {
          const property = object(raw);
          if (
            property == null ||
            !["opacity", "visibility", "display", "appearance", "-webkit-appearance", "pointer-events"].includes(
              String(property.name),
            ) ||
            typeof property.value !== "string" ||
            !/^[a-z0-9 .%+-]{1,80}$/i.test(property.value)
          )
            return [];
          return [
            {
              name: property.name as string,
              value: property.value,
              important: property.important === true,
              disabled: property.disabled === true,
              parsedOk: property.parsedOk !== false,
            },
          ];
        })
        .slice(0, 8);
      return [
        {
          origin: "user-agent",
          selector,
          matchingSelectorIndices: array(match?.matchingSelectors)
            .filter((index) => Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < 64)
            .slice(0, 8),
          properties,
        },
      ];
    })
    .slice(0, 8);
}

/** Passive public-CDP reply copy for this page only; no additional send call. */
export function observeExistingSpinRules(page: Page) {
  const context = page.context(),
    create = context.newCDPSession;
  const restores: (() => void)[] = [];
  const records: unknown[] = [];
  let disposed = false,
    truncated = false,
    sessionOrdinal = 0,
    requestOrdinal = 0,
    bytes = 0;
  context.newCDPSession = async (target) => {
    const session = await create.call(context, target);
    if (disposed || target !== page) return session;
    if (restores.length >= 4) {
      truncated = true;
      return session;
    }
    const ordinal = ++sessionOrdinal,
      original = session.send,
      send = session.send.bind(session);
    let ids = new Map<number, number>();
    session.send = (async (method: Parameters<CDPSession["send"]>[0], params?: Parameters<CDPSession["send"]>[1]) => {
      const order = ++requestOrdinal;
      const reply = await send(method, params);
      try {
        if (method === "DOM.getDocument") ids = numberSpinNodeIds(reply);
        const id = object(params)?.nodeId;
        if (method === "CSS.getMatchedStylesForNode" && typeof id === "number" && ids.has(id)) {
          const record = {
            phase: "existing prepass reply before isolation",
            sessionOrdinal: ordinal,
            requestOrdinal: order,
            hostNodeId: ids.get(id),
            partNodeId: id,
            method,
            semantics: "raw matched declarations; not computed or winning values; not a painted-frame witness",
            declarations: boundedSpinDeclarations(reply),
          };
          const size = Buffer.byteLength(JSON.stringify(record));
          if (records.length < 8 && bytes + size <= 16 * 1024) {
            records.push(record);
            bytes += size;
          } else truncated = true;
        }
      } catch {
        truncated = true;
      }
      return reply;
    }) as CDPSession["send"];
    restores.push(() => {
      session.send = original;
    });
    return session;
  };
  return {
    snapshot: () => ({ records, truncated, bytes }),
    dispose() {
      disposed = true;
      context.newCDPSession = create;
      for (const restore of restores) restore();
    },
  };
}
