import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StructSchemaNode } from '@shared/types/componentProperty';
import { StructSchemaModal } from './StructSchemaModal';

Element.prototype.scrollIntoView = vi.fn();

function table(): HTMLElement {
  return document.querySelector('.struct-schema-table') as HTMLElement;
}

function folderRow(name: string): HTMLElement {
  return screen.getByText(name).closest('[data-row-kind="folder"]') as HTMLElement;
}

describe('StructSchemaModal', () => {
  it('shows the empty hint and no fields for a blank schema', () => {
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.getByText('No fields yet — use Add above, or right-click here.'),
    ).toBeInTheDocument();
  });

  it('right-clicking the empty table adds a root-level variable via the context menu', async () => {
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.contextMenu(table());
    expect(screen.getByText('Add to schema')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Variable' }));

    expect(screen.getByText('Field')).toBeInTheDocument();
    expect(
      screen.queryByText('No fields yet — use Add above, or right-click here.'),
    ).not.toBeInTheDocument();
  });

  it('adds a root-level field from the header add control', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(screen.getByRole('option', { name: 'Folder' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onConfirm).toHaveBeenCalledWith([{ kind: 'folder', name: 'Folder', children: [] }]);
  });

  it('assigns unique sibling names to same-kind additions at the same level', async () => {
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.contextMenu(table());
    await user.click(screen.getByRole('button', { name: 'Variable' }));
    fireEvent.contextMenu(table());
    await user.click(screen.getByRole('button', { name: 'Variable' }));

    expect(screen.getByText('Field')).toBeInTheDocument();
    expect(screen.getByText('Field_1')).toBeInTheDocument();
  });

  it('adds a folder, then a nested field inside it via a right-click scoped to that folder', async () => {
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.contextMenu(table());
    await user.click(screen.getByRole('button', { name: 'Folder' }));
    expect(screen.getByText('Folder')).toBeInTheDocument();

    fireEvent.contextMenu(folderRow('Folder'));
    expect(screen.getByText('Add to "Folder"')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Variable' }));

    expect(screen.getByText('Field')).toBeInTheDocument();
  });

  it('persists a nested folder/field tree exactly on Save', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.contextMenu(table());
    await user.click(screen.getByRole('button', { name: 'Folder' }));
    fireEvent.contextMenu(folderRow('Folder'));
    await user.click(screen.getByRole('button', { name: 'Variable' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onConfirm).toHaveBeenCalledWith([
      {
        kind: 'folder',
        name: 'Folder',
        children: [{ kind: 'variable', name: 'Field', type: 'Boolean', write: false }],
      },
    ]);
  });

  it('renames a node via double-click, matching the InlineTextEdit contract', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[{ kind: 'variable', name: 'bReady', type: 'Boolean' }]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.dblClick(screen.getByText('bReady'));
    const input = screen.getByDisplayValue('bReady');
    fireEvent.change(input, { target: { value: 'bMotorReady' } });
    fireEvent.blur(input);

    expect(screen.getByText('bMotorReady')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onConfirm).toHaveBeenCalledWith([
      { kind: 'variable', name: 'bMotorReady', type: 'Boolean' },
    ]);
  });

  it("changes a variable field's data type via the type select", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[{ kind: 'variable', name: 'fSpeed', type: 'Boolean' }]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    // First combobox is the header's add control; the row's type select is next.
    await user.click(screen.getAllByRole('combobox')[1]);
    await user.click(screen.getByRole('option', { name: 'Float' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onConfirm).toHaveBeenCalledWith([{ kind: 'variable', name: 'fSpeed', type: 'Float' }]);
  });

  it('toggles write access for a variable field', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[{ kind: 'variable', name: 'fSpeed', type: 'Float', write: false }]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(
      within(screen.getByTitle('Requires write access')).getByRole('button', { name: 'Yes' }),
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onConfirm).toHaveBeenCalledWith([
      { kind: 'variable', name: 'fSpeed', type: 'Float', write: true },
    ]);
  });

  it('collapses and re-expands a folder, hiding and re-showing its nested rows', async () => {
    const user = userEvent.setup();
    const initial: StructSchemaNode[] = [
      {
        kind: 'folder',
        name: 'Limits',
        children: [{ kind: 'variable', name: 'fMin', type: 'Float' }],
      },
    ];
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={initial}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText('fMin')).toBeInTheDocument();

    await user.click(screen.getByText('Limits'));
    expect(screen.queryByText('fMin')).not.toBeInTheDocument();

    await user.click(screen.getByText('Limits'));
    expect(screen.getByText('fMin')).toBeInTheDocument();
  });

  it('deletes a nested field via its row action, leaving the parent folder intact', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const initial: StructSchemaNode[] = [
      {
        kind: 'folder',
        name: 'Limits',
        children: [
          { kind: 'variable', name: 'fMin', type: 'Float' },
          { kind: 'variable', name: 'fMax', type: 'Float' },
        ],
      },
    ];
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={initial}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    await user.click(
      screen
        .getByText('fMin')
        .closest('[data-row-kind="variable"]')!
        .querySelector('button.cfg-row-action-btn') as HTMLElement,
    );

    expect(screen.queryByText('fMin')).not.toBeInTheDocument();
    expect(screen.getByText('fMax')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onConfirm).toHaveBeenCalledWith([
      {
        kind: 'folder',
        name: 'Limits',
        children: [{ kind: 'variable', name: 'fMax', type: 'Float' }],
      },
    ]);
  });

  it('deletes a folder along with its children via the context menu', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    const initial: StructSchemaNode[] = [
      { kind: 'variable', name: 'bReady', type: 'Boolean' },
      {
        kind: 'folder',
        name: 'Limits',
        children: [{ kind: 'variable', name: 'fMin', type: 'Float' }],
      },
    ];
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={initial}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.contextMenu(folderRow('Limits'));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.queryByText('Limits')).not.toBeInTheDocument();
    expect(screen.queryByText('fMin')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onConfirm).toHaveBeenCalledWith([{ kind: 'variable', name: 'bReady', type: 'Boolean' }]);
  });

  it('adds an array node with the documented default shape', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.contextMenu(table());
    await user.click(screen.getByRole('button', { name: 'Array' }));

    expect(screen.getByText('Array')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onConfirm).toHaveBeenCalledWith([{ kind: 'array', name: 'Array', type: 'Float' }]);
  });

  it('discards all edits on Cancel without calling onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <StructSchemaModal
        propKey="motor"
        initialSchema={[]}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.contextMenu(table());
    await user.click(screen.getByRole('button', { name: 'Variable' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
