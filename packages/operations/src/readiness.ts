/** Share only in-flight work; every subsequent probe checks dependencies again. */
export function singleFlightProbe(
  probe: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;

  return () => {
    inFlight ??= Promise.resolve()
      .then(probe)
      .finally(() => {
        inFlight = undefined;
      });

    return inFlight;
  };
}
