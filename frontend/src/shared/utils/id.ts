/**
 * RFC 4122 v4 UUID.
 *
 * `crypto.randomUUID` exists only in a secure context, so an installation
 * reached over plain HTTP on a LAN address (`http://192.168.x.x:8000`) does not
 * have it. `crypto.getRandomValues` is available in every context, so fall back
 * to that, and to `Math.random` if there is no Web Crypto at all.
 */
export const randomUuid = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Ephemeral, non-persisted IDs (request correlation, runtime scopes). */
export const generateId = (): string => randomUuid();

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
