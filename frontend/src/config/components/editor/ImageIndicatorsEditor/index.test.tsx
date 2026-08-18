import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ImageIndicator } from '@shared/types/config';
import ImageIndicatorsEditor from './index';

// jsdom doesn't implement pointer capture; the drag handlers call it unconditionally.
Element.prototype.setPointerCapture = vi.fn();

function mockContainerRect() {
  const container = document.querySelector('.cfg-ind-image-area') as HTMLElement;
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 200,
    height: 100,
    right: 200,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON() {},
  } as DOMRect);
  return container;
}

describe('ImageIndicatorsEditor', () => {
  it('shows the no-image hint and empty state, and stays closed until opened', () => {
    render(<ImageIndicatorsEditor value={[]} src={undefined} onChange={vi.fn()} />);
    expect(screen.queryByText('Edit Indicators')).not.toBeInTheDocument();
  });

  it('opens the modal showing the missing-image hint and empty indicator list', async () => {
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={[]} src={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));

    expect(screen.getByText('Edit Indicators')).toBeInTheDocument();
    expect(screen.getByText('Image not set — cannot preview')).toBeInTheDocument();
    expect(screen.getByText(/No indicators yet/)).toBeInTheDocument();
  });

  it('adds a new indicator with the documented defaults and persists it on Save', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={[]} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    await user.click(screen.getByRole('button', { name: '+ Add' }));
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(onChange).toHaveBeenCalledWith([
      { id: 'indicator', label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
    ]);
  });

  it('discards edits on Cancel without calling onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={[]} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    await user.click(screen.getByRole('button', { name: '+ Add' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText('Edit Indicators')).not.toBeInTheDocument();
  });

  it('re-opens from the persisted value, not a stale draft, after a cancelled edit', async () => {
    const existing: ImageIndicator[] = [
      { id: 'a', label: 'A', x: 0.2, y: 0.3, rx: 0.4, ry: 0.4, rSize: 12 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    await user.click(screen.getByRole('button', { name: '+ Add' }));
    expect(screen.getByText('2')).toBeInTheDocument(); // sidebar count
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('updates the label field of the selected indicator', async () => {
    const onChange = vi.fn();
    const existing: ImageIndicator[] = [
      { id: 'a', label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    await user.type(screen.getByPlaceholderText('A, 1…'), 'X1');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'a', label: 'X1' })]);
  });

  it('clamps a typed size into the 1-50%% range', async () => {
    const onChange = vi.fn();
    const existing: ImageIndicator[] = [
      { id: 'a', label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    const sizeInput = screen.getByTitle('Red circle size (% of image)');
    await user.clear(sizeInput);
    await user.type(sizeInput, '99');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'a', rSize: 50 })]);
  });

  it('removes an indicator from the sidebar list', async () => {
    const onChange = vi.fn();
    const existing: ImageIndicator[] = [
      { id: 'a', label: 'A', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
      { id: 'b', label: 'B', x: 0.1, y: 0.1, rx: 0.2, ry: 0.2, rSize: 8 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    await user.click(screen.getAllByTitle('Remove')[0]);
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'b' })]);
  });

  it('drags the black circle marker to a new position and persists it on Save', async () => {
    const onChange = vi.fn();
    const existing: ImageIndicator[] = [
      { id: 'a', label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    const container = mockContainerRect();

    const circle = screen.getByTitle('Circle: (no label)');
    fireEvent.pointerDown(circle, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(container, { clientX: 150, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(container, { clientX: 150, clientY: 60, pointerId: 1 });

    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'a', x: 0.75, y: 0.6 })]);
  });

  it('drags the red dashed size marker independently of the black circle', async () => {
    const onChange = vi.fn();
    const existing: ImageIndicator[] = [
      { id: 'a', label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    const container = mockContainerRect();

    const pill = screen.getByTitle('Red circle: (no label)');
    fireEvent.pointerDown(pill, { clientX: 100, clientY: 50, pointerId: 2 });
    fireEvent.pointerMove(container, { clientX: 20, clientY: 90, pointerId: 2 });
    fireEvent.pointerUp(container, { clientX: 20, clientY: 90, pointerId: 2 });

    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    const saved = onChange.mock.calls[0][0][0] as ImageIndicator;
    expect(saved.x).toBe(0.5); // black circle (x/y) untouched
    expect(saved.y).toBe(0.5);
    expect(saved.rx).toBe(0.1);
    expect(saved.ry).toBe(0.9);
  });

  it('clamps a drag past the image edges to 0..1', async () => {
    const onChange = vi.fn();
    const existing: ImageIndicator[] = [
      { id: 'a', label: '', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));
    const container = mockContainerRect();

    const circle = screen.getByTitle('Circle: (no label)');
    fireEvent.pointerDown(circle, { clientX: 0, clientY: 0, pointerId: 3 });
    fireEvent.pointerMove(container, { clientX: -50, clientY: 500, pointerId: 3 });
    fireEvent.pointerUp(container, { clientX: -50, clientY: 500, pointerId: 3 });

    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'a', x: 0, y: 1 })]);
  });

  it('selects a row from the sidebar list and highlights its match', async () => {
    const existing: ImageIndicator[] = [
      { id: 'a', label: 'A', x: 0.5, y: 0.5, rx: 0.56, ry: 0.56, rSize: 10 },
      { id: 'b', label: 'B', x: 0.1, y: 0.1, rx: 0.2, ry: 0.2, rSize: 8 },
    ];
    const user = userEvent.setup();
    render(<ImageIndicatorsEditor value={existing} src={undefined} onChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit indicators…' }));

    const rowB = screen.getByDisplayValue('B').closest('.cfg-marker-row') as HTMLElement;
    await user.click(rowB);
    expect(rowB).toHaveClass('cfg-marker-row--selected');
  });
});
