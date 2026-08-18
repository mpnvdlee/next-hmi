import { render, screen, waitFor } from '@testing-library/react';
import { useEditorDomainStore } from '@config/store/domains/editorDomainStore';
import { useConfigStore } from '@shared/store/configStore';
import { apiJson } from '@shared/utils/api';
import type { Diagnostic } from '@config/hooks/usePanelDiagnostics';
import { EDITOR_NODE_IDS } from '@shared/constants/editorSentinels';
import PropertiesPanel from './index';

vi.mock('@shared/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/utils/api')>()),
  apiJson: vi.fn(),
}));

const unknownSizeBinding: Diagnostic = {
  artifactId: 'shell',
  artifactKind: 'shell',
  // The backend attributes region settings to the editor's shell-area tree node
  // — they belong to no widget (see `_synthetic_owner` in config_api.py).
  widgetId: EDITOR_NODE_IDS.HEADER,
  propKey: 'expandedSize',
  fieldPath: ['expandedSize'],
  code: 'var-unknown',
  severity: 'error',
  message: "unknown variable 'PLC:Missing/Size'",
  breadcrumb: 'Shell › Header › expandedSize',
  nested: false,
};

describe('ShellAreaPanel diagnostics', () => {
  beforeEach(() => {
    useConfigStore.setState({
      pages: [],
      header: [],
      footer: [],
      leftSidebar: [],
      rightSidebar: [],
      dialogs: [],
      shell: { header: { expandedSize: { $var: { path: 'PLC:Missing/Size' } } } },
      loaded: true,
    });
    useEditorDomainStore.setState({ selectedId: EDITOR_NODE_IDS.HEADER });
    vi.mocked(apiJson).mockResolvedValue({ diagnostics: [unknownSizeBinding] });
  });

  afterEach(() => {
    vi.mocked(apiJson).mockReset();
  });

  it('marks the region field the diagnostic points at', async () => {
    const { container } = render(<PropertiesPanel />);

    expect(screen.getByText('Expanded size')).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector('.cfg-field-group__badge--invalid')).not.toBeNull();
    });
    expect(container.querySelectorAll('.cfg-field-group__badge--invalid')).toHaveLength(1);
  });
});
