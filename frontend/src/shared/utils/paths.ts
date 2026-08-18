export function pathSeparator(p: string): string {
  return p.includes('\\') && !p.includes('/') ? '\\' : '/';
}

export function joinPath(parent: string, folder: string): string {
  if (!parent || !folder) return '';
  const sep = pathSeparator(parent);
  const cleaned = parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return `${cleaned}${sep}${folder}`;
}

export function basename(p: string): string {
  const sep = pathSeparator(p);
  const trimmed = p.endsWith(sep) ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf(sep);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

// Mirrors backend slugify in backend/core/manifest.py — same character class
// so the UI's suggested folder name matches what the server accepts.
export function slugify(name: string): string {
  return name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
