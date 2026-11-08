import '../../testSdk';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useHmiStore } from '@hmi/store/hmiStore';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import { useTranslationStore } from '@shared/store/translationStore';
import { useVariableStore } from '@hmi/store/variableStore';
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
    useHmiStore.setState({ openPageOverlays: [], pendingToasts: [] });
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

  it('lists the options another widget exports', async () => {
    const user = userEvent.setup();
    useComponentPropStore.setState({ props: { source: { units: OPTIONS } } });
    renderDropdown({ options: { $widgetProp: { componentId: 'source', property: 'units' } } });

    await user.click(screen.getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Fahrenheit' })).toBeInTheDocument();
  });

  it('matches a fractional selection against the option values, not its decimal-comma text', () => {
    renderDropdown({ options: [{ label: 'Half', value: 1.5 }], selectedValue: 1.5 });

    expect(screen.getByRole('combobox')).toHaveTextContent('Half');
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
      onChange: { onChange: [{ type: 'openPageOverlay', pageId: 'units-help' }] },
    });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Celsius' }));

    expect(useHmiStore.getState().openPageOverlays.map((o) => o.pageId)).toContain('units-help');
  });

  it('shows a translated option label in the active language', async () => {
    const user = userEvent.setup();
    useTranslationStore.setState({
      translations: { 'pack.tray': { nl: 'Schoudertray' } },
      activeLanguage: 'nl',
    } as never);
    renderDropdown({ options: [{ label: { $loc: 'pack.tray' }, value: 1 }], selectedValue: '1' });

    expect(screen.getByRole('combobox')).toHaveTextContent('Schoudertray');
    await user.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: 'Schoudertray' })).toBeInTheDocument();
  });

  it('offers the options up to and including Max index', async () => {
    const user = userEvent.setup();
    useVariableStore.setState({ values: { 'PLC:nMax': 1 } });
    const patterns = ['A', 'B', 'C', 'D'].map((p, i) => ({ label: `Pattern ${p}`, value: i }));
    renderDropdown({ options: patterns, maxIndex: { $var: { path: 'PLC:nMax' } } });

    await user.click(screen.getByRole('combobox'));

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '—',
      'Pattern A',
      'Pattern B',
    ]);
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

  // The actions ran before the selection was published, so they read the one
  // before; and the value went out as text, which no Integer field takes.
  it('runs On Change with the option just picked, as its own value', async () => {
    const user = userEvent.setup();
    renderDropdown({
      options: [
        { label: 'One', value: 1 },
        { label: 'Two', value: 2 },
      ],
      onChange: {
        onChange: [
          {
            type: 'writeDataVariable',
            target: { $var: { path: 'PLC:Mode' } },
            value: { $widgetProp: { componentId: 'units', property: 'selectedValue' } },
          },
        ],
      },
    });

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'Two' }));

    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'write_field', path: 'Mode', value: 2 }),
    );
    expect(useComponentPropStore.getState().props.units.selectedValue).toBe(2);
  });

  it('selects the option matching an Integer tag bound to Selected value', () => {
    useVariableStore.setState({ values: { 'PLC:Mode': 2 } });
    renderDropdown({
      options: [
        { label: 'One', value: 1 },
        { label: 'Two', value: 2 },
      ],
      selectedValue: { $var: { path: 'PLC:Mode' } },
    });
    expect(screen.getByRole('combobox')).toHaveTextContent('Two');

    act(() => useVariableStore.setState({ values: { 'PLC:Mode': 1 } }));
    expect(screen.getByRole('combobox')).toHaveTextContent('One');
    expect(useComponentPropStore.getState().props.units.selectedValue).toBe(1);
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
