import '../../testSdk';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useComponentPropStore } from '@hmi/store/widgetPropStore';
import { useVariableStore } from '@hmi/store/variableStore';
import { useTranslationStore } from '@shared/store/translationStore';
import { sendWsMessage } from '@hmi/hooks/useWebSocket';
import { __resetForTests } from '@hmi/utils/actionDispatcher';
import DataGrid from './index';

vi.mock('@hmi/hooks/useWebSocket', () => ({
  sendWsMessage: vi.fn(),
}));

// jsdom lays nothing out: give the scrolled body 400px and the header (which
// sizes every row) 40px, so the virtualizer has a window to fill.
const BODY = 400;
const ROW = 40;
const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
const scrollTo = vi.fn();
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('hmi-datagrid__body')) return BODY;
      if (this.classList.contains('hmi-datagrid__head')) return ROW;
      return 0;
    },
  });
  // The virtualizer clamps a scroll to scrollHeight - clientHeight.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('hmi-datagrid__body') ? 500 * ROW : 0;
    },
  });
  Element.prototype.scrollTo = scrollTo as never;
});
afterAll(() => {
  if (offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight);
  delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
});

const RECIPES = Array.from({ length: 500 }, (_, i) => ({
  nId: i,
  sName: i % 10 === 3 ? `Krat ${i}` : i % 10 === 7 ? `Doos ${i}` : '',
}));

function renderGrid(properties: Record<string, unknown>, id = 'grid') {
  return render(
    <MemoryRouter>
      <DataGrid id={id} properties={properties} />
    </MemoryRouter>,
  );
}

function cellTexts(column: number): string[] {
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('gridcell')[column].textContent ?? '');
}

describe('DataGrid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTests();
    useVariableStore.setState({ values: {}, varMeta: {} });
    useComponentPropStore.setState({ props: {} });
  });

  it('keeps only the rows in view in the DOM', () => {
    renderGrid({ items: RECIPES, columns: [{ member: 'nId' }, { member: 'sName' }] });

    const drawn = screen.getAllByRole('row').length - 1;
    expect(drawn).toBeGreaterThan(BODY / ROW - 1);
    expect(drawn).toBeLessThan(40);
    expect(screen.getByRole('grid')).toHaveAttribute('aria-rowcount', '501');
  });

  it('titles a column from a translation and shows a column per member when none are listed', () => {
    useTranslationStore.setState({
      translations: { 'col.name': { nl: 'Naam' } },
      activeLanguage: 'nl',
    } as never);
    const { unmount } = renderGrid({
      items: RECIPES.slice(0, 2),
      columns: [{ member: 'sName', title: { $loc: 'col.name' }, width: '80px' }, { member: 'nId' }],
    });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Naam', 'nId']);
    unmount();

    renderGrid({ items: RECIPES.slice(0, 2) });
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['nId', 'sName']);
  });

  it('filters on contains, ignoring case, and hides the rows with an empty member', () => {
    renderGrid({
      items: RECIPES.slice(0, 40),
      columns: [{ member: 'nId' }, { member: 'sName' }],
      filterMember: 'sName',
      filterValue: 'KRAT',
      hideEmpty: 'sName',
    });
    expect(cellTexts(1)).toEqual(['Krat 3', 'Krat 13', 'Krat 23', 'Krat 33']);
  });

  it('sorts on the default column, and a header click sorts on that one, twice reversing it', async () => {
    const user = userEvent.setup();
    renderGrid({
      items: [
        { nId: 10, sName: 'b' },
        { nId: 2, sName: 'c' },
        { nId: 33, sName: 'a' },
      ],
      columns: [{ member: 'nId' }, { member: 'sName' }],
      sortMember: 'nId',
      sortDirection: 'descending',
    });
    expect(cellTexts(0)).toEqual(['33', '10', '2']);

    await user.click(screen.getByRole('button', { name: 'sName' }));
    expect(cellTexts(1)).toEqual(['a', 'b', 'c']);
    await user.click(screen.getByRole('button', { name: /sName/ }));
    expect(cellTexts(1)).toEqual(['c', 'b', 'a']);
  });

  it('publishes the chosen row and runs On Select with that row as Repeat item', async () => {
    const user = userEvent.setup();
    const items = [
      { nId: 7, sName: 'Krat' },
      { nId: 12, sName: 'Doos' },
    ];
    renderGrid({
      items,
      valueMember: 'nId',
      onSelect: {
        onSelect: [
          {
            type: 'writeDataVariable',
            target: { $var: { path: 'PLC:Recipe/sName' } },
            value: { $repeatItem: { field: 'value', member: 'sName' } },
          },
        ],
      },
    });

    await user.click(screen.getByText('Doos'));

    expect(useComponentPropStore.getState().props.grid).toMatchObject({
      selectedIndex: 1,
      selectedValue: 12,
      selectedItem: items[1],
    });
    expect(screen.getAllByRole('row')[2]).toHaveAttribute('aria-selected', 'true');
    expect(sendWsMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'write_field',
        datasource: 'PLC',
        path: 'Recipe/sName',
        value: 'Doos',
      }),
    );
  });

  it('selects the row a bound value names and scrolls it into view', () => {
    useVariableStore.setState({ values: { 'PLC:Recipe/nActive': 5 } });
    renderGrid({
      items: RECIPES,
      valueMember: 'nId',
      selectedValue: { $var: { path: 'PLC:Recipe/nActive' } },
    });
    expect(useComponentPropStore.getState().props.grid.selectedIndex).toBe(5);

    scrollTo.mockClear();
    act(() => useVariableStore.setState({ values: { 'PLC:Recipe/nActive': 300 } }));

    expect(useComponentPropStore.getState().props.grid.selectedIndex).toBe(300);
    const top = (scrollTo.mock.calls.at(-1)?.[0] as { top: number }).top;
    expect(top).toBeGreaterThan(300 * ROW - BODY);
    expect(top).toBeLessThanOrEqual(300 * ROW);
  });
});
