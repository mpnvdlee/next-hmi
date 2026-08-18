import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useVariableStore } from '@hmi/store/variableStore';
import { HmiScopeContext } from '@hmi/context/HmiScopeContext';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import type { ShellRegionConfig } from '@shared/types/config';
import ShellRegion from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

// jsdom has no ResizeObserver — the region's auto-width measurement needs one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

function renderRegion(config: ShellRegionConfig, scope?: string) {
  const tree = (
    <MemoryRouter>
      <ShellRegion id="leftSidebar" config={config}>
        <div>Sidebar content</div>
      </ShellRegion>
    </MemoryRouter>
  );
  return render(
    scope ? <HmiScopeContext.Provider value={scope}>{tree}</HmiScopeContext.Provider> : tree,
  );
}

describe('ShellRegion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVariableStore.setState({ values: {} });
  });

  it('renders overlay content into a body-level portal with a backdrop', () => {
    renderRegion({ overlay: true, expanded: true, expandedSize: '220px' });

    expect(screen.getByText('Sidebar content')).toBeInTheDocument();
    expect(
      document.querySelector('[data-region="leftSidebar"][data-overlay="true"]'),
    ).not.toBeNull();
    expect(document.querySelector('[class*="backdrop"]')).not.toBeNull();
  });

  it('renders nothing for an overlay region that is not expanded', () => {
    const { container } = renderRegion({ overlay: true, expanded: false });

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText('Sidebar content')).not.toBeInTheDocument();
  });

  it('dismisses through the nested HmiScopeContext scope, not a hardcoded one', async () => {
    useVariableStore.setState({ values: { 'PLC:Sidebar/Expanded': true } });
    const user = userEvent.setup();
    renderRegion(
      { overlay: true, expanded: { $var: { path: 'PLC:Sidebar/Expanded' } } },
      'runtime:nested-scope',
    );

    const backdrop = document.querySelector('[class*="backdrop"]') as HTMLElement;
    await user.click(backdrop);

    expect(sendWsMessage).toHaveBeenCalledWith({
      type: 'write_field',
      scope: 'runtime:nested-scope',
      datasource: 'PLC',
      path: 'Sidebar/Expanded',
      value: false,
    });
  });

  it('renders a non-overlay region in-flow and marks it collapsed when not expanded', () => {
    const { container } = renderRegion({ defaultState: 'collapsed', collapsedSize: '0' });

    const region = container.querySelector('[data-region="leftSidebar"]');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute('data-collapsed', 'true');
  });

  it('hides the region when a bound `enabled` resolves false, and shows it when true', () => {
    useVariableStore.setState({ values: { 'PLC:Sidebar/On': false } });
    const config: ShellRegionConfig = { enabled: { $var: { path: 'PLC:Sidebar/On' } } };

    const { container, rerender } = renderRegion(config);
    expect(container.firstChild).toBeNull();

    useVariableStore.setState({ values: { 'PLC:Sidebar/On': true } });
    rerender(
      <MemoryRouter>
        <ShellRegion id="leftSidebar" config={config}>
          <div>Sidebar content</div>
        </ShellRegion>
      </MemoryRouter>,
    );
    expect(screen.getByText('Sidebar content')).toBeInTheDocument();
  });

  it('keeps an unset `enabled` enabled', () => {
    const { container } = renderRegion({});

    expect(container.querySelector('[data-region="leftSidebar"]')).not.toBeNull();
  });

  it('sizes the region from a bound `expandedSize`', () => {
    useVariableStore.setState({ values: { 'PLC:Sidebar/Width': '320px' } });
    const { container } = renderRegion({
      expandedSize: { $var: { path: 'PLC:Sidebar/Width' } },
    });

    const region = container.querySelector('[data-region="leftSidebar"]') as HTMLElement;
    expect(region.style.width).toBe('320px');
  });

  it('paints the region background from a bound `background`', () => {
    useVariableStore.setState({ values: { 'PLC:Sidebar/Bg': '#123456' } });
    const { container } = renderRegion({
      background: { $var: { path: 'PLC:Sidebar/Bg' } },
    });

    const region = container.querySelector('[data-region="leftSidebar"]') as HTMLElement;
    expect(region.style.getPropertyValue('--hmi-region-bg')).toBe('#123456');
  });
});
