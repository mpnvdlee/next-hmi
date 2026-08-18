/**
 * TreeSearchBar — the toolbar above a config tree sidebar.
 *
 * Pairs the shared search field with the collapse-all button, so the page tree
 * and the component tree get the same bar without repeating it.
 */

import { ArrowsInLineVertical } from '@phosphor-icons/react';
import HeaderSearch from '../HeaderSearch';

interface TreeSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  /** Accessible name of the field — each tree names what it searches. */
  label: string;
  placeholder?: string;
  /** Suspends the `/` shortcut while an overlay owns the key. */
  shortcutDisabled?: boolean;
  /** Renders the collapse-all button when given. */
  onCollapseAll?: () => void;
}

export default function TreeSearchBar({
  value,
  onChange,
  label,
  placeholder = 'Search tree',
  shortcutDisabled,
  onCollapseAll,
}: TreeSearchBarProps) {
  return (
    <div className="cfg-tree__searchbar">
      <HeaderSearch
        variant="fill"
        value={value}
        onChange={onChange}
        ariaLabel={label}
        placeholder={placeholder}
        shortcutDisabled={shortcutDisabled}
      />
      {onCollapseAll && (
        <button
          type="button"
          className="cfg-tree__searchbar-btn"
          aria-label="Collapse whole tree"
          title="Collapse whole tree"
          onClick={onCollapseAll}
        >
          <ArrowsInLineVertical size={13} weight="light" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
