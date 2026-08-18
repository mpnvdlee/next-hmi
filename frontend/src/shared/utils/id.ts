/** Ephemeral, non-persisted IDs (request correlation, runtime scopes). */
export const generateId = (): string => crypto.randomUUID();

/** Lowercase kebab slug derived from an arbitrary label. Mirrors backend `core.ids.slugify`. */
export const slugify = (base: string): string =>
  base
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * Unique, human-readable ID derived from `base`. Returns the bare slug when free,
 * otherwise appends the smallest `-N` suffix not already in `taken`.
 * Mirrors backend `core.ids.slug_id`.
 */
export const slugId = (base: string, taken: Iterable<string>): string => {
  const set = taken instanceof Set ? taken : new Set(taken);
  const root = slugify(base) || 'item';
  if (!set.has(root)) return root;
  let n = 1;
  while (set.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
};

/**
 * Derive a unique slug and register it in `taken` in one step. Use when assigning
 * IDs across a tree, where every assignment must be visible to later siblings.
 */
export const takeSlugId = (base: string, taken: Set<string>): string => {
  const id = slugId(base, taken);
  taken.add(id);
  return id;
};
