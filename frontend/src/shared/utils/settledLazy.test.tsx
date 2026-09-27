import { Suspense } from 'react';
import { render, screen } from '@testing-library/react';
import { preloadableLazy } from './settledLazy';

function View() {
  return <p>view</p>;
}

function renderIn(Lazy: React.ComponentType) {
  return render(
    <Suspense fallback={<p>fallback</p>}>
      <Lazy />
    </Suspense>,
  );
}

describe('preloadableLazy', () => {
  it('renders on the first render once preloaded, never showing the fallback', async () => {
    const Lazy = preloadableLazy(() => Promise.resolve({ default: View }));
    await Lazy.preload();
    expect(Lazy.isLoaded()).toBe(true);

    renderIn(Lazy);
    expect(screen.getByText('view')).toBeTruthy();
    expect(screen.queryByText('fallback')).toBeNull();
  });

  it('suspends like plain lazy when rendered before the chunk is in', async () => {
    const Lazy = preloadableLazy(() => Promise.resolve({ default: View }));
    renderIn(Lazy);
    expect(screen.getByText('fallback')).toBeTruthy();
    expect(await screen.findByText('view')).toBeTruthy();
  });

  it('loads the chunk once, however often it is preloaded', async () => {
    const importer = vi.fn(() => Promise.resolve({ default: View }));
    const Lazy = preloadableLazy(importer);
    await Promise.all([Lazy.preload(), Lazy.preload()]);
    await Lazy.preload();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('tries again after a failed load instead of keeping the failure', async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error('stale chunk'))
      .mockResolvedValueOnce({ default: View });
    const Lazy = preloadableLazy(importer);
    await expect(Lazy.preload()).rejects.toThrow('stale chunk');
    expect(Lazy.isLoaded()).toBe(false);
    await Lazy.preload();
    expect(Lazy.isLoaded()).toBe(true);
  });
});
