/** Lossless plain CaptureScriptArgs/CapturedTree transport. This is not a
 * general evaluate serializer. Work is linear in the actual finite graph;
 * no recursive walk or arbitrary captured-tree depth/size limit is added. */
type Atom =
  | { k: "u" | "null" | "nan" | "inf" | "-inf" | "-0" }
  | { k: "s"; v: string }
  | { k: "b"; v: boolean }
  | { k: "n"; v: number }
  | { k: "ref"; v: number };
type Container = { k: "a"; values: Atom[] } | { k: "o"; values: Array<[string, Atom]> };
export interface PlainCaptureWire {
  version: "domotion-plain-capture-v1";
  root: Atom;
  containers: Container[];
}

/** Self-contained: the same implementation also runs in the source realm. */
export function encodePlainCaptureValue(value: unknown): PlainCaptureWire {
  const containers: Container[] = [];
  const objects: object[] = [];
  const seen = new Map<object, number>();
  const atom = (input: unknown): Atom => {
    if (input === undefined) return { k: "u" };
    if (input === null) return { k: "null" };
    if (typeof input === "string") return { k: "s", v: input };
    if (typeof input === "boolean") return { k: "b", v: input };
    if (typeof input === "number") {
      if (Number.isNaN(input)) return { k: "nan" };
      if (input === Infinity) return { k: "inf" };
      if (input === -Infinity) return { k: "-inf" };
      if (Object.is(input, -0)) return { k: "-0" };
      return { k: "n", v: input };
    }
    if (typeof input !== "object") throw new Error("plain capture transport refuses non-data values");
    const previous = seen.get(input);
    if (previous !== undefined) return { k: "ref", v: previous };
    const array = Array.isArray(input);
    if (!array && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
      throw new Error("plain capture transport refuses non-plain objects");
    const id = containers.length;
    seen.set(input, id);
    objects.push(input);
    containers.push(array ? { k: "a", values: [] } : { k: "o", values: [] });
    return { k: "ref", v: id };
  };
  const root = atom(value);
  for (let index = 0; index < objects.length; index++) {
    const source = objects[index],
      target = containers[index];
    if (target.k === "a") {
      const array = source as unknown[];
      // Playwright materializes holes as own undefined array entries too.
      for (let at = 0; at < array.length; at++) target.values.push(atom(array[at]));
    } else {
      const object = source as Record<string, unknown>;
      for (const key of Object.keys(object)) {
        if (key === "__proto__") continue;
        let entry: unknown;
        try {
          entry = object[key];
        } catch {
          continue;
        }
        target.values.push([key, atom(entry)]);
      }
    }
  }
  return { version: "domotion-plain-capture-v1", root, containers };
}

/** Validate graph references before populating objects. Dynamic keys are own
 * data properties; match Playwright1.59.1's explicit __proto__ omission. */
export function decodePlainCaptureValue(input: unknown): unknown {
  const fail = (): never => {
    throw new Error("invalid plain capture wire value");
  };
  if (input === null || typeof input !== "object") return fail();
  const graph = input as Partial<PlainCaptureWire>;
  if (graph.version !== "domotion-plain-capture-v1" || !Array.isArray(graph.containers)) return fail();
  const containers = graph.containers;
  const values: Array<unknown[] | Record<string, unknown>> = [];
  for (const node of containers) {
    if (node == null || !Array.isArray(node.values) || (node.k !== "a" && node.k !== "o")) return fail();
    values.push(node.k === "a" ? [] : {});
  }
  const atom = (encoded: unknown): unknown => {
    if (encoded === null || typeof encoded !== "object") return fail();
    const item = encoded as { k?: unknown; v?: unknown };
    switch (item.k) {
      case "u":
        return undefined;
      case "null":
        return null;
      case "nan":
        return NaN;
      case "inf":
        return Infinity;
      case "-inf":
        return -Infinity;
      case "-0":
        return -0;
      case "s":
        if (typeof item.v === "string") return item.v;
        break;
      case "b":
        if (typeof item.v === "boolean") return item.v;
        break;
      case "n":
        if (typeof item.v === "number" && Number.isFinite(item.v) && !Object.is(item.v, -0)) return item.v;
        break;
      case "ref":
        if (Number.isSafeInteger(item.v) && Number(item.v) >= 0 && Number(item.v) < values.length)
          return values[Number(item.v)];
        break;
    }
    return fail();
  };
  for (let index = 0; index < containers.length; index++) {
    const container = containers[index],
      value = values[index];
    if (container.k === "a") for (const entry of container.values) (value as unknown[]).push(atom(entry));
    else
      for (const entry of container.values) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") return fail();
        if (entry[0] === "__proto__") continue;
        Object.defineProperty(value, entry[0], {
          value: atom(entry[1]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
  }
  return atom(graph.root);
}
