/**
 * Track an in-flight async request that can be superseded.
 *
 * Usage in a Zustand store:
 *
 *   const loader = makeAbortableLoader();
 *   ...
 *   load: async () => {
 *     const c = loader.begin();
 *     try {
 *       const r = await fetch(url, { signal: c.signal });
 *       if (!loader.isCurrent(c)) return;
 *       set({ data: await r.json() });
 *     } catch (err) {
 *       if (c.signal.aborted) return;
 *       set({ error: '...' });
 *     } finally {
 *       loader.finalize(c);
 *     }
 *   }
 */
interface AbortableLoader {
  /** Aborts any in-flight request and returns a fresh controller for the new one. */
  begin(): AbortController;
  /** True if the given controller is still the latest call. */
  isCurrent(controller: AbortController): boolean;
  /** Clears the stored reference if it still matches the supplied controller. */
  finalize(controller: AbortController): void;
}

export function makeAbortableLoader(): AbortableLoader {
  let current: AbortController | null = null;
  return {
    begin() {
      current?.abort();
      const c = new AbortController();
      current = c;
      return c;
    },
    isCurrent(c) {
      return current === c;
    },
    finalize(c) {
      if (current === c) current = null;
    },
  };
}
