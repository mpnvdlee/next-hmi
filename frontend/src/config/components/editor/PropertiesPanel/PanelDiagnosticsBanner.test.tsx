import { render, screen } from '@testing-library/react';
import { usePanelDiagnosticsStore, type Diagnostic } from '@config/hooks/usePanelDiagnostics';
import PanelDiagnosticsBanner from './PanelDiagnosticsBanner';

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    artifactId: 'page-1',
    artifactKind: 'page',
    widgetId: null,
    propKey: null,
    code: 'sections-invalid',
    severity: 'error',
    message: 'must be an object',
    breadcrumb: 'sections',
    nested: false,
    ...overrides,
  };
}

describe('PanelDiagnosticsBanner', () => {
  beforeEach(() => usePanelDiagnosticsStore.getState().clear());

  it('renders nothing when every finding has an owning field', () => {
    const { container } = render(<PanelDiagnosticsBanner />);
    expect(container).toBeEmptyDOMElement();

    usePanelDiagnosticsStore
      .getState()
      .setDiagnostics([diagnostic({ widgetId: 'w1' })], 'page:page-1');
    render(<PanelDiagnosticsBanner />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('banners the findings no field can badge', () => {
    usePanelDiagnosticsStore
      .getState()
      .setDiagnostics(
        [diagnostic({}), diagnostic({ widgetId: 'w1', message: 'owned' })],
        'page:page-1',
      );
    render(<PanelDiagnosticsBanner />);

    const banner = screen.getByRole('status');
    expect(banner.className).toContain('cfg-panel-diagnostics--error');
    expect(screen.getByText('must be an object')).toBeInTheDocument();
    expect(screen.queryByText('owned')).not.toBeInTheDocument();
  });

  it('reads as a warning when no unowned finding is an error', () => {
    usePanelDiagnosticsStore
      .getState()
      .setDiagnostics([diagnostic({ severity: 'warning' })], 'page:page-1');
    render(<PanelDiagnosticsBanner />);
    expect(screen.getByRole('status').className).toContain('cfg-panel-diagnostics--warning');
  });
});
