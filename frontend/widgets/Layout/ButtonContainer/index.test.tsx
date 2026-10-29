import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useTranslationStore } from '@shared/store/translationStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useVariableStore } from '@hmi/store/variableStore';
import WidgetRenderer from '@hmi/components/WidgetRenderer';

function renderButtonContainer(
  properties?: Record<string, unknown>,
  route = '/pages/test',
  name = 'Button Container',
) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <WidgetRenderer
        node={{
          id: 'container',
          type: 'ButtonContainer',
          name,
          properties: { showWhenEmpty: true, ...properties },
        }}
      />
    </MemoryRouter>,
  );
}

describe('ButtonContainer', () => {
  beforeEach(() => {
    useVariableStore.setState({
      values: {},
      varMeta: {},
      snapshotReceived: false,
      wsConnected: false,
      opcuaConnected: {},
    });
    useHmiStore.setState({
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

  describe('press actions', () => {
    const openSettings = { onPress: [{ type: 'openPageOverlay', pageId: 'settings' }] };
    const openOverlays = () => useHmiStore.getState().openPageOverlays.map((o) => o.pageId);

    it('is a control even before it has actions', async () => {
      renderButtonContainer({ title: 'Main Container' });

      const el = (await screen.findByText('Main Container')).closest(
        '.hmi-container',
      ) as HTMLElement;
      expect(el).toHaveAttribute('role', 'button');
      expect(el).toHaveClass('hmi-container--pressable');
    });

    it('runs its actions when pressed', async () => {
      const user = userEvent.setup();
      renderButtonContainer(
        { title: 'Settings', actions: openSettings },
        undefined,
        'Open settings',
      );

      await user.click(await screen.findByRole('button'));

      expect(openOverlays()).toEqual(['settings']);
    });

    it('runs its On Released actions on release', async () => {
      const user = userEvent.setup();
      renderButtonContainer({
        title: 'Hold',
        onRelease: { onRelease: [{ type: 'openPageOverlay', pageId: 'released' }] },
      });
      const el = await screen.findByRole('button');

      await user.pointer({ keys: '[MouseLeft>]', target: el });
      expect(openOverlays()).toEqual([]);

      await user.pointer({ keys: '[/MouseLeft]', target: el });
      expect(openOverlays()).toEqual(['released']);
    });

    it.each(['{Enter}', ' '])('runs its actions on %s from the keyboard', async (key) => {
      const user = userEvent.setup();
      renderButtonContainer({ title: 'Settings', actions: openSettings });
      await screen.findByText('Settings');

      await user.tab();
      expect(screen.getByRole('button')).toHaveFocus();
      await user.keyboard(key);

      expect(openOverlays()).toEqual(['settings']);
    });

    it('leaves a press on a Button inside it to that Button', async () => {
      const user = userEvent.setup();
      render(
        <MemoryRouter>
          <WidgetRenderer
            node={{
              id: 'container',
              type: 'ButtonContainer',
              name: 'Tile',
              properties: { actions: openSettings },
              children: [
                {
                  id: 'inner',
                  type: 'Button',
                  name: 'Button',
                  properties: {
                    label: 'Inner',
                    actions: { onPress: [{ type: 'openPageOverlay', pageId: 'inner' }] },
                  },
                },
              ],
            }}
          />
        </MemoryRouter>,
      );

      await user.click((await screen.findByText('Inner')).closest('button')!);

      expect(openOverlays()).toEqual(['inner']);
    });
  });
});
