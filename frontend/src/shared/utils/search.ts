/**
 * Split a user-entered search into case-insensitive words. Repeated whitespace
 * is ignored so callers can pass the input value directly.
 */
export function searchWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

/** Treat dots like whitespace for hierarchical tree searches. */
export function withDotSearchSeparators(query: string): string {
  return query.replace(/\./gu, ' ');
}

/**
 * Match every query word against one combined searchable value. Words may
 * appear in any order and in different fields (for example a parent path and
 * a leaf label).
 */
export function matchesSearchWords(
  query: string,
  searchable: string | readonly (string | null | undefined)[],
): boolean {
  const words = searchWords(query);
  if (words.length === 0) return true;
  const haystack = (Array.isArray(searchable) ? searchable : [searchable])
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

interface SearchMatchRange {
  start: number;
  end: number;
}

/** Find and merge all visible word matches for search-result highlighting. */
export function searchMatchRanges(text: string, query: string): SearchMatchRange[] {
  const normalizedText = text.toLowerCase();
  const ranges: SearchMatchRange[] = [];

  for (const word of new Set(searchWords(query))) {
    let start = 0;
    let matchIndex = normalizedText.indexOf(word, start);
    while (matchIndex !== -1) {
      ranges.push({ start: matchIndex, end: matchIndex + word.length });
      start = matchIndex + word.length;
      matchIndex = normalizedText.indexOf(word, start);
    }
  }

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: SearchMatchRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
