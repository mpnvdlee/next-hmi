import '../../testSdk';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import WidgetRenderer from '@hmi/components/WidgetRenderer';

function renderContainer(properties?: Record<string, unknown>, route = '/pages/test') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WidgetRenderer
        node={{
          id: 'container',
          type: 'Container',
          name: 'Container',
          properties: { showWhenEmpty: true, ...properties },
        }}
      />
    </MemoryRouter>,
  );
}

describe('WidgetRenderer visible property', () => {
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

  it('renders by default when visible is not set', async () => {
    renderContainer({ title: 'Main Container' });

    expect(await screen.findByText('Main Container')).toBeInTheDocument();
  });

  it('hides when visible is false', () => {
    renderContainer({ title: 'Main Container', visible: false });

    expect(screen.queryByText('Main Container')).not.toBeInTheDocument();
  });

  it('treats url parameter false as hidden', () => {
    renderContainer(
      {
        title: 'Main Container',
        visible: { $urlParam: { name: 'visible', default: true } },
      },
      '/pages/test?visible=false',
    );

    expect(screen.queryByText('Main Container')).not.toBeInTheDocument();
  });

  it('applies the background property as the --container-bg custom property', async () => {
    renderContainer({ title: 'Main Container', background: '#22a7e0' });

    const el = (await screen.findByText('Main Container')).closest('.hmi-container') as HTMLElement;
    expect(el.style.getPropertyValue('--container-bg')).toBe('#22a7e0');
  });

  it('leaves --container-bg unset when background is not provided', async () => {
    renderContainer({ title: 'Main Container' });

    const el = (await screen.findByText('Main Container')).closest('.hmi-container') as HTMLElement;
    expect(el.style.getPropertyValue('--container-bg')).toBe('');
  });

  it('evaluates if expressions backed by plc variables', () => {
    useVariableStore.setState({
      values: { 'PLC:ShowContainer': 0 },
      varMeta: {},
      snapshotReceived: false,
      wsConnected: false,
      opcuaConnected: {},
    });

    renderContainer({
      title: 'Main Container',
      visible: {
        $if: {
          condition: { $var: { path: 'PLC:ShowContainer' } },
          true: true,
          false: false,
        },
      },
    });

    expect(screen.queryByText('Main Container')).not.toBeInTheDocument();
  });
});
