import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '@shared/store/configStore';
import { useRecipeConfigStore } from '@config/store/recipeConfigStore';
import {
  LocEditor,
  PageEditor,
  PageIsActiveEditor,
  RecipeEditor,
  UserFieldEditor,
  VarEditor,
  ViewportEditor,
} from './leaf';
import PropRow from '../../../ui/PropRow';
import { TakesOneValueContext } from '../slotContext';
import { LocPlaceholdersContext } from '../locPlaceholdersContext';
import { loadVariableWriteDescriptor } from '@config/utils/variableType';

vi.mock('@config/utils/variableType', () => ({
  loadVariableWriteDescriptor: vi.fn(async () => undefined),
}));

describe('VarEditor', () => {
  beforeEach(() => {
    vi.mocked(loadVariableWriteDescriptor).mockReset().mockResolvedValue(undefined);
  });

  function renderValueField(value: unknown, onChange = vi.fn(), fieldType = 'Float') {
    render(
      <PropRow label="Value">
        <VarEditor value={value} onChange={onChange} fieldType={fieldType} />
      </PropRow>,
    );
    return onChange;
  }
  const valueRow = () => screen.getByText('Value').closest('.cfg-field-group') as HTMLElement;

  it('asks a whole array on a one-value field for its element in a row below the field', async () => {
    vi.mocked(loadVariableWriteDescriptor).mockResolvedValueOnce({
      dataType: 'Float',
      isArray: true,
      arrayLength: 5,
    });
    const onChange = renderValueField({ $var: { path: 'CF:Temps' } });
    // No title of its own: a hint naming the range sits above its box.
    const hint = await screen.findByText('Element of the array, 0 to 4');
    expect(screen.queryByText('Value - Index')).toBeNull();
    expect(loadVariableWriteDescriptor).toHaveBeenCalledWith('CF', 'Temps');
    // Part of the Value field, under its box rather than inside it.
    const indexRow = hint.closest('.cfg-field-group') as HTMLElement;
    expect(valueRow().contains(indexRow)).toBe(true);
    expect(valueRow().querySelector('.cfg-field-group__box')!.contains(indexRow)).toBe(false);
    const input = within(indexRow).getByPlaceholderText('Choose an element');
    fireEvent.change(input, { target: { value: '3' } });
    expect(onChange).toHaveBeenLastCalledWith({
      $var: { path: 'CF:Temps', index: { $static: 3 } },
    });
  });

  it.each([
    ['a picked element', { path: 'CF:Temps', index: 2 }, { isArray: true }],
    ['an element in the path', { path: 'CF:Temps[2]' }, { isArray: true, indexed: true }],
    ['a variable that is no array', { path: 'CF:Setpoint' }, { isArray: false }],
  ])('adds no Index row for %s', async (_, binding, descriptor) => {
    vi.mocked(loadVariableWriteDescriptor).mockResolvedValueOnce({
      dataType: 'Float',
      ...descriptor,
    });
    renderValueField({ $var: binding });
    await new Promise((r) => setTimeout(r));
    expect(screen.queryByText(/Element of the array/)).toBeNull();
  });

  it('adds no Index row on a field that takes the whole array', async () => {
    vi.mocked(loadVariableWriteDescriptor).mockResolvedValue({ dataType: 'Float', isArray: true });
    renderValueField({ $var: { path: 'CF:Temps' } }, vi.fn(), 'Float[]');
    await new Promise((r) => setTimeout(r));
    expect(screen.queryByText(/Element of the array/)).toBeNull();
  });

  it('asks an alarm-style any-type slot that takes one value for the element too', async () => {
    vi.mocked(loadVariableWriteDescriptor).mockResolvedValueOnce({
      dataType: 'Float',
      isArray: true,
    });
    render(
      <TakesOneValueContext.Provider value={true}>
        <PropRow label="{3}">
          <VarEditor value={{ $var: { path: 'CF:Temps' } }} onChange={vi.fn()} />
        </PropRow>
      </TakesOneValueContext.Provider>,
    );
    expect(await screen.findByText('Element of the array')).toBeInTheDocument();
  });

  it('shows a bound index in its row and the path without brackets; clearing it binds the whole array', () => {
    const onChange = renderValueField({
      $var: { path: 'CF:Safety/Open', index: { $static: 4 } },
    });
    expect(within(valueRow()).getByRole('textbox')).toHaveValue('CF:Safety/Open');
    const indexRow = screen
      .getByText('Element of the array')
      .closest('.cfg-field-group') as HTMLElement;
    const input = within(indexRow).getByRole('spinbutton');
    expect(input).toHaveValue(4);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ $var: { path: 'CF:Safety/Open' } });
  });

  it('keeps a bound index when the picker confirms the same array, and replaces it with a picked element', async () => {
    const onChange = vi.fn();
    const open = vi.fn();
    const bound = { $componentProp: 'device' };
    render(
      <VarEditor
        value={{ $var: { path: 'CF:Safety/Open', index: bound } }}
        onChange={onChange}
        onOpenBindingPicker={open}
      />,
    );
    await userEvent.click(screen.getByTitle('Change variable binding'));
    const [onPick, current] = open.mock.calls[0];
    expect(current).toEqual({ path: 'CF:Safety/Open' });
    onPick({ path: 'CF:Safety/Open' });
    expect(onChange).toHaveBeenLastCalledWith({ $var: { path: 'CF:Safety/Open', index: bound } });
    onPick({ path: 'CF:Safety/Open', index: 2 });
    expect(onChange).toHaveBeenLastCalledWith({ $var: { path: 'CF:Safety/Open', index: 2 } });
    onPick({ path: 'CF:Safety/Closed' });
    expect(onChange).toHaveBeenLastCalledWith({ $var: { path: 'CF:Safety/Closed' } });
  });

  it('keeps a bound index when the bare path is retyped, and drops it for a typed [n]', () => {
    const onChange = vi.fn();
    const bound = { $componentProp: 'device' };
    render(
      <VarEditor value={{ $var: { path: 'CF:Safety/Open', index: bound } }} onChange={onChange} />,
    );
    const input = screen.getAllByRole('textbox')[0];
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'CF:Safety/Closed' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ $var: { path: 'CF:Safety/Closed', index: bound } });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'CF:Safety/Open[5]' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ $var: { path: 'CF:Safety/Open', index: 5 } });
  });

  it('shows the composite path with index suffix', () => {
    render(
      <VarEditor value={{ $var: { path: 'PLC:Motor1/Speed', index: 2 } }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole('textbox')).toHaveValue('PLC:Motor1/Speed[2]');
  });

  it('commits a typed path on blur, parsing a trailing [n] into index', () => {
    const onChange = vi.fn();
    render(<VarEditor value={{ $var: { path: '' } }} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'PLC:Tank1/Level[3]' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ $var: { path: 'PLC:Tank1/Level', index: 3 } });
  });

  it('commits a plain path with no index on Enter', () => {
    const onChange = vi.fn();
    render(<VarEditor value={{ $var: { path: '' } }} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'PLC:Tank1/Level' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith({ $var: { path: 'PLC:Tank1/Level' } });
  });

  it('reverts to the pre-focus value on Escape without committing', () => {
    const onChange = vi.fn();
    render(<VarEditor value={{ $var: { path: 'PLC:Motor1/Speed' } }} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'garbage' } });
    // Escape's handler calls .blur() itself, synchronously firing onBlur
    // before the revert's setDraft has flushed — exercise that real chain
    // in one dispatch rather than firing blur as a separate event.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('PLC:Motor1/Speed');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not call onChange when the committed text is unchanged', () => {
    const onChange = vi.fn();
    render(
      <VarEditor value={{ $var: { path: 'PLC:Motor1/Speed', index: 1 } }} onChange={onChange} />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clicking Clear while the input is focused does not first commit the stale draft', () => {
    const onChange = vi.fn();
    render(
      <VarEditor
        value={{ $var: { path: 'PLC:Motor1/Speed' } }}
        onChange={onChange}
        onOpenBindingPicker={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'garbage' } });
    const clearBtn = screen.getByRole('button', { name: 'Clear' });
    // Mousedown on Clear blurs the still-focused input synchronously in a real
    // browser, before Clear's own click fires — reproduce that ordering.
    fireEvent.mouseDown(clearBtn);
    fireEvent.blur(input);
    fireEvent.click(clearBtn);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('opens the binding picker via the ✎ button', () => {
    const onOpenBindingPicker = vi.fn();
    render(
      <VarEditor
        value={{ $var: { path: 'PLC:Motor1/Speed' } }}
        onChange={vi.fn()}
        onOpenBindingPicker={onOpenBindingPicker}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change variable binding' }));
    expect(onOpenBindingPicker).toHaveBeenCalled();
  });
});

describe('page pickers', () => {
  const page = (id: string, title: string) => ({
    id,
    type: 'page' as const,
    title,
    sections: { content: [] },
  });

  // jsdom has no layout, so the popup's scroll-into-view call needs a stub.
  Element.prototype.scrollIntoView = vi.fn();

  beforeEach(() => {
    useConfigStore.setState({
      pages: [page('home', 'Home')],
      dialogs: [page('motor-detail', 'Motor detail')],
    });
  });

  it('$page offers a Dialogs-folder page, whose title and path it can read', async () => {
    render(<PageEditor value={{ $page: { field: 'title' } }} onChange={vi.fn()} />);
    await userEvent.click(screen.getAllByRole('combobox')[1]);

    expect(screen.getAllByRole('option').map((o) => o.textContent)).toContain('Motor detail');
  });

  it('$pageIsActive leaves out a Dialogs-folder page, which is never the active route', async () => {
    render(<PageIsActiveEditor value={{ $pageIsActive: {} }} onChange={vi.fn()} />);
    await userEvent.click(screen.getByRole('combobox'));

    expect(screen.getAllByRole('option').map((o) => o.textContent)).not.toContain('Motor detail');
  });
});

describe('field choices that fit the field', () => {
  Element.prototype.scrollIntoView = vi.fn();

  async function fieldOptions(): Promise<string[]> {
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    return screen.getAllByRole('option').map((o) => o.textContent ?? '');
  }

  it('lists only the page fields an Integer field takes', async () => {
    render(
      <PageEditor value={{ $page: { field: 'depth' } }} onChange={vi.fn()} fieldType="Integer" />,
    );
    expect(await fieldOptions()).toEqual(['Depth']);
  });

  it('keeps a stored choice that does not fit, marked', async () => {
    render(
      <PageEditor value={{ $page: { field: 'title' } }} onChange={vi.fn()} fieldType="Integer" />,
    );
    expect(await fieldOptions()).toEqual(['Title (does not fit this field)', 'Depth']);
  });

  it('lists the page fields any type of a union field takes', async () => {
    render(
      <PageEditor
        value={{ $page: { field: 'depth' } }}
        onChange={vi.fn()}
        fieldType={['Float', 'Integer']}
      />,
    );
    expect(await fieldOptions()).toEqual(['Depth']);
  });

  it('lists every choice for a slot that takes any type', async () => {
    render(<ViewportEditor value={{ $viewport: { field: 'size' } }} onChange={vi.fn()} />);
    expect(await fieldOptions()).toHaveLength(4);
  });

  it('lists the number-valued viewport fields for an Integer field', async () => {
    render(
      <ViewportEditor
        value={{ $viewport: { field: 'width' } }}
        onChange={vi.fn()}
        fieldType="integer"
      />,
    );
    expect(await fieldOptions()).toEqual(['Width (px)', 'Height (px)']);
  });

  it('lists the boolean recipe fields for a Boolean field', async () => {
    useRecipeConfigStore.setState({ load: async () => {} });
    render(
      <RecipeEditor
        value={{ $recipe: { type: '', field: 'loaded' } }}
        onChange={vi.fn()}
        fieldType="Boolean"
      />,
    );
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Is loaded',
      'Parameters changed',
      'Saved value of a parameter',
      'Parameter changed',
    ]);
  });

  it('lists the user list on a String field, which joins the names', async () => {
    render(
      <UserFieldEditor
        value={{ $user: { field: 'username' } }}
        onChange={vi.fn()}
        fieldType="String"
      />,
    );
    expect(await fieldOptions()).toEqual(['username', 'groups', 'User list']);
  });
});

describe('LocEditor', () => {
  const value = { $loc: { key: 'Tank {1} of {2}', wildcards: { 1: 'A' } } };

  it('opens one field per placeholder of the picked translation', () => {
    render(<LocEditor value={value} onChange={vi.fn()} />);

    expect(screen.getByText('Value for {1}')).toBeInTheDocument();
    expect(screen.getByText('Value for {2}')).toBeInTheDocument();
  });

  it('leaves the placeholders to the alarm where an alarm fills them', () => {
    render(
      <LocPlaceholdersContext.Provider value={false}>
        <LocEditor value={value} onChange={vi.fn()} />
      </LocPlaceholdersContext.Provider>,
    );

    expect(screen.queryByText('Value for {1}')).not.toBeInTheDocument();
  });
});
