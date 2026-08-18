import { render } from '@testing-library/react';
import SearchHighlight, { SearchHighlightProvider } from './index';

describe('SearchHighlight', () => {
  it('highlights every case-insensitive match while preserving the text', () => {
    const { container } = render(<SearchHighlight text="Motor motor controller" query="MOTOR" />);

    expect(container.firstElementChild).toHaveClass('cfg-search-highlight');
    const matches = [...container.querySelectorAll('mark')];
    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.textContent)).toEqual(['Motor', 'motor']);
    expect(container).toHaveTextContent('Motor motor controller');
  });

  it('uses the nearest provider query', () => {
    const { container } = render(
      <SearchHighlightProvider query="speed">
        <SearchHighlight text="Motor speed" />
      </SearchHighlightProvider>,
    );

    expect(container.querySelector('mark')).toHaveTextContent('speed');
  });

  it('highlights individual words in a multi-word query', () => {
    const { container } = render(
      <SearchHighlight text="Motor current speed" query="speed motor" />,
    );

    expect([...container.querySelectorAll('mark')].map((match) => match.textContent)).toEqual([
      'Motor',
      'speed',
    ]);
  });
});
