import { createContext, useContext, type ReactNode } from 'react';
import { searchMatchRanges } from '@shared/utils/search';

const TreeSearchQueryContext = createContext('');

export function TreeSearchQueryProvider({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}) {
  return (
    <TreeSearchQueryContext.Provider value={query}>{children}</TreeSearchQueryContext.Provider>
  );
}

export function TreeSearchHighlight({ text }: { text: string }) {
  const query = useContext(TreeSearchQueryContext);
  if (!query) return text;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const range of searchMatchRanges(text, query)) {
    if (range.start > start) parts.push(text.slice(start, range.start));
    parts.push(
      <mark className="cfg-tree-search-match" key={`${range.start}:${range.end}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    start = range.end;
  }

  if (start < text.length) parts.push(text.slice(start));
  return <>{parts}</>;
}
