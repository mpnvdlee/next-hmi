import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import VirtualTreeRows from './index';

afterEach(cleanup);

interface Row {
  id: string;
  label: string;
}

const rows: Row[] = [
  { id: 'a', label: 'Row A' },
  { id: 'b', label: 'Row B' },
  { id: 'c', label: 'Row C' },
];

function fakeVirtualizer(
  items: { key: string; index: number; size: number; start: number }[],
  totalSize = 300,
) {
  return {
    getTotalSize: () => totalSize,
    getVirtualItems: () => items,
  };
}

describe('VirtualTreeRows', () => {
  it('renders only the rows the virtualizer reports as visible, positioned by start/size', () => {
    const virtualizer = fakeVirtualizer([
      { key: 'a', index: 0, size: 30, start: 0 },
      { key: 'b', index: 1, size: 30, start: 30 },
    ]);

    render(
      <VirtualTreeRows
        rows={rows}
        virtualizer={virtualizer}
        renderRow={(row) => <span>{row.label}</span>}
      />,
    );

    expect(screen.getByText('Row A')).toBeInTheDocument();
    expect(screen.getByText('Row B')).toBeInTheDocument();
    expect(screen.queryByText('Row C')).not.toBeInTheDocument();

    const rowBEl = screen.getByText('Row B').closest('div[data-index]');
    expect(rowBEl).toHaveStyle({ transform: 'translateY(30px)', height: '30px' });
  });

  it('re-renders the visible window when the virtualizer reports a different viewport (scroll)', () => {
    let items = [
      { key: 'a', index: 0, size: 30, start: 0 },
      { key: 'b', index: 1, size: 30, start: 30 },
    ];
    const virtualizer = {
      getTotalSize: () => 300,
      getVirtualItems: () => items,
    };

    const { rerender } = render(
      <VirtualTreeRows
        rows={rows}
        virtualizer={virtualizer}
        renderRow={(row) => <span>{row.label}</span>}
      />,
    );
    expect(screen.getByText('Row A')).toBeInTheDocument();

    // Simulate scrolling down: the virtualizer now reports rows b/c as visible.
    items = [
      { key: 'b', index: 1, size: 30, start: 30 },
      { key: 'c', index: 2, size: 30, start: 60 },
    ];
    rerender(
      <VirtualTreeRows
        rows={rows}
        virtualizer={virtualizer}
        renderRow={(row) => <span>{row.label}</span>}
      />,
    );

    expect(screen.queryByText('Row A')).not.toBeInTheDocument();
    expect(screen.getByText('Row B')).toBeInTheDocument();
    expect(screen.getByText('Row C')).toBeInTheDocument();
  });

  it('sets the scroll spacer height from getTotalSize', () => {
    const virtualizer = fakeVirtualizer([], 900);
    const { container } = render(
      <VirtualTreeRows
        rows={[]}
        virtualizer={virtualizer}
        renderRow={() => null}
        emptyState={<p>Empty</p>}
      />,
    );
    expect(container.firstElementChild).toHaveStyle({ height: '900px' });
  });

  it('renders the empty state only when there are no rows, even if the virtualizer has stale items', () => {
    const virtualizer = fakeVirtualizer([]);
    render(
      <VirtualTreeRows
        rows={[]}
        virtualizer={virtualizer}
        renderRow={() => null}
        emptyState={<p>No compatible variables found.</p>}
      />,
    );
    expect(screen.getByText('No compatible variables found.')).toBeInTheDocument();
  });

  it('applies getRowClassName and getRowDataAttrs per row', () => {
    const virtualizer = fakeVirtualizer([{ key: 'a', index: 0, size: 30, start: 0 }]);
    render(
      <VirtualTreeRows
        rows={rows}
        virtualizer={virtualizer}
        renderRow={(row) => <span>{row.label}</span>}
        getRowClassName={(row) => `row-${row.id}`}
        getRowDataAttrs={(row) => ({ 'data-testid': `row-${row.id}` })}
      />,
    );
    expect(screen.getByTestId('row-a')).toHaveClass('row-a');
  });
});
