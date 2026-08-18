import { useState, type CSSProperties } from 'react';
import useCommittableDraft from '@config/hooks/useCommittableDraft';
import SearchHighlight from './SearchHighlight';

interface Props {
  /** Committed text. The control free-types over it. */
  value: string;
  /** Receives the raw typed text on blur/Enter — never per keystroke. */
  onCommit: (text: string) => void;
  placeholder?: string;
}

/**
 * A compact table-cell text field that still shows search matches.
 *
 * An `<input>` cannot carry a `<mark>`, so a ghost copy of the same text sits
 * behind it — transparent, highlighted, and scrolled in step with the real one
 * so the marks stay under their characters on a value wider than the cell.
 * Commit behaviour is `TextField`'s: draft while focused, commit on blur/Enter.
 */
export default function HighlightedInput({ value, onCommit, placeholder }: Props) {
  const [scrollLeft, setScrollLeft] = useState(0);
  const { draft, inputProps } = useCommittableDraft(value, onCommit);

  return (
    <span className="cfg-highlight-input">
      <span className="cfg-highlight-input__text" aria-hidden="true">
        <span
          className="cfg-highlight-input__text-content"
          style={{ '--highlight-scroll': `${scrollLeft}px` } as CSSProperties}
        >
          <SearchHighlight text={draft} />
        </span>
      </span>
      <input
        className="cfg-prop-input cfg-prop-input--compact cfg-highlight-input__input"
        type="text"
        placeholder={placeholder}
        {...inputProps}
        onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
      />
    </span>
  );
}
