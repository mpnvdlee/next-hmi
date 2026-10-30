import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { apiJson } from '@shared/utils/api';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import type { ButtonAction } from '@shared/types/config';
import PropertiesPanel from './index';

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/api')>()),
  apiJson: vi.fn(),
}));

const logout: ButtonAction = { type: 'logoutUser' };
const toast: ButtonAction = { type: 'showToast', message: 'Hi', severity: 'info', discard: 'auto' };

describe('Global Events copy/paste', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: [],
      dialogs: [],
      globalEvents: { onHmiLoaded: [logout, toast] },
      loaded: true,
    });
    useEditorDomainStore.setState({ selectedId: EDITOR_NODE_IDS.EVENTS });
    vi.mocked(apiJson).mockResolvedValue({ diagnostics: [] });
  });

  it('copies the selected action and pastes it after the selection without replacing', async () => {
    const user = userEvent.setup();
    render(<PropertiesPanel />);
    act(() =>
      useEditorDomainStore.getState().setSelectedParam({
        path: ['onHmiLoaded', '0'],
        schema: { type: '_action', label: 'Logout User' },
      }),
    );

    await user.keyboard('{Control>}c{/Control}');
    expect(JSON.parse(await navigator.clipboard.readText())).toEqual({ $static: logout });

    await user.keyboard('{Control>}v{/Control}');
    await waitFor(() =>
      expect(useConfigStore.getState().globalEvents.onHmiLoaded).toEqual([logout, logout, toast]),
    );
  });
});
