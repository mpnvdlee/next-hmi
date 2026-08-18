import { useProjectStore } from '@shared/store/projectStore';
import type { ComponentDefinition } from '@shared/types/componentTypes';
import { useComponentStore } from './componentStore';

const COMP_A = {
  id: 'comp-a',
  name: 'Component A',
  componentProperties: {},
  children: [],
};

const COMP_B = {
  id: 'comp-b',
  name: 'Component B',
  componentProperties: {},
  children: [],
};

beforeEach(() => {
  useComponentStore.setState({
    components: [],
    folders: [],
    loaded: false,
    loading: false,
    draftComponents: {},
    draftStructureRev: 0,
  });
  useProjectStore.setState({
    dirty: false,
    saving: false,
    saveError: null,
    past: [],
    future: [],
    _saveCallbacks: useProjectStore.getState()._saveCallbacks,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Draft management ──────────────────────────────────────────────────────────

describe('draft management', () => {
  it('setComponentDraft stores draft keyed by component id', () => {
    useComponentStore.getState().setComponentDraft(COMP_A);
    expect(useComponentStore.getState().draftComponents['comp-a']).toEqual(COMP_A);
  });

  it('bumps the structure revision for every draft write but a property one', () => {
    const rev = () => useComponentStore.getState().draftStructureRev;
    const withChild = { ...COMP_A, children: [{ id: 'w1', type: 'Button', name: 'w1' }] };

    // A write that says nothing about itself is treated as structural, so a call
    // site added later cannot leave a memo keyed on this showing a stale tree.
    useComponentStore.getState().setComponentDraft(withChild);
    expect(rev()).toBe(1);

    useComponentStore
      .getState()
      .setComponentDraft(
        { ...withChild, children: [{ id: 'w1', type: 'Button', name: 'typed' }] },
        'properties',
      );
    expect(rev()).toBe(1);
    expect(useComponentStore.getState().draftComponents['comp-a']).toEqual({
      ...withChild,
      children: [{ id: 'w1', type: 'Button', name: 'typed' }],
    });

    useComponentStore.getState().setComponentDraft(COMP_A, 'structure');
    expect(rev()).toBe(2);

    // An undo puts back drafts from another point in time — any tree order
    // resolved against the current ones is stale.
    useComponentStore.getState().restoreDrafts({ 'comp-a': withChild });
    expect(rev()).toBe(3);
    expect(useComponentStore.getState().draftComponents).toEqual({ 'comp-a': withChild });
  });

  it('clearComponentDraft removes only the specified draft', () => {
    useComponentStore.getState().setComponentDraft(COMP_A);
    useComponentStore.getState().setComponentDraft(COMP_B);
    useComponentStore.getState().clearComponentDraft('comp-a');
    const drafts = useComponentStore.getState().draftComponents;
    expect(drafts['comp-a']).toBeUndefined();
    expect(drafts['comp-b']).toEqual(COMP_B);
  });

  it('deleteComponent also removes the draft for that component', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    useComponentStore.setState({ components: [COMP_A] });
    useComponentStore.getState().setComponentDraft(COMP_A);

    await useComponentStore.getState().deleteComponent('comp-a');
    expect(useComponentStore.getState().draftComponents['comp-a']).toBeUndefined();
  });
});

// ── createComponentFromDefinition ───────────────────────────────────────────

describe('createComponentFromDefinition', () => {
  it('posts and stores the complete component definition', async () => {
    const component: ComponentDefinition = {
      id: '',
      name: 'Copied component',
      group: 'Controls',
      componentProperties: { label: { label: 'Label', type: 'string', defaultValue: 'Start' } },
      children: [{ id: 'button', type: 'Button', name: 'Start button', properties: {} }],
    };
    const created = { ...component, id: 'copied-component' };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => created }));
    vi.stubGlobal('fetch', fetchMock);

    await useComponentStore.getState().createComponentFromDefinition(component);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/components',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(component) }),
    );
    expect(useComponentStore.getState().components).toEqual([created]);
  });
});

// ── createFolder ───────────────────────────────────────────────────────────────

describe('createFolder', () => {
  it('adds a top-level folder path', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await useComponentStore.getState().createFolder('A');
    expect(useComponentStore.getState().folders).toEqual(['A']);
  });

  it('adds every ancestor prefix for a nested path, matching the backend auto-creating parents', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    await useComponentStore.getState().createFolder('A/B/C');
    expect(useComponentStore.getState().folders).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('does not duplicate an already-known ancestor', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    useComponentStore.setState({ folders: ['A'] });
    await useComponentStore.getState().createFolder('A/B');
    expect(useComponentStore.getState().folders).toEqual(['A', 'A/B']);
  });
});

// ── deleteFolder ───────────────────────────────────────────────────────────────

describe('deleteFolder', () => {
  it('removes the folder and hits the encoded nested-path DELETE endpoint', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    useComponentStore.setState({ folders: ['A', 'A/B'] });
    await useComponentStore.getState().deleteFolder('A/B');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/components/folders/A/B',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(useComponentStore.getState().folders).toEqual(['A']);
  });

  it('cascades to subfolders, their components, and drafts', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const inFolder = { ...COMP_A, group: 'A/B' };
    const inSibling = { ...COMP_B, group: 'A/C' };
    useComponentStore.setState({
      folders: ['A', 'A/B', 'A/C'],
      components: [inFolder, inSibling],
    });
    useComponentStore.getState().setComponentDraft(inFolder);
    useComponentStore.getState().setComponentDraft(inSibling);

    await useComponentStore.getState().deleteFolder('A');

    const state = useComponentStore.getState();
    expect(state.folders).toEqual([]);
    expect(state.components).toEqual([]);
    expect(state.draftComponents).toEqual({});
  });

  it('leaves sibling folders and their components intact', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);

    const inSibling = { ...COMP_B, group: 'A/C' };
    useComponentStore.setState({
      folders: ['A', 'A/B', 'A/C'],
      components: [inSibling],
    });

    await useComponentStore.getState().deleteFolder('A/B');

    const state = useComponentStore.getState();
    expect(state.folders).toEqual(['A', 'A/C']);
    expect(state.components).toEqual([inSibling]);
  });
});

// ── registerSave callback ─────────────────────────────────────────────────────

describe('registerSave callback', () => {
  it('is registered as "components" in projectStore', () => {
    const cb = useProjectStore.getState()._saveCallbacks.get('components');
    expect(cb).toBeTruthy();
  });

  it('calls updateComponent for each draft and clears it on success', async () => {
    const updated = { ...COMP_A, name: 'Component A Updated' };
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.includes('/api/components/') && opts?.method === 'PUT') {
        return { ok: true, json: async () => updated };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    useComponentStore.setState({ components: [COMP_A] });
    useComponentStore.getState().setComponentDraft(updated);

    const saveCb = useProjectStore.getState()._saveCallbacks.get('components')!;
    await saveCb();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/components/comp-a',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(useComponentStore.getState().draftComponents).toEqual({});
  });

  it('throws with component name when one save fails', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.includes('/api/components/') && opts?.method === 'PUT') {
        return { ok: false, json: async () => ({ detail: 'server error' }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    useComponentStore.setState({ components: [COMP_A] });
    useComponentStore.getState().setComponentDraft(COMP_A);

    const saveCb = useProjectStore.getState()._saveCallbacks.get('components')!;
    await expect(saveCb()).rejects.toThrow('Component A');
  });

  it('saves remaining drafts when one component fails', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'PUT') {
        const failsA = url.includes('comp-a');
        if (failsA) return { ok: false, json: async () => ({ detail: 'fail' }) };
        return { ok: true, json: async () => COMP_B };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    useComponentStore.setState({ components: [COMP_A, COMP_B] });
    useComponentStore.getState().setComponentDraft(COMP_A);
    useComponentStore.getState().setComponentDraft(COMP_B);

    const saveCb = useProjectStore.getState()._saveCallbacks.get('components')!;
    await expect(saveCb()).rejects.toThrow();

    expect(useComponentStore.getState().draftComponents['comp-b']).toBeUndefined();
    expect(useComponentStore.getState().draftComponents['comp-a']).toBeDefined();
  });

  it('does nothing when there are no drafts', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const saveCb = useProjectStore.getState()._saveCallbacks.get('components')!;
    await saveCb();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
