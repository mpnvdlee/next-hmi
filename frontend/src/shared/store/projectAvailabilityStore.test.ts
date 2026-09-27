import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reasonFor,
  resetAvailabilityProbe,
  useProjectAvailabilityStore,
} from './projectAvailabilityStore';

const PRESENT = [{ id: 'p1', name: 'Line 1', status: 'present' }];

describe('reasonFor', () => {
  it('is null while the instance is up, or on its way up', () => {
    expect(reasonFor('p1', PRESENT, [{ id: 'p1', status: 'running' }])).toBeNull();
    expect(reasonFor('p1', PRESENT, [{ id: 'p1', status: 'starting' }])).toBeNull();
  });

  it('reads stopped from a project with no live instance', () => {
    expect(reasonFor('p1', PRESENT, [])).toBe('stopped');
    expect(reasonFor('p1', PRESENT, [{ id: 'p1', status: 'stopped' }])).toBe('stopped');
  });

  it('distinguishes crashed, missing and unregistered', () => {
    expect(reasonFor('p1', PRESENT, [{ id: 'p1', status: 'crashed' }])).toBe('crashed');
    expect(reasonFor('p1', [{ id: 'p1', status: 'missing' }], [])).toBe('missing');
    expect(reasonFor('ghost', PRESENT, [])).toBe('unknown');
  });
});

describe('resolve', () => {
  beforeEach(() => {
    window.__NEXTHMI_BASE__ = '/editor/p1/';
    resetAvailabilityProbe();
    useProjectAvailabilityStore.setState({ reason: null, projectName: null });
  });

  afterEach(() => {
    delete window.__NEXTHMI_BASE__;
    vi.unstubAllGlobals();
  });

  /** Both manager endpoints, keyed by path, as `fetch` would answer them. */
  function stubManager(projects: unknown[], instances: unknown[]) {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url === '/api/projects' ? { projects } : { instances }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('blocks the document once the manager confirms the project is stopped', async () => {
    stubManager(PRESENT, []);

    await useProjectAvailabilityStore.getState().resolve();

    expect(useProjectAvailabilityStore.getState().reason).toBe('stopped');
    expect(useProjectAvailabilityStore.getState().projectName).toBe('Line 1');
  });

  it('stays quiet for an instance that is merely still starting', async () => {
    stubManager(PRESENT, [{ id: 'p1', status: 'starting' }]);

    await useProjectAvailabilityStore.getState().resolve();

    expect(useProjectAvailabilityStore.getState().reason).toBeNull();
  });

  it('asks the manager at the origin, not through the dead instance base', async () => {
    const fetchMock = stubManager(PRESENT, []);

    await useProjectAvailabilityStore.getState().resolve();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/projects',
      '/api/manager/running',
    ]);
  });

  it('coalesces the concurrent calls every gated request would make', async () => {
    const fetchMock = stubManager(PRESENT, []);

    await Promise.all([
      useProjectAvailabilityStore.getState().resolve(),
      useProjectAvailabilityStore.getState().resolve(),
      useProjectAvailabilityStore.getState().resolve(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the manager is unreachable too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await useProjectAvailabilityStore.getState().resolve();

    expect(useProjectAvailabilityStore.getState().reason).toBeNull();
  });

  it('does nothing outside a project document', async () => {
    delete window.__NEXTHMI_BASE__;
    const fetchMock = stubManager(PRESENT, []);

    await useProjectAvailabilityStore.getState().resolve();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
