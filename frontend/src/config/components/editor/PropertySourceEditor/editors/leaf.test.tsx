import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfigStore } from '@shared/store/configStore';
import { PageEditor, PageIsActiveEditor, VarEditor } from './leaf';

describe('VarEditor', () => {
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
