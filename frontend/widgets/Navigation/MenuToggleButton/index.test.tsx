import '../../testSdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import MenuToggleButton from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

function renderToggle(properties: Record<string, unknown>) {
  return render(
    <MemoryRouter>
      <MenuToggleButton properties={properties} />
    </MemoryRouter>,
  );
}

describe('MenuToggleButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetForTests();
  });

  it('shows the collapsed glyph and aria-pressed=false when the bound value is falsy', () => {
    renderToggle({ bound: { $var: { path: 'PLC:Menu/Open' } } });

    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveTextContent('☰');
  });

  it('shows the expanded glyph and aria-pressed=true when the bound value is true', () => {
    useVariableStore.setState({ values: { 'PLC:Menu/Open': true } });
    renderToggle({ bound: { $var: { path: 'PLC:Menu/Open' } } });

    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    expect(btn).toHaveTextContent('×');
  });

  it('writes the negated value back on click, correlated by requestId', async () => {
    useVariableStore.setState({ values: { 'PLC:Menu/Open': false } });
    const user = userEvent.setup();
    renderToggle({ bound: { $var: { path: 'PLC:Menu/Open' } } });

    await user.click(screen.getByRole('button'));

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      requestId: expect.any(String),
      scope: 'runtime:preview',
      datasource: 'PLC',
      path: 'Menu/Open',
      value: true,
    });
    const frame = vi.mocked(sendWsMessage).mock.calls[0][0] as { requestId?: string };
    expect(frame.requestId).toBeTruthy();
  });

  it('renders a custom SVG icon fetched and stripped of hardcoded fill colors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ text: async () => '<svg fill="red"><path/></svg>' }),
    );
    const { container } = renderToggle({
      bound: false,
      iconCollapsed: '/assets/icons/menu.svg',
    });

    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
    expect(container.querySelector('svg')?.outerHTML).not.toContain('fill="red"');
    expect(container.querySelector('svg')?.outerHTML).toContain('currentColor');
  });
});
