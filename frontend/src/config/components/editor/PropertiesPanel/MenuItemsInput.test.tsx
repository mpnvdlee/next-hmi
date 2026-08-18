import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '@shared/store/configStore';
import { usePanelExpansionStore } from '@config/store/panelExpansionStore';
import type { MenuItemConfig } from '@shared/types/config';
import MenuItemsInput from './MenuItemsInput';

// jsdom doesn't implement scrollIntoView; the custom Select's popup calls it.
Element.prototype.scrollIntoView = vi.fn();

function setupStores() {
  useConfigStore.setState({
    dialogs: [],
    pages: [
      { id: 'page1', type: 'page', title: 'Home', sections: { main: [] } },
      { id: 'page2', type: 'page', title: 'Settings Page', sections: { main: [] } },
    ],
  });
  usePanelExpansionStore.setState({ expanded: {} });
}

/** The custom `Select` is a button+portal listbox, not a native `<select>`. */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  combobox: HTMLElement,
  optionName: string,
): Promise<void> {
  await user.click(combobox);
  await user.click(screen.getByRole('option', { name: optionName }));
}

function Harness({
  initial,
  onChangeSpy,
}: {
  initial?: MenuItemConfig[];
  onChangeSpy?: (v: MenuItemConfig[]) => void;
}) {
  const [value, setValue] = useState<MenuItemConfig[] | undefined>(initial);
  return (
    <MenuItemsInput
      value={value}
      onChange={(v) => {
        onChangeSpy?.(v);
        setValue(v);
      }}
      title="Items"
      pathPrefix={['items']}
    />
  );
}

/** Top-level item rows, in order. */
function itemRows(container: HTMLElement): HTMLElement[] {
  const list = container.querySelector('.cfg-menu-items') as HTMLElement;
  return [...list.children].filter((el) =>
    el.classList.contains('cfg-field-group'),
  ) as HTMLElement[];
}

/** The add control of the outermost list (nested lists render their own). */
function addControl(container: HTMLElement): HTMLElement {
  return within(container.querySelector('.cfg-menu-items') as HTMLElement).getAllByRole(
    'combobox',
  )[0];
}

function fieldRow(row: HTMLElement, label: string): HTMLElement {
  return within(row).getByText(label).closest('.cfg-field-group') as HTMLElement;
}

const ADD_LABELS: Record<MenuItemConfig['type'], string> = {
  'page-link': 'Page Link',
  'external-link': 'External Link',
  action: 'Action',
  submenu: 'Submenu',
  'section-header': 'Section Header',
  divider: 'Divider',
};

describe('MenuItemsInput — list shell', () => {
  beforeEach(setupStores);

  it('shows the empty state until an item is added', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);

    expect(screen.getByText('No items yet')).toBeInTheDocument();

    await pick(user, addControl(container), 'Divider');
    expect(screen.queryByText('No items yet')).not.toBeInTheDocument();
  });

  it('offers every MenuItemConfig discriminator in the add menu', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await user.click(addControl(container));

    const options = screen.getAllByRole('option').map((o) => o.textContent);
    for (const label of Object.values(ADD_LABELS)) {
      expect(options).toContain(label);
    }
    // The list is portaled and inherits the trigger's width, so it carries its
    // own class to size itself to the longest variant name.
    expect(screen.getByRole('listbox')).toHaveClass('cfg-menu-items__add-popup');
  });

  it.each([
    ['page-link', { type: 'page-link', pageId: '' }],
    ['external-link', { type: 'external-link', url: '', label: '' }],
    ['action', { type: 'action', actions: [], label: '' }],
    ['submenu', { type: 'submenu', label: '', items: [] }],
    ['section-header', { type: 'section-header', label: '' }],
    ['divider', { type: 'divider' }],
  ] as [MenuItemConfig['type'], MenuItemConfig][])(
    'adds a default "%s" item with every required field present',
    async (type, expected) => {
      const onChangeSpy = vi.fn();
      const user = userEvent.setup();
      const { container } = render(<Harness onChangeSpy={onChangeSpy} />);

      await pick(user, addControl(container), ADD_LABELS[type]);
      expect(onChangeSpy).toHaveBeenCalledWith([expected]);
    },
  );

  it('removes the item whose remove button is pressed', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <Harness
        onChangeSpy={onChangeSpy}
        initial={[
          { type: 'section-header', label: 'First' },
          { type: 'divider' },
          { type: 'section-header', label: 'Last' },
        ]}
      />,
    );

    await user.click(within(itemRows(container)[1]).getByTitle('Remove item'));
    expect(onChangeSpy).toHaveBeenLastCalledWith([
      { type: 'section-header', label: 'First' },
      { type: 'section-header', label: 'Last' },
    ]);
  });

  it('keeps one item expanded at a time', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness
        initial={[
          { type: 'section-header', label: 'First' },
          { type: 'section-header', label: 'Last' },
        ]}
      />,
    );

    const [first, second] = itemRows(container);
    await user.click(within(first).getByTitle('Expand'));
    expect(within(first).getByTitle('Collapse')).toBeInTheDocument();

    await user.click(within(second).getByTitle('Expand'));
    expect(within(first).getByTitle('Expand')).toBeInTheDocument();
    expect(within(second).getByTitle('Collapse')).toBeInTheDocument();
  });
});

describe('MenuItemsInput — collapsed preview', () => {
  beforeEach(setupStores);

  it.each([
    [{ type: 'page-link', pageId: 'page2' } as MenuItemConfig, 'Page Link “Settings Page”'],
    [
      { type: 'page-link', pageId: 'page2', label: 'Config' } as MenuItemConfig,
      'Page Link “Config”',
    ],
    [
      { type: 'external-link', url: 'https://x.test', label: '' } as MenuItemConfig,
      'External Link “https://x.test”',
    ],
    [{ type: 'action', actions: [], label: 'Log out' } as MenuItemConfig, 'Action “Log out”'],
    [{ type: 'section-header', label: 'Machine' } as MenuItemConfig, 'Section Header “Machine”'],
    [{ type: 'divider' } as MenuItemConfig, 'Divider'],
    [
      { type: 'submenu', label: '', items: [{ type: 'divider' }] } as MenuItemConfig,
      'Submenu “1 item”',
    ],
  ])('names the variant and its identifying value while collapsed (%#)', (item, expected) => {
    const { container } = render(<Harness initial={[item]} />);
    const preview = itemRows(container)[0].querySelector('.cfg-field-group__preview-text');
    expect(preview).toHaveTextContent(expected);
  });

  it('drops the quoted value when nothing identifies the item beyond its variant', () => {
    const { container } = render(
      <Harness initial={[{ type: 'action', actions: [], label: '' }]} />,
    );
    const preview = itemRows(container)[0].querySelector('.cfg-field-group__preview-text');
    expect(preview).toHaveTextContent('Action');
    expect(preview?.textContent).not.toContain('“');
  });

  it('keeps the tinted variant name once expanded, dropping only the content', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Harness initial={[{ type: 'section-header', label: 'Machine' }]} />,
    );
    const row = itemRows(container)[0];
    const tint = (
      row.querySelector('.cfg-field-group__content .kw') as HTMLElement
    ).style.getPropertyValue('--option-color');

    await user.click(within(row).getByTitle('Expand'));
    const kw = row.querySelector('.cfg-field-group__content .kw') as HTMLElement;
    expect(kw).toHaveTextContent('Section Header');
    expect(kw.style.getPropertyValue('--option-color')).toBe(tint);
    expect(
      (row.querySelector('.cfg-field-group__content') as HTMLElement).textContent,
    ).not.toContain('Machine');
  });

  it('tints each variant differently so a mixed list separates by colour', () => {
    const { container } = render(
      <Harness
        initial={[
          { type: 'divider' },
          { type: 'section-header', label: 'Machine' },
          { type: 'submenu', label: 'More', items: [] },
        ]}
      />,
    );
    const tints = itemRows(container).map((row) =>
      (row.querySelector('.kw') as HTMLElement).style.getPropertyValue('--option-color'),
    );

    expect(new Set(tints).size).toBe(tints.length);
    for (const tint of tints) expect(tint).toMatch(/^var\(--cfg-source-/);
  });
});

describe('MenuItemsInput — per-variant fields', () => {
  beforeEach(setupStores);

  it('page-link: page picker, label and icon, writing pageId', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness onChangeSpy={onChangeSpy} />);
    await pick(user, addControl(container), 'Page Link');

    const row = itemRows(container)[0];
    for (const label of ['Page', 'Label', 'Icon']) {
      expect(within(row).getByText(label)).toBeInTheDocument();
    }

    await pick(user, within(fieldRow(row, 'Page')).getByRole('combobox'), 'Settings Page');
    expect(onChangeSpy).toHaveBeenLastCalledWith([{ type: 'page-link', pageId: 'page2' }]);
  });

  it('external-link: url, label, target and icon, writing the url', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness onChangeSpy={onChangeSpy} />);
    await pick(user, addControl(container), 'External Link');

    const row = itemRows(container)[0];
    for (const label of ['URL', 'Label', 'Target', 'Icon']) {
      expect(within(row).getByText(label)).toBeInTheDocument();
    }

    fireEvent.change(within(fieldRow(row, 'URL')).getByRole('textbox'), {
      target: { value: 'https://docs.test' },
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith([
      { type: 'external-link', url: 'https://docs.test', label: '' },
    ]);

    await pick(user, within(fieldRow(row, 'Target')).getByRole('combobox'), 'New tab');
    expect(onChangeSpy).toHaveBeenLastCalledWith([
      { type: 'external-link', url: 'https://docs.test', label: '', target: '_blank' },
    ]);
  });

  it('action: embeds the shared actions editor and writes into `actions`', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness onChangeSpy={onChangeSpy} />);
    await pick(user, addControl(container), 'Action');

    const row = itemRows(container)[0];
    expect(within(row).getByText('Actions')).toBeInTheDocument();

    const actionsAdd = within(
      within(row).getByText('Actions').closest('.cfg-editor-actions') as HTMLElement,
    ).getByRole('combobox');
    await pick(user, actionsAdd, 'Logout User');

    expect(onChangeSpy).toHaveBeenLastCalledWith([
      { type: 'action', label: '', actions: [{ type: 'logoutUser' }] },
    ]);
  });

  it('section-header: a heading field only', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness onChangeSpy={onChangeSpy} />);
    await pick(user, addControl(container), 'Section Header');

    const row = itemRows(container)[0];
    expect(within(row).getByText('Heading')).toBeInTheDocument();
    expect(within(row).queryByText('Icon')).not.toBeInTheDocument();

    fireEvent.change(within(fieldRow(row, 'Heading')).getByRole('textbox'), {
      target: { value: 'Machine' },
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith([{ type: 'section-header', label: 'Machine' }]);
  });

  it('divider: carries no editable fields', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    await pick(user, addControl(container), 'Divider');

    const row = itemRows(container)[0];
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(row).getByText(/separator line/)).toBeInTheDocument();
  });

  it('submenu: hosts its own nested item list', async () => {
    const onChangeSpy = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<Harness onChangeSpy={onChangeSpy} />);
    await pick(user, addControl(container), 'Submenu');

    const row = itemRows(container)[0];
    const nested = row.querySelector('.cfg-menu-items') as HTMLElement;
    expect(within(nested).getByText('No items yet')).toBeInTheDocument();

    await pick(user, within(nested).getAllByRole('combobox')[0], 'Divider');
    expect(onChangeSpy).toHaveBeenLastCalledWith([
      { type: 'submenu', label: '', items: [{ type: 'divider' }] },
    ]);

    // The nested row is a real item row with its own editors.
    fireEvent.change(within(fieldRow(row, 'Label')).getByRole('textbox'), {
      target: { value: 'Diagnostics' },
    });
    expect(onChangeSpy).toHaveBeenLastCalledWith([
      { type: 'submenu', label: 'Diagnostics', items: [{ type: 'divider' }] },
    ]);
  });
});
