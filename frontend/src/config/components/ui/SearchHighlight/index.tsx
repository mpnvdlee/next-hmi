import { createContext, useContext, type ReactNode } from 'react';
import './style.css';
import { searchMatchRanges } from '@shared/utils/search';

const SearchQueryContext = createContext('');

export function SearchHighlightProvider({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}) {
  return <SearchQueryContext.Provider value={query}>{children}</SearchQueryContext.Provider>;
}

export default function SearchHighlight({ text, query }: { text: string; query?: string }) {
  const contextQuery = useContext(SearchQueryContext);
  const search = (query ?? contextQuery).trim();
  if (!search) return text;

  const parts: ReactNode[] = [];
  let start = 0;
  for (const range of searchMatchRanges(text, search)) {
    if (range.start > start) parts.push(text.slice(start, range.start));
    parts.push(
      <mark className="cfg-search-match" key={`${range.start}:${range.end}`}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    start = range.end;
  }

  if (start < text.length) parts.push(text.slice(start));
  return <span className="cfg-search-highlight">{parts}</span>;
}
