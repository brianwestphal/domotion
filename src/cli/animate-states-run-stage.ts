export interface StatesRunStages<Captured, Composed, Output> {
  capture: () => Promise<Captured>;
  compose: (captured: Captured) => Composed;
  sizeGuard: (captured: Captured, composed: Composed) => Output;
}

/** Execute the browser, compression, and measured-size phases in order. */
export async function buildStatesRunContent<Captured, Composed, Output>(
  stages: StatesRunStages<Captured, Composed, Output>,
): Promise<Output> {
  const captured = await stages.capture();
  const composed = stages.compose(captured);
  return stages.sizeGuard(captured, composed);
}
