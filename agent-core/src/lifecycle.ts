/** Tracks in-flight async work so shutdown can wait for it to settle. */
export function trackInFlight() {
  const inFlight = new Set<Promise<unknown>>();
  return {
    wrap<A extends unknown[], R>(fn: (...args: A) => Promise<R> | R): (...args: A) => Promise<R> {
      return (...args) => {
        const p = Promise.resolve().then(() => fn(...args));
        inFlight.add(p);
        const remove = () => void inFlight.delete(p);
        p.then(remove, remove);
        return p;
      };
    },
    async drain(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
