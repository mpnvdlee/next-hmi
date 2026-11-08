import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ModalShell from './index';
import HeaderSearch from '../HeaderSearch';

function Stacked({ onCloseOuter }: { onCloseOuter(): void }) {
  const [inner, setInner] = useState(true);
  const [query, setQuery] = useState('motor');
  return (
    <ModalShell onClose={onCloseOuter}>
      outer
      {inner && (
        <ModalShell onClose={() => setInner(false)}>
          <HeaderSearch value={query} onChange={setQuery} />
        </ModalShell>
      )}
    </ModalShell>
  );
}

describe('ModalShell', () => {
  it('closes only the newest of two stacked shells on Escape', () => {
    const onCloseOuter = vi.fn();
    render(<Stacked onCloseOuter={onCloseOuter} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(onCloseOuter).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseOuter).toHaveBeenCalledTimes(1);
  });

  it('leaves a shell open while its search uses Escape to clear, and closes it on the next', () => {
    const onCloseOuter = vi.fn();
    render(<Stacked onCloseOuter={onCloseOuter} />);
    const search = screen.getByRole('searchbox');

    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(search).toBeInTheDocument();

    search.focus();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(onCloseOuter).not.toHaveBeenCalled();
  });
});
