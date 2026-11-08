import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ItemListInput from './ItemListInput';

describe('ItemListInput', () => {
  it('opens records with fields of their own as JSON and saves a valid list', () => {
    const onChange = vi.fn();
    render(<ItemListInput value={[{ x: 0.1, y: 0.2, side: 'top' }]} onChange={onChange} />);

    const text = screen.getByRole('textbox');
    fireEvent.change(text, { target: { value: '[{"x": 0.5, "y": 0.5, "device": 3}]' } });

    expect(onChange).toHaveBeenCalledWith([{ x: 0.5, y: 0.5, device: 3 }]);
  });

  it('keeps what does not parse as a list out of the property', () => {
    const onChange = vi.fn();
    render(<ItemListInput value={[{ x: 0.1, y: 0.2 }]} onChange={onChange} />);

    const text = screen.getByRole('textbox');
    fireEvent.change(text, { target: { value: '[{"x": 0.5,' } });
    fireEvent.change(text, { target: { value: '{"x": 0.5}' } });

    expect(onChange).not.toHaveBeenCalled();
    expect(text).toHaveValue('{"x": 0.5}');
    expect(screen.getByText(/not a JSON list/)).toBeInTheDocument();
  });

  it('opens label / value rows as rows, and switches to JSON on request', () => {
    render(<ItemListInput value={[{ label: 'Auto', value: 'auto' }]} onChange={vi.fn()} />);

    expect(screen.getByText('Auto')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Edit as JSON'));
    expect(screen.getByRole('textbox')).toHaveValue(
      JSON.stringify([{ label: 'Auto', value: 'auto' }], null, 2),
    );
  });

  it('lists Data Grid columns one line each by name, reorders and opens them like options', () => {
    const onChange = vi.fn();
    const columns = [
      { member: 'nId', title: 'Id' },
      { member: 'sName', title: { $var: 'Plant:Label' } },
      { member: 'nSize', title: 'Stuks' },
    ];
    render(<ItemListInput columns value={columns} onChange={onChange} />);

    // The title, else the member; nothing marks the title's source.
    const lines = screen.getAllByTitle('Edit column');
    expect(lines.map((l) => l.textContent)).toEqual(['Id', 'sName', 'Stuks']);
    expect(document.querySelector('.cfg-panel-list .cfg-property-source-badge')).toBeNull();
    expect(screen.getAllByTitle('Drag to reorder')).toHaveLength(3);

    fireEvent.click(lines[2]);
    const open = document.querySelectorAll(
      '.cfg-list-drawer .cfg-sortable-row__body > .cfg-field-group > .cfg-field-group__box > .cfg-field-group__nest',
    );
    expect(open).toHaveLength(1);
    expect(open[0].querySelector('input')).toHaveValue('nSize');
  });

  it('adds a column from the field header and opens it in the drawer', () => {
    const onChange = vi.fn();
    render(<ItemListInput columns value={[]} onChange={onChange} />);

    expect(screen.getByText('A column per member')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Add column'));
    expect(onChange).toHaveBeenLastCalledWith([{ member: '' }]);
    expect(document.querySelector('.cfg-list-drawer')).not.toBeNull();
  });

  it('names a column with no member or title yet New column, muted', () => {
    render(<ItemListInput columns value={[{ member: '' }]} onChange={vi.fn()} />);
    const line = screen.getByTitle('Edit column');
    expect(line).toHaveTextContent('New column');
    expect(within(line).getByText('New column')).toHaveClass('cfg-list-drawer__meta');
  });

  it('edits Data Grid columns as rows in a drawer', () => {
    const onChange = vi.fn();
    const columns = [
      { member: 'nId', title: 'Id', width: '60px', align: 'right' },
      { member: 'sName', title: { $loc: 'recipe.name' } },
    ];
    render(
      <ItemListInput
        columns
        value={columns}
        onChange={onChange}
        rows={[{ nId: 1, sName: 'a', nSize: 2 }]}
      />,
    );

    expect(screen.getAllByTitle('Edit column').map((l) => l.textContent)).toEqual([
      'Id',
      'recipe.name',
    ]);
    fireEvent.click(screen.getByTitle('Expand in drawer'));

    // ⤢ opens every column collapsed to its line; a click on a line opens it.
    const nests = '.cfg-list-drawer .cfg-field-group__nest';
    expect(document.querySelectorAll(nests)).toHaveLength(0);
    expect(document.querySelector('.cfg-list-drawer')).toHaveTextContent('1 Id · 60px · right');
    screen.getAllByTitle('Expand').forEach((chevron) => fireEvent.click(chevron));
    expect(document.querySelectorAll(nests)).toHaveLength(2);

    // The member is picked from the rows' members.
    // jsdom has no scrollIntoView; the Select popup calls it on its active option.
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(screen.getAllByRole('combobox')[0]);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'nId',
      'sName',
      'nSize',
    ]);
    expect(screen.getByDisplayValue('60')).toBeInTheDocument();

    // Fixed hands the second column a width; Fill takes the first one's away.
    fireEvent.click(screen.getAllByText('Fixed')[1]);
    expect(onChange).toHaveBeenLastCalledWith([columns[0], { ...columns[1], width: '100px' }]);
    fireEvent.click(screen.getAllByText('Fill')[0]);
    expect(onChange).toHaveBeenLastCalledWith([{ ...columns[0], width: undefined }, columns[1]]);

    fireEvent.click(screen.getByText('+ Add column'));
    expect(onChange).toHaveBeenLastCalledWith([...columns, { member: '' }]);
  });
});
