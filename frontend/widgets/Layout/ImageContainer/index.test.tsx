// Rendered through the registry, like a page renders it: both this widget and
// its Container children are lazy built-in modules, so the SDK has to be bound
// and the first paint of every assertion below is asynchronous.
import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { WidgetConfig } from '@shared/types/config';
import { autoMarkerLabel, clamp01, resolveMarkerLabel } from '@shared/utils/childPositions';
import WidgetRenderer from '@hmi/components/WidgetRenderer';

function childOf(overrides: Partial<WidgetConfig> & { id: string }): WidgetConfig {
  return {
    type: 'Container',
    name: overrides.id,
    properties: { title: overrides.id, showWhenEmpty: true },
    ...overrides,
  };
}

function renderImageContainer(properties: Record<string, unknown>, childConfigs?: WidgetConfig[]) {
  return render(
    <MemoryRouter initialEntries={['/pages/test']}>
      <WidgetRenderer
        node={{
          id: 'image-container',
          type: 'ImageContainer',
          name: 'Image Container',
          properties,
          layout: {},
          children: childConfigs,
        }}
      />
    </MemoryRouter>,
  );
}

describe('ImageContainer', () => {
  beforeEach(() => {
    useVariableStore.setState({
      values: {},
      varMeta: {},
      snapshotReceived: false,
      wsConnected: false,
      opcuaConnected: {},
    });
    useHmiStore.setState({
      openDialogs: [],
      openPageOverlays: [],
      currentUsersByScope: {},
      loginErrorsByScope: {},
    });
    useComponentPropStore.setState({ props: {} });
    useTranslationStore.setState({
      languages: [{ code: 'en' }],
      translations: {},
      loaded: true,
      activeLanguage: 'en',
      dictionaries: ['Default'],
      activeDictionary: 'Default',
      _draftsByDictionary: {},
      error: null,
    });
  });

  it('renders nothing when visible is false', () => {
    const { container } = renderImageContainer({ visible: false }, [childOf({ id: 'a' })]);
    expect(container.firstChild).toBeNull();
  });

  it('roots a bound asset path under /assets, the way a $static payload arrives', async () => {
    // A $var or $urlParam on the asset field delivers the stored path verbatim;
    // in `src` a project-relative one would resolve against the page url.
    const { container } = renderImageContainer({ src: 'images/plant.png' });

    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute('src', '/assets/images/plant.png'),
    );
  });

  it('leaves an already-resolved asset url alone', async () => {
    const { container } = renderImageContainer({ src: { $static: { path: 'images/plant.png' } } });

    await waitFor(() =>
      expect(container.querySelector('img')).toHaveAttribute('src', '/assets/images/plant.png'),
    );
  });

  it('renders each child itself with absolute slot positioning', async () => {
    const children = [
      childOf({ id: 'a', properties: { title: 'Alpha', showWhenEmpty: true } }),
      childOf({ id: 'b', properties: { title: 'Beta', showWhenEmpty: true } }),
    ];
    const positions = [
      { id: 'a', x: 0.25, y: 0.4 },
      { id: 'b', x: 0.75, y: 0.6 },
    ];
    const { container } = renderImageContainer(
      { src: '/img.png', childPositions: positions },
      children,
    );
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-child-id]')).toHaveLength(2);
    const slotA = container.querySelector('[data-child-id="a"]') as HTMLElement;
    expect(slotA.style.getPropertyValue('--hmi-imgctn-x')).toBe('25%');
    expect(slotA.style.getPropertyValue('--hmi-imgctn-y')).toBe('40%');
  });

  it('drops marker, slot, and stacked row for group-gated children', async () => {
    useHmiStore.setState({
      openDialogs: [],
      openPageOverlays: [],
      currentUsersByScope: {
        'runtime:main': { username: 'op', groups: ['operator'], groupLabels: {} },
      },
      loginErrorsByScope: {},
    });
    const children = [
      childOf({
        id: 'open',
        properties: { title: 'OpenChild', showWhenEmpty: true },
      }),
      childOf({
        id: 'gated',
        properties: {
          title: 'GatedChild',
          showWhenEmpty: true,
          visible: { $userGroups: { groups: ['admin'] } },
        },
      }),
    ];
    const { container } = renderImageContainer(
      {
        src: '/img.png',
        childPositions: [
          { id: 'open', x: 0.1, y: 0.1 },
          { id: 'gated', x: 0.9, y: 0.9 },
        ],
      },
      children,
    );
    expect(await screen.findByText('OpenChild')).toBeInTheDocument();
    expect(screen.queryByText('GatedChild')).not.toBeInTheDocument();
    expect(container.querySelector('[data-child-id="gated"]')).toBeNull();
  });

  it('renders orphan-id positions safely (no entry, no crash)', async () => {
    const children = [childOf({ id: 'a', properties: { title: 'Alpha', showWhenEmpty: true } })];
    expect(() =>
      renderImageContainer(
        {
          src: '/img.png',
          childPositions: [
            { id: 'a', x: 0.5, y: 0.5 },
            { id: 'orphan', x: 0.5, y: 0.5 },
          ],
        },
        children,
      ),
    ).not.toThrow();
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });

  it('defaults unplaced children to centre', async () => {
    const children = [
      childOf({ id: 'lonely', properties: { title: 'Lonely', showWhenEmpty: true } }),
    ];
    const { container } = renderImageContainer({ src: '/img.png' }, children);
    expect(await screen.findByText('Lonely')).toBeInTheDocument();
    const slot = container.querySelector('[data-child-id="lonely"]') as HTMLElement;
    expect(slot.style.getPropertyValue('--hmi-imgctn-x')).toBe('50%');
    expect(slot.style.getPropertyValue('--hmi-imgctn-y')).toBe('50%');
  });

  // A widget module carries no app imports, so the render-time half of
  // @shared/utils/childPositions is duplicated inside index.tsx. Letters and
  // coordinates the operator sees on the image must match what the editor prints
  // beside each child — and the local copies are module-private, so the only way
  // to reach them is through a render. Each test below therefore compares
  // rendered output against the shared helper rather than calling both directly.
  it('labels markers the way the placement editor does', async () => {
    const children = ['a', 'b', 'c'].map((id) => childOf({ id, properties: { title: id } }));
    const { container } = renderImageContainer(
      { src: '/img.png', childPositions: [{ id: 'b', x: 0.5, y: 0.5, label: 'Pump' }] },
      children,
    );
    // Each label renders twice — once in the marker layer over the image, once
    // inline beside the child in collapsed mode — so match all of them.
    expect(await screen.findAllByText('Pump')).toHaveLength(2);
    const markers = [...container.querySelectorAll('.hmi-imgctn__marker')].map(
      (el) => el.textContent,
    );
    expect(markers).toEqual([
      resolveMarkerLabel(undefined, 0),
      resolveMarkerLabel({ id: 'b', x: 0.5, y: 0.5, label: 'Pump' }, 1),
      resolveMarkerLabel(undefined, 2),
    ]);
    expect(markers).toEqual(['A', 'Pump', 'C']);
  });

  it('rolls marker letters past Z the way the placement editor does', async () => {
    // Index 26 is the wrap point (Z → AA) and the one case a three-child test
    // cannot reach, which is where a hand-copied loop would diverge.
    const children = Array.from({ length: 27 }, (_, i) => childOf({ id: `c${i}` }));
    const { container } = renderImageContainer({ src: '/img.png' }, children);
    expect(await screen.findAllByText('c26')).not.toHaveLength(0);

    const markers = [...container.querySelectorAll('.hmi-imgctn__marker')].map(
      (el) => el.textContent,
    );
    expect(markers).toEqual(Array.from({ length: 27 }, (_, i) => autoMarkerLabel(i)));
    expect(markers[25]).toBe('Z');
    expect(markers[26]).toBe('AA');
  });

  it('clamps out-of-range coordinates the way the placement editor does', async () => {
    const { container } = renderImageContainer(
      { src: '/img.png', childPositions: [{ id: 'a', x: 2, y: -1 }] },
      [childOf({ id: 'a' })],
    );
    expect(await screen.findAllByText('a')).not.toHaveLength(0);

    const slot = container.querySelector('[data-child-id="a"]') as HTMLElement;
    expect(slot.style.getPropertyValue('--hmi-imgctn-x')).toBe(`${clamp01(2) * 100}%`);
    expect(slot.style.getPropertyValue('--hmi-imgctn-y')).toBe(`${clamp01(-1) * 100}%`);
    expect(slot.style.getPropertyValue('--hmi-imgctn-x')).toBe('100%');
    expect(slot.style.getPropertyValue('--hmi-imgctn-y')).toBe('0%');
  });
});
