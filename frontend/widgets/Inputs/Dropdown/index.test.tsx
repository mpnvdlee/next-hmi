import '../../testSdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import Dropdown from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

// jsdom doesn't implement scrollIntoView; the popup's active-option effect calls it.
Element.prototype.scrollIntoView = vi.fn();

const OPTIONS = [
  { label: 'Celsius', value: 'C' },
  { label: 'Fahrenheit', value: 'F' },
];

function renderDropdown(properties: Record<string, unknown>, id = 'units') {
  return render(
    <MemoryRouter>
      <Dropdown id={id} properties={properties} />
    </MemoryRouter>,
  );
}

describe('Dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useHmiStore.setState({ openDialogs: [], pendingToasts: [] });
    useComponentPropStore.setState({ props: {} });
  });

  afterEach(() => {
    __resetForTests();
  });

  it('renders with no properties at all', () => {
    const { container } = renderDropdown({});
    const el = container.firstElementChild as HTMLElement;

    expect(el.className).toContain('hmi-component');
    expect(el.className).toContain('hmi-dropdown');
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('publishes the chosen option as its `selectedValue` export', async () => {
    const user = userEvent.setup();
    renderDropdown({ options: OPTIONS });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Fahrenheit' }));

    expect(useComponentPropStore.getState().props.units.selectedValue).toBe('F');
    expect(screen.getByRole('combobox')).toHaveTextContent('Fahrenheit');
  });

  it('publishes the configured initial selection', () => {
    renderDropdown({ options: OPTIONS, selectedValue: 'C' });

    expect(useComponentPropStore.getState().props.units.selectedValue).toBe('C');
  });

  it('never writes a variable — selection is its only output', async () => {
    const user = userEvent.setup();
    renderDropdown({ options: OPTIONS });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Celsius' }));

    expect(sendWsMessage).not.toHaveBeenCalled();
  });

  it('runs the onChange actions when the selection changes', async () => {
    const user = userEvent.setup();
    renderDropdown({
      options: OPTIONS,
      onChange: { onChange: [{ type: 'openDialog', dialogId: 'units-help' }] },
    });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Celsius' }));

    expect(useHmiStore.getState().openDialogs.map((d) => d.id)).toContain('units-help');
  });

  it('drops a selection the options list no longer offers', () => {
    const { rerender } = renderDropdown({ options: OPTIONS, selectedValue: 'F' });
    expect(useComponentPropStore.getState().props.units.selectedValue).toBe('F');

    rerender(
      <MemoryRouter>
        <Dropdown id="units" properties={{ options: [OPTIONS[0]], selectedValue: 'F' }} />
      </MemoryRouter>,
    );

    expect(useComponentPropStore.getState().props.units.selectedValue).toBe('');
  });

  it('emits the popup geometry as custom properties the stylesheet consumes', async () => {
    const user = userEvent.setup();
    renderDropdown({ options: OPTIONS });

    await user.click(screen.getByRole('combobox'));

    const popup = screen.getByRole('listbox');
    expect(popup.className).toContain('hmi-dropdown__popup--below');
    expect(popup.style.getPropertyValue('--hmi-dropdown-popup-max-height')).toBe('320px');
    expect(popup.style.getPropertyValue('--hmi-dropdown-popup-top')).toBe('2px');
  });

  // Enter on an index with no option behind it used to bail out before closing,
  // leaving the popup stranded over the page.
  it('closes on Enter when the active index no longer resolves to an option', async () => {
    const user = userEvent.setup();
    const { rerender } = renderDropdown({ options: OPTIONS });

    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    rerender(
      <MemoryRouter>
        <Dropdown id="units" properties={{ options: [OPTIONS[0]] }} />
      </MemoryRouter>,
    );

    await user.keyboard('{Enter}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(useComponentPropStore.getState().props.units.selectedValue).toBe('');
  });

  it('stays closed while disabled', async () => {
    const user = userEvent.setup();
    renderDropdown({ options: OPTIONS, disabled: true });

    await user.click(screen.getByRole('combobox'));

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
