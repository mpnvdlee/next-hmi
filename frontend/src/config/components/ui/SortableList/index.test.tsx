import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SortableList, { SortableRow } from './index';

function renderList(onMove: (from: number, to: number) => void) {
  render(
    <SortableList ids={['a', 'b', 'c']} onMove={onMove}>
      {['A', 'B', 'C'].map((label, i) => (
        <SortableRow key={label} id={['a', 'b', 'c'][i]}>
          {label}
        </SortableRow>
      ))}
    </SortableList>,
  );
  return screen.getAllByTitle('Drag to reorder');
}

describe('SortableList', () => {
  it('gives every row a focusable ⋮⋮ grip', () => {
    const grips = renderList(vi.fn());
    expect(grips).toHaveLength(3);
    grips.forEach((grip) => expect(grip.tagName).toBe('BUTTON'));
  });
});
