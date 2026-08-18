import { describe, expect, it } from 'vitest';

import { THEME_TOKENS } from '@shared/utils/themeTokens';

import { CONTAINER_DEFAULT_TOKENS } from './containerDefaultTokens';

describe('CONTAINER_DEFAULT_TOKENS', () => {
  // A token missing from the registry resolves to '', so the row shows no
  // placeholder value and its "· default(…)" suffix runs over the action
  // buttons. That is how the renamed --hmi-space-2 survived here unnoticed.
  it('names only tokens the theme actually defines', () => {
    const known = new Set(THEME_TOKENS.map((t) => t.cssVar));
    const unknown = Object.entries(CONTAINER_DEFAULT_TOKENS).filter(
      ([, cssVar]) => !known.has(cssVar),
    );
    expect(unknown).toEqual([]);
  });
});
