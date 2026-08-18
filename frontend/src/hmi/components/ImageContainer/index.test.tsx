// The child fixture is a Container — a stdlib widget now, so a lazy module
// with no source jsdom can fetch without this shim.
import '../../../../widgets/testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import type { WidgetConfig } from '@shared/types/config';
import WidgetRenderer from '../WidgetRenderer';

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

  it('renders each child via WidgetRenderer with absolute slot positioning', async () => {
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
    const slots = container.querySelectorAll('[data-child-id]');
    expect(slots).toHaveLength(2);
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

  it('defaults unplaced children to centre', () => {
    const children = [
      childOf({ id: 'lonely', properties: { title: 'Lonely', showWhenEmpty: true } }),
    ];
    const { container } = renderImageContainer({ src: '/img.png' }, children);
    const slot = container.querySelector('[data-child-id="lonely"]') as HTMLElement;
    expect(slot.style.getPropertyValue('--hmi-imgctn-x')).toBe('50%');
    expect(slot.style.getPropertyValue('--hmi-imgctn-y')).toBe('50%');
  });
});
