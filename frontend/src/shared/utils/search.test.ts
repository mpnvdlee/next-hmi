import { describe, expect, it } from 'vitest';
import {
  matchesSearchWords,
  searchMatchRanges,
  searchWords,
  withDotSearchSeparators,
} from './search';

describe('searchWords', () => {
  it('normalizes whitespace and case', () => {
    expect(searchWords('  Motor   SPEED ')).toEqual(['motor', 'speed']);
  });

  it('can treat dots as separators when requested by tree searches', () => {
    expect(searchWords(withDotSearchSeparators('Line.Motor..Speed'))).toEqual([
      'line',
      'motor',
      'speed',
    ]);
  });
});

describe('matchesSearchWords', () => {
  it('matches every word in any order and across searchable fields', () => {
    expect(matchesSearchWords('speed motor', ['Line 1 / Motor', 'Current speed'])).toBe(true);
    expect(matchesSearchWords('motor pressure', ['Line 1 / Motor', 'Current speed'])).toBe(false);
  });

  it('treats an empty query as a match', () => {
    expect(matchesSearchWords('   ', '')).toBe(true);
  });
});

describe('searchMatchRanges', () => {
  it('finds each query word independently', () => {
    expect(searchMatchRanges('Motor speed motor', 'speed motor')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });
});
