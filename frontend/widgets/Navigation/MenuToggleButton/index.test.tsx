import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import MenuToggleButton from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

function renderToggle(properties: Record<string, unknown>, name?: string) {
  return render(
    <MemoryRouter>
      <MenuToggleButton name={name} properties={properties} />
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
    useVariableStore.setState({ values: { 'PLC:Menu/Open': false } });
    renderToggle({ bound: { $var: { path: 'PLC:Menu/Open' } } });

    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    expect(btn).toHaveTextContent('☰');
    expect(btn.className).not.toContain('hmi-menu-toggle--unknown');
  });

  it('reads as unknown before the bound value arrives, and runs its actions without a write', async () => {
    const user = userEvent.setup();
    renderToggle({
      bound: { $var: { path: 'PLC:Menu/Open' } },
      actions: {
        onPress: [{ type: 'toggleDataVariable', target: { $var: { path: 'PLC:Other' } } }],
      },
    });

    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-pressed', 'mixed');
    expect(btn.className).toContain('hmi-menu-toggle--unknown');
    expect(btn).toHaveTextContent('☰');

    await user.click(btn);
    const frames = vi.mocked(sendWsMessage).mock.calls.map((c) => c[0] as { type: string });
    expect(frames.map((f) => f.type)).toEqual(['toggle_field']);
  });

  it('reads an unset bound state as its declared default, not as unknown', () => {
    for (const properties of [{}, { bound: null }]) {
      const { unmount } = renderToggle(properties);
      const btn = screen.getByRole('button');
      expect(btn).toHaveAttribute('aria-pressed', 'false');
      expect(btn.className).not.toContain('hmi-menu-toggle--unknown');
      unmount();
    }
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

  it('draws a custom SVG icon as a mask, without inserting its markup', () => {
    renderToggle({ bound: false, iconCollapsed: '/assets/icons/menu.svg' });

    const box = screen.getByRole('button').querySelector<HTMLElement>('.hmi-menu-toggle__svg')!;
    expect(box.style.getPropertyValue('--hmi-menu-toggle-icon-url')).toBe(
      'url("/assets/icons/menu.svg")',
    );
    expect(box.childNodes).toHaveLength(0);
  });

  // The value can come from a String tag any client may write over /ws.
  it('draws an empty box, not the text, for a path that leaves the icons folder', () => {
    const escape = '/assets/icons/../../api/historian/query?variables=%3Csvg%3E';
    useVariableStore.setState({ values: { 'PLC:Icon': escape } });
    renderToggle({ bound: false, iconCollapsed: { $var: { path: 'PLC:Icon' } } });

    const btn = screen.getByRole('button');
    const box = btn.querySelector<HTMLElement>('.hmi-menu-toggle__svg')!;
    expect(box.style.getPropertyValue('--hmi-menu-toggle-icon-url')).toBe('');
    expect(box.childNodes).toHaveLength(0);
    expect(btn).not.toHaveTextContent(escape);
  });
});
