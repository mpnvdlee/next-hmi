import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * `React.lazy` that renders without suspending once `peek` has the component.
 *
 * Plain `lazy` suspends on its first render even when the code is already in
 * memory, because its loader always hands back a pending promise. React 19
 * then holds the reveal until 300 ms after the fallback appeared
 * (FALLBACK_THROTTLE_MS) — at boot that was two such waits back to back, with
 * the network and the CPU idle. A thenable that calls back synchronously lets
 * `lazy` resolve within the same render instead.
 */
export function settledLazy<P>(
  peek: () => ComponentType<P> | undefined,
  load: () => Promise<ComponentType<P>>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => {
    const ready = peek();
    if (ready) return settled({ default: ready });
    return load().then((component) => ({ default: component }));
  });
}

function settled<T>(value: T): Promise<T> {
  const thenable = {
    then(onFulfilled: (v: T) => unknown) {
      onFulfilled(value);
      return thenable;
    },
  };
  return thenable as unknown as Promise<T>;
}

export type PreloadableLazy<P> = LazyExoticComponent<ComponentType<P>> & {
  /** Load the chunk; the component then renders without suspending. */
  preload: () => Promise<ComponentType<P>>;
  isLoaded: () => boolean;
};

/** A code-split view behind `settledLazy`, with the `preload` that fills it. */
export function preloadableLazy<P>(
  importer: () => Promise<{ default: ComponentType<P> }>,
): PreloadableLazy<P> {
  let component: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | null = null;
  const preload = () =>
    (pending ??= importer().then(
      (mod) => (component = mod.default),
      (err) => {
        pending = null;
        throw err;
      },
    ));
  return Object.assign(
    settledLazy(() => component, preload),
    { preload, isLoaded: () => component !== undefined },
  );
}
